/**
 * Daemon lifecycle — the process owner around the graph engine. It
 * opens and migrates the SQLite database, registers projects through
 * `WorkflowRegistry`, constructs the `Engine` with production adapters,
 * runs the reconciler heartbeat, answers readiness/liveness queries and
 * shuts down gracefully.
 *
 * Ownership boundaries, deliberately preserved from the extraction:
 *  - the TIMER lives here, never in `Engine` — `reconcile()` stays a
 *    plain async method the daemon calls after startup recovery and on
 *    every heartbeat tick;
 *  - all configuration is explicit (`DaemonConfig`): database path,
 *    project list, heartbeat interval. Nothing is inferred from a home
 *    directory or a hardcoded host;
 *  - every dependency is injectable (`DaemonDeps`); the defaults are the
 *    production adapters (`realProcessRunner`, `systemClock`). A daemon
 *    started without a `SessionClient` reports its runner as unavailable
 *    instead of failing to start — agent dispatch then flows through the
 *    engine's existing step-failure path.
 *
 * Readiness vs liveness: `health().alive` means the daemon object has
 * not stopped or failed; `health().ready` additionally requires the
 * startup sequence to have completed — migrations applied, recovery
 * pass executed, heartbeat armed.
 */

import {
  migrateDatabase,
  openDatabase,
  resolveDatabasePath,
  type DatabaseConnection,
} from "./database.ts"
import { migrations } from "./migrations.ts"
import { Store } from "./store.ts"
import { WorkflowRegistry, type WorkflowDiagnostic, type WorkflowStatus } from "./workflow-registry.ts"
import { loadActionRegistry, type ActionRegistryLoadDiagnostic, type LoadedActionRegistry } from "./action-registry.ts"
import { Engine, type EngineOptions } from "./engine.ts"
import { ActionHost } from "./action-host.ts"
import { bundledHandlers } from "./actions/bundled.ts"
import { realProcessRunner } from "./process.ts"
import { systemClock } from "./ports.ts"
import type { Clock, ProcessRunner, SessionClient } from "./ports.ts"

/** `packages/server/actions` relative to this compiled file's own
 *  directory — never `process.cwd()`, never a home directory. */
const DEFAULT_BUNDLED_ACTIONS_PATH = "../actions"

// ------------------------------------------------------------ structured log

export type DaemonLogLevel = "info" | "warn" | "error"

/**
 * One structured log entry. `fields` carries the correlation identifiers
 * (`project`, `feature`, `step`, `run`) where they apply — never secrets.
 */
export interface DaemonLogEntry {
  readonly level: DaemonLogLevel
  readonly message: string
  readonly fields?: Readonly<Record<string, string | number | boolean | null>>
}

export interface DaemonLogger {
  log(entry: DaemonLogEntry): void
}

/** Default logger: one JSON line per entry on stderr. */
export const jsonLineLogger: DaemonLogger = {
  log(entry) {
    console.error(JSON.stringify({ level: entry.level, message: entry.message, ...(entry.fields ?? {}) }))
  },
}

// ------------------------------------------------------------------- timers

/**
 * Interval scheduling as an injectable port so heartbeat tests can fire
 * ticks deterministically instead of sleeping through real time.
 */
export interface IntervalScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

export const systemIntervalScheduler: IntervalScheduler = {
  setInterval(callback, intervalMs) {
    const handle = setInterval(callback, intervalMs)
    // The heartbeat must never keep an otherwise-finished process alive.
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      ;(handle as { unref(): void }).unref()
    }
    return handle
  },
  clearInterval(handle) {
    clearInterval(handle as Parameters<typeof clearInterval>[0])
  },
}

// ----------------------------------------------------------- configuration

export interface DaemonConfig {
  /** Explicit SQLite database path. Never inferred from a home directory. */
  readonly databasePath: string
  /** Create the database's parent directory if missing. */
  readonly createDatabaseDirectory?: boolean
  /** Project directories to register at startup. Invalid projects get diagnostics, not a failed start. */
  readonly projects: readonly string[]
  /** Reconciler heartbeat interval in milliseconds. */
  readonly heartbeatIntervalMs: number
  /** Engine tuning (runTtlMs, nudgeIdleCycles, maxNudges). Defaults match the seed's operational values. */
  readonly engine?: EngineOptions
  /**
   * Local action registry search paths. `bundledPath` defaults to the
   * bundled `packages/server/actions` directory, resolved relative to this
   * module's own location — never `process.cwd()`, never `$HOME`. A
   * registry load failure is a startup diagnostic, not a fatal error:
   * workflows with `action` steps become invalid, everything else starts.
   */
  readonly actions?: {
    readonly bundledPath?: string
    readonly localPaths?: readonly string[]
  }
}

/** The one thing the daemon needs from a reconciler: one idempotent pass. */
export interface Reconciler {
  reconcile(): Promise<void>
}

export interface DaemonDeps {
  /** Session runner. Absent → the daemon starts and reports the runner unavailable. */
  readonly sessions?: SessionClient
  /**
   * Dynamic runner availability for health reporting. A composition that
   * injects a routing session transport (e.g. the opencode runner hub,
   * which is always constructible but only useful once a runner has
   * registered its endpoint) supplies the live answer here — typically
   * `() => runnerRegistry.hasAny()`. Absent → availability stays the
   * static "was a SessionClient injected" answer.
   */
  readonly runnerAvailability?: () => boolean
  readonly process?: ProcessRunner
  readonly clock?: Clock
  readonly logger?: DaemonLogger
  readonly scheduler?: IntervalScheduler
  readonly notify?: (title: string, message: string) => void
  /** Loaded action registry for resolving workflow `action` steps. Absent → any workflow using `action` steps is invalid. */
  readonly actionRegistry?: LoadedActionRegistry
  /** Reconciler override for lifecycle tests. Defaults to the constructed `Engine`. */
  readonly reconciler?: Reconciler
}

// ------------------------------------------------------------------ health

export type DaemonPhase = "created" | "starting" | "ready" | "failed" | "stopping" | "stopped"

export interface DaemonProjectHealth {
  readonly projectDir: string
  readonly state: WorkflowStatus["state"]
  readonly diagnostics: readonly WorkflowDiagnostic[]
}

export interface DaemonHealth {
  /** Liveness: the daemon object is running (not failed, not stopped). */
  readonly alive: boolean
  /** Readiness: migrations applied, recovery pass executed, heartbeat armed. */
  readonly ready: boolean
  readonly phase: DaemonPhase
  readonly database: {
    readonly path: string
    readonly migrated: boolean
    /** Migration ids applied during THIS startup (empty when already current). */
    readonly appliedNow: readonly string[]
    readonly knownMigrations: number
  }
  readonly heartbeat: {
    readonly intervalMs: number
    readonly running: boolean
    readonly inFlight: boolean
    readonly lastStartedAt: number | null
    readonly lastCompletedAt: number | null
    readonly lastError: string | null
    readonly cycles: number
  }
  readonly projects: readonly DaemonProjectHealth[]
  readonly runner: "available" | "unavailable"
}

// ------------------------------------------------------------------ daemon

/**
 * `SessionClient` used when no runner is injected. Status claims "busy"
 * and existence claims true — the safe direction: in-flight agent runs
 * are never nudged or reaped just because no runner is attached (TTL
 * reaping via the clock still applies). Creating or prompting a session
 * fails loudly, which flows into the engine's normal step-failure path.
 */
function unavailableSessionClient(): SessionClient {
  const unavailable = () => new Error("no session runner registered with the daemon")
  return {
    async createSession() {
      throw unavailable()
    },
    async prompt() {
      throw unavailable()
    },
    async sessionExists() {
      return true
    },
    async status() {
      return "busy"
    },
    async note() {
      throw unavailable()
    },
    async abort() {
      // Nothing to stop when no runner is attached — a no-op success,
      // matching the port contract (abort must never block a reap).
    },
  }
}

export class Daemon {
  private phase: DaemonPhase = "created"
  private connection: DatabaseConnection | null = null
  private storeInstance: Store | null = null
  private registryInstance: WorkflowRegistry | null = null
  private engineInstance: Engine | null = null
  private reconciler: Reconciler | null = null
  private timerHandle: unknown = null
  private cycleInFlight: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private appliedNow: readonly string[] = []
  private lastCycleStartedAt: number | null = null
  private lastCycleCompletedAt: number | null = null
  private lastCycleError: string | null = null
  private cycleCount = 0

  private readonly logger: DaemonLogger
  private readonly scheduler: IntervalScheduler
  private readonly clock: Clock
  private readonly runnerAvailable: () => boolean

  constructor(
    private readonly config: DaemonConfig,
    private readonly deps: DaemonDeps = {},
  ) {
    if (!Number.isFinite(config.heartbeatIntervalMs) || config.heartbeatIntervalMs <= 0) {
      throw new Error("heartbeatIntervalMs must be a positive number")
    }
    resolveDatabasePath({ path: config.databasePath })
    this.logger = deps.logger ?? jsonLineLogger
    this.scheduler = deps.scheduler ?? systemIntervalScheduler
    this.clock = deps.clock ?? systemClock
    this.runnerAvailable = deps.runnerAvailability ?? (() => deps.sessions !== undefined)
  }

  /**
   * Startup sequence: open + migrate the database, register projects
   * (an invalid project logs diagnostics and does not block the rest),
   * construct the engine, run one recovery pass, then arm the
   * heartbeat. Any thrown startup failure — migration or otherwise —
   * closes the connection and fails the start; only a recovery-pass
   * error is non-fatal (logged, retried by the next heartbeat). Not
   * restartable: a stopped or failed daemon is discarded, not restarted
   * in place.
   */
  async start(): Promise<void> {
    if (this.phase !== "created") {
      throw new Error(`daemon cannot start from phase "${this.phase}"`)
    }
    this.phase = "starting"
    this.log("info", "daemon starting", { database: resolveDatabasePath({ path: this.config.databasePath }) })
    try {
      await this.runStartupSequence()
    } catch (error) {
      // ANY startup failure — not just a failed migration — closes the
      // connection and fails the start: a daemon that threw mid-startup
      // must never linger "alive" with a leaked connection and no
      // heartbeat.
      this.phase = "failed"
      this.connection?.close()
      this.connection = null
      this.log("error", `startup failed: ${message(error)}`)
      throw error
    }
  }

  private async runStartupSequence(): Promise<void> {
    const connection = openDatabase({
      path: this.config.databasePath,
      ...(this.config.createDatabaseDirectory !== undefined
        ? { createParentDirectory: this.config.createDatabaseDirectory }
        : {}),
    })
    this.connection = connection
    this.appliedNow = migrateDatabase(connection)
    for (const id of this.appliedNow) this.log("info", "migration applied", { migration: id })
    this.storeInstance = new Store(connection.db)

    const actionRegistry = this.deps.actionRegistry ?? (await this.loadActionRegistry())
    this.registryInstance = new WorkflowRegistry({
      ...(actionRegistry !== undefined ? { actionRegistry } : {}),
    })
    for (const projectDir of this.config.projects) {
      const result = this.registryInstance.register(projectDir)
      if (result.ok) {
        this.log("info", "project registered", {
          project: result.snapshot.projectDir,
          workflow: result.snapshot.workflow.name,
        })
        for (const warning of result.snapshot.warnings) {
          this.log("warn", `workflow warning: ${warning}`, { project: result.snapshot.projectDir })
        }
      } else {
        for (const diagnostic of result.diagnostics) {
          this.log("warn", `workflow invalid: ${diagnostic.message}`, {
            project: projectDir,
            source: diagnostic.sourcePath,
          })
        }
      }
    }

    const processRunner = this.deps.process ?? realProcessRunner
    const engineLogger = { log: (text: string) => this.log("info", text, { component: "engine" }) }
    const actionHost = new ActionHost(bundledHandlers, { process: processRunner, log: engineLogger })
    this.engineInstance = new Engine(
      {
        store: this.storeInstance,
        workflows: this.registryInstance.resolver,
        sessions: this.deps.sessions ?? unavailableSessionClient(),
        process: processRunner,
        clock: this.clock,
        log: engineLogger,
        actions: actionHost,
        runnerAvailable: this.deps.runnerAvailability ?? (() => true),
        ...(this.deps.notify !== undefined ? { notify: this.deps.notify } : {}),
      },
      this.config.engine ?? {},
    )
    this.reconciler = this.deps.reconciler ?? this.engineInstance

    if (!this.runnerAvailable()) this.log("warn", "no session runner registered — runner reported unavailable")

    // Recovery pass before the first heartbeat: pending decisions from
    // the durable outbox are replayed by the same reconcile() the
    // heartbeat drives. Its failure is logged, not fatal — the daemon
    // still becomes ready and the next heartbeat retries.
    await this.runCycle("recovery")

    // A stop() issued while startup was in flight wins: never arm the
    // heartbeat over a connection the stop path is closing.
    if (this.stopPromise) {
      await this.stopPromise
      return
    }

    this.timerHandle = this.scheduler.setInterval(() => {
      void this.beat()
    }, this.config.heartbeatIntervalMs)
    this.phase = "ready"
    this.log("info", "daemon ready", { heartbeatIntervalMs: this.config.heartbeatIntervalMs })
  }

  /**
   * Loads the local action registry (bundled + configured local paths). A
   * load failure logs diagnostics and returns `undefined` — the daemon
   * still starts; every project whose workflow has `action` steps becomes
   * `invalid` at registration instead (the same failure mode as a broken
   * `conductor.yaml`).
   */
  private async loadActionRegistry(): Promise<LoadedActionRegistry | undefined> {
    const bundledPath = this.config.actions?.bundledPath ?? DEFAULT_BUNDLED_ACTIONS_PATH
    const result = await loadActionRegistry({
      baseDir: import.meta.dirname,
      bundledPath,
      ...(this.config.actions?.localPaths !== undefined ? { localPaths: this.config.actions.localPaths } : {}),
    })
    if (result.ok) {
      this.log("info", "action registry loaded", { actions: Object.keys(result.value.registry).length })
      return result.value
    }
    for (const diagnostic of result.diagnostics) this.logActionRegistryDiagnostic(diagnostic)
    // The default bundled path resolves relative to this module — inside
    // a compiled binary that directory does not exist on disk. Point the
    // operator at the config field that restores it instead of leaving
    // only a generic diagnostic.
    if (this.config.actions?.bundledPath === undefined) {
      this.log(
        "warn",
        "bundled action manifests are unavailable — workflows using \"action:\" steps will be invalid; " +
          "set actions.bundledPath in the daemon config to a directory containing the manifests " +
          "(e.g. a checkout's packages/server/actions) to restore them",
      )
    }
    return undefined
  }

  private logActionRegistryDiagnostic(diagnostic: ActionRegistryLoadDiagnostic): void {
    this.log("warn", `action registry invalid: ${diagnostic.message}`, { source: diagnostic.sourcePath })
  }

  /**
   * One heartbeat tick. Skips (returning the in-flight promise) when a
   * previous cycle is still running — cycles never overlap. Public so
   * tests and the future API can trigger a cycle deterministically.
   */
  beat(): Promise<void> {
    if (this.phase !== "ready") return Promise.resolve()
    if (this.cycleInFlight) return this.cycleInFlight
    return this.runCycle("heartbeat")
  }

  private runCycle(kind: "recovery" | "heartbeat"): Promise<void> {
    const reconciler = this.reconciler
    if (!reconciler) return Promise.resolve()
    this.lastCycleStartedAt = this.clock.now()
    const cycle = (async () => {
      try {
        await reconciler.reconcile()
        this.lastCycleError = null
      } catch (error) {
        // A failed cycle is logged and recorded, never fatal: the next
        // heartbeat runs regardless.
        this.lastCycleError = message(error)
        this.log("error", `${kind} reconcile failed: ${this.lastCycleError}`)
      } finally {
        this.lastCycleCompletedAt = this.clock.now()
        this.cycleCount += 1
        this.cycleInFlight = null
      }
    })()
    this.cycleInFlight = cycle
    return cycle
  }

  /**
   * Graceful shutdown: stop the heartbeat timer, wait for an in-flight
   * reconcile cycle to finish, close the database. Idempotent — repeated
   * calls share one promise. Active runs stay recoverable: everything
   * durable is already in SQLite before this returns.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = (async () => {
      const from = this.phase
      if (from === "stopped") return
      this.phase = "stopping"
      if (this.timerHandle !== null) {
        this.scheduler.clearInterval(this.timerHandle)
        this.timerHandle = null
      }
      if (this.cycleInFlight) await this.cycleInFlight
      // Drain detached action executions before closing SQLite: their
      // conclusion writes must land while the connection is still open.
      await this.engineInstance?.settleActions()
      this.connection?.close()
      this.connection = null
      this.phase = "stopped"
      this.log("info", "daemon stopped")
    })()
    return this.stopPromise
  }

  /**
   * Liveness/readiness query. The HTTP API serves this verbatim; nothing
   * here touches the network.
   */
  health(): DaemonHealth {
    return {
      alive: this.phase === "starting" || this.phase === "ready",
      ready: this.phase === "ready",
      phase: this.phase,
      database: {
        path: resolveDatabasePath({ path: this.config.databasePath }),
        migrated: this.storeInstance !== null,
        appliedNow: this.appliedNow,
        knownMigrations: migrations.length,
      },
      heartbeat: {
        intervalMs: this.config.heartbeatIntervalMs,
        running: this.timerHandle !== null,
        inFlight: this.cycleInFlight !== null,
        lastStartedAt: this.lastCycleStartedAt,
        lastCompletedAt: this.lastCycleCompletedAt,
        lastError: this.lastCycleError,
        cycles: this.cycleCount,
      },
      projects: (this.registryInstance?.list() ?? []).map(entry => ({
        projectDir: entry.projectDir,
        state: entry.status.state,
        diagnostics:
          entry.status.state === "stale" || entry.status.state === "invalid" ? entry.status.diagnostics : [],
      })),
      runner: this.runnerAvailable() ? "available" : "unavailable",
    }
  }

  /** The daemon's store — available once `start()` has opened the database. */
  get store(): Store {
    if (!this.storeInstance) throw new Error("daemon has not started")
    return this.storeInstance
  }

  /** The daemon's engine — available once `start()` has constructed it. */
  get engine(): Engine {
    if (!this.engineInstance) throw new Error("daemon has not started")
    return this.engineInstance
  }

  /** The daemon's workflow registry — available once `start()` has constructed it. */
  get registry(): WorkflowRegistry {
    if (!this.registryInstance) throw new Error("daemon has not started")
    return this.registryInstance
  }

  private log(level: DaemonLogLevel, text: string, fields?: DaemonLogEntry["fields"]): void {
    this.logger.log({ level, message: text, ...(fields !== undefined ? { fields } : {}) })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
