import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon, type DaemonDeps, type DaemonLogEntry, type IntervalScheduler } from "./src/daemon.ts"
import { openMigratedDatabase } from "./src/database.ts"
import { migrations } from "./src/migrations.ts"
import { Store } from "./src/store.ts"
import { interpret } from "./src/engine/interpret.ts"
import type { PipelineDef } from "./src/engine/types.ts"
import type { SessionClient } from "./src/engine/ports.ts"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Deterministic heartbeat: tests fire ticks explicitly, no real timers. */
class ManualScheduler implements IntervalScheduler {
  callback: (() => void) | null = null
  intervalMs: number | null = null
  cleared = 0
  setInterval(callback: () => void, intervalMs: number): unknown {
    this.callback = callback
    this.intervalMs = intervalMs
    return { manual: true }
  }
  clearInterval(): void {
    this.cleared += 1
    this.callback = null
  }
  tick(): void {
    this.callback?.()
  }
}

class CollectingLogger {
  entries: DaemonLogEntry[] = []
  log(entry: DaemonLogEntry): void {
    this.entries.push(entry)
  }
  messages(): string[] {
    return this.entries.map(entry => entry.message)
  }
}

class FakeSessions implements SessionClient {
  prompts: Array<{ sessionID: string; text: string }> = []
  private counter = 0
  async createSession(): Promise<{ id: string }> {
    return { id: `ses-${++this.counter}` }
  }
  async prompt(input: { sessionID: string; text: string }): Promise<void> {
    this.prompts.push(input)
  }
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(): Promise<"busy" | "idle" | "retry" | "missing"> {
    return "busy"
  }
  async note(): Promise<void> {}
}

const temporaryDirectories: string[] = []
const daemonsToStop: Daemon[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(async () => {
  for (const daemon of daemonsToStop.splice(0)) await daemon.stop()
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const minimalConfig = {
  roles: { implementer: { agent: "build" } },
  pipeline: [{ id: "implement", type: "agent", role: "implementer" }],
}

function writeProject(config: unknown = minimalConfig): string {
  const project = tempDir("conductor-daemon-project-")
  const configDir = join(project, ".opencode")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "conductor.json"), JSON.stringify(config))
  return project
}

function makeDaemon(input: {
  projects?: readonly string[]
  databasePath?: string
  deps?: DaemonDeps
  heartbeatIntervalMs?: number
}): { daemon: Daemon; scheduler: ManualScheduler; logger: CollectingLogger; databasePath: string } {
  const scheduler = new ManualScheduler()
  const logger = new CollectingLogger()
  const databasePath = input.databasePath ?? join(tempDir("conductor-daemon-db-"), "state.db")
  const daemon = new Daemon(
    {
      databasePath,
      projects: input.projects ?? [],
      heartbeatIntervalMs: input.heartbeatIntervalMs ?? 1000,
    },
    { scheduler, logger, sessions: new FakeSessions(), ...input.deps },
  )
  daemonsToStop.push(daemon)
  return { daemon, scheduler, logger, databasePath }
}

describe("Daemon: startup", () => {
  it("starts with a mix of valid and invalid projects — invalid ones get diagnostics, valid ones register", async () => {
    const valid = writeProject()
    const invalid = writeProject({ pipeline: "not-an-array" })
    const { daemon, logger } = makeDaemon({ projects: [valid, invalid] })

    await daemon.start()

    const health = daemon.health()
    expect(health.ready).toBe(true)
    expect(health.projects).toHaveLength(2)
    const states = new Map(health.projects.map(p => [p.projectDir, p]))
    const validEntry = [...states.values()].find(p => p.state === "valid")
    const invalidEntry = [...states.values()].find(p => p.state === "invalid")
    expect(validEntry).toBeDefined()
    expect(invalidEntry).toBeDefined()
    expect(invalidEntry!.diagnostics.length).toBeGreaterThan(0)
    expect(logger.messages().some(m => m.includes("project config invalid"))).toBe(true)
    expect(logger.messages().some(m => m === "daemon ready")).toBe(true)
  })

  it("applies migrations on a fresh database and reports them in health", async () => {
    const { daemon } = makeDaemon({})
    await daemon.start()
    const health = daemon.health()
    expect(health.database.migrated).toBe(true)
    expect(health.database.appliedNow).toEqual(migrations.map(m => m.id))
    expect(health.database.knownMigrations).toBe(migrations.length)
  })

  it("fails startup when a migration fails, closing the database", async () => {
    const databasePath = join(tempDir("conductor-daemon-badmig-"), "state.db")
    // Seed a ledger that is NOT a prefix of the compiled migration list —
    // runMigrations refuses to guess and throws.
    const connection = openMigratedDatabase({ path: databasePath })
    connection.db.run("UPDATE schema_migration SET id = 'unknown_migration' WHERE position = 0")
    connection.close()

    const { daemon } = makeDaemon({ databasePath })
    await expect(daemon.start()).rejects.toThrow(/migration ledger/)
    const health = daemon.health()
    expect(health.alive).toBe(false)
    expect(health.ready).toBe(false)
    expect(health.phase).toBe("failed")
  })

  it("start is not re-entrant: a second start() rejects", async () => {
    const { daemon } = makeDaemon({})
    await daemon.start()
    await expect(daemon.start()).rejects.toThrow(/cannot start/)
  })

  it("rejects a non-positive heartbeat interval at construction", () => {
    expect(
      () =>
        new Daemon({
          databasePath: join(tempDir("conductor-daemon-cfg-"), "state.db"),
          projects: [],
          heartbeatIntervalMs: 0,
        }),
    ).toThrow(/positive/)
  })

  it("starts without a session runner and reports it unavailable", async () => {
    const scheduler = new ManualScheduler()
    const logger = new CollectingLogger()
    const daemon = new Daemon(
      {
        databasePath: join(tempDir("conductor-daemon-norunner-"), "state.db"),
        projects: [],
        heartbeatIntervalMs: 1000,
      },
      { scheduler, logger },
    )
    daemonsToStop.push(daemon)
    await daemon.start()
    expect(daemon.health().ready).toBe(true)
    expect(daemon.health().runner).toBe("unavailable")
    expect(logger.messages().some(m => m.includes("no session runner"))).toBe(true)
  })
})

describe("Daemon: readiness and liveness", () => {
  it("is not ready before start and becomes ready after", async () => {
    const { daemon } = makeDaemon({})
    expect(daemon.health().ready).toBe(false)
    expect(daemon.health().phase).toBe("created")
    await daemon.start()
    expect(daemon.health().ready).toBe(true)
    expect(daemon.health().alive).toBe(true)
    expect(daemon.health().heartbeat.running).toBe(true)
  })

  it("reports heartbeat progress in health", async () => {
    const { daemon, scheduler } = makeDaemon({})
    await daemon.start()
    const afterStart = daemon.health()
    expect(afterStart.heartbeat.cycles).toBe(1) // the recovery pass
    scheduler.tick()
    await daemon.beat()
    const after = daemon.health()
    expect(after.heartbeat.cycles).toBeGreaterThanOrEqual(2)
    expect(after.heartbeat.lastCompletedAt).not.toBeNull()
    expect(after.heartbeat.lastError).toBeNull()
  })

  it("is neither alive nor ready after stop", async () => {
    const { daemon } = makeDaemon({})
    await daemon.start()
    await daemon.stop()
    const health = daemon.health()
    expect(health.alive).toBe(false)
    expect(health.ready).toBe(false)
    expect(health.phase).toBe("stopped")
  })
})

describe("Daemon: reconciler heartbeat", () => {
  it("runs a recovery pass before the first heartbeat tick", async () => {
    const calls: string[] = []
    const { daemon, scheduler } = makeDaemon({
      deps: {
        reconciler: {
          async reconcile() {
            calls.push("reconcile")
          },
        },
      },
    })
    await daemon.start()
    expect(calls).toEqual(["reconcile"]) // recovery, before any tick
    scheduler.tick()
    await daemon.beat()
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it("heartbeat ticks call reconcile repeatedly", async () => {
    let count = 0
    const { daemon, scheduler } = makeDaemon({
      heartbeatIntervalMs: 42,
      deps: {
        reconciler: {
          async reconcile() {
            count += 1
          },
        },
      },
    })
    await daemon.start()
    expect(scheduler.intervalMs).toBe(42)
    const afterRecovery = count
    scheduler.tick()
    await daemon.beat()
    scheduler.tick()
    await daemon.beat()
    expect(count).toBeGreaterThanOrEqual(afterRecovery + 2)
  })

  it("does not overlap cycles when reconcile is slow", async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    const gate = deferred<void>()
    const { daemon, scheduler } = makeDaemon({
      deps: {
        reconciler: {
          async reconcile() {
            calls += 1
            if (calls === 1) return // fast recovery pass
            active += 1
            maxActive = Math.max(maxActive, active)
            await gate.promise
            active -= 1
          },
        },
      },
    })
    await daemon.start()

    scheduler.tick() // starts the slow cycle
    expect(daemon.health().heartbeat.inFlight).toBe(true)
    scheduler.tick() // must NOT start a second one
    scheduler.tick()
    expect(maxActive).toBeLessThanOrEqual(1)
    expect(calls).toBe(2)

    gate.resolve()
    await daemon.beat() // returns the in-flight (now resolving) promise
    expect(daemon.health().heartbeat.inFlight).toBe(false)
    expect(maxActive).toBe(1)
  })

  it("a failing reconcile cycle is logged and does not stop subsequent cycles", async () => {
    let calls = 0
    const { daemon, scheduler, logger } = makeDaemon({
      deps: {
        reconciler: {
          async reconcile() {
            calls += 1
            if (calls === 2) throw new Error("boom cycle")
          },
        },
      },
    })
    await daemon.start()
    scheduler.tick()
    await daemon.beat()
    expect(daemon.health().heartbeat.lastError).toBe("boom cycle")
    expect(logger.messages().some(m => m.includes("boom cycle"))).toBe(true)

    scheduler.tick()
    await daemon.beat()
    expect(calls).toBe(3)
    expect(daemon.health().heartbeat.lastError).toBeNull()
    expect(daemon.health().ready).toBe(true)
  })

  it("beat() after stop is a no-op", async () => {
    let calls = 0
    const { daemon } = makeDaemon({
      deps: {
        reconciler: {
          async reconcile() {
            calls += 1
          },
        },
      },
    })
    await daemon.start()
    await daemon.stop()
    const before = calls
    await daemon.beat()
    expect(calls).toBe(before)
  })
})

describe("Daemon: recovery pass drives the durable action outbox", () => {
  it("replays a pending completion decision from a previous process before the first heartbeat", async () => {
    const reviewPipeline = [
      {
        id: "review",
        type: "agent",
        role: "reviewer",
        rounds_with: "review",
        max_rounds: 3,
        on_verdict: { approved: { next: true }, changes_requested: { goto: "review" } },
      },
    ]
    const project = writeProject({ roles: { reviewer: { agent: "review-agent" } }, pipeline: reviewPipeline })
    const databasePath = join(tempDir("conductor-daemon-outbox-"), "state.db")

    // First process: conclude a run with a persisted decision but crash
    // before acting on it (never markRunActionHandled).
    {
      const connection = openMigratedDatabase({ path: databasePath })
      const store = new Store(connection.db)
      const def: PipelineDef = {
        roles: { reviewer: { agent: "review-agent" } },
        pipeline: reviewPipeline as PipelineDef["pipeline"],
      }
      const feature = store.createFeature({ title: "F", slug: "f", projectDir: project })
      const started = store.getFeature(feature.id)!
      store.applyTransition(feature.id, { kind: "feature.start" }, interpret(def, started, { kind: "feature.start" }))
      expect(store.getFeature(feature.id)?.currentStep).toBe("review")
      const runId = store.startRun({ featureId: feature.id, stepId: "review", stepType: "agent", attempt: 1, role: "reviewer" })
      const state = store.getFeature(feature.id)!
      const event = { kind: "step.verdict", stepId: "review", verdict: "changes_requested" } as const
      const transition = interpret(def, state, event)
      expect(store.concludeRun(runId, "succeeded", { output: "changes requested" }, event, transition)).toBe(true)
      expect(store.getPendingRunAction(feature.id)).not.toBeNull()
      connection.close()
    }

    const sessions = new FakeSessions()
    const { daemon } = makeDaemon({ projects: [project], databasePath, deps: { sessions } })
    await daemon.start()

    // The recovery pass (before any heartbeat tick) replayed the pending
    // "execute review" decision: the outbox is drained and a fresh run
    // was dispatched for the retry round.
    const features = daemon.store.listFeatures()
    expect(features).toHaveLength(1)
    const feature = features[0]!
    expect(daemon.store.getPendingRunAction(feature.id)).toBeNull()
    expect(daemon.store.getActiveRun(feature.id)?.stepId).toBe("review")
    expect(sessions.prompts.length).toBeGreaterThanOrEqual(1)
  })
})

describe("Daemon: graceful shutdown", () => {
  it("stops the timer, waits for the in-flight cycle, then closes the database", async () => {
    const order: string[] = []
    const gate = deferred<void>()
    let calls = 0
    const { daemon, scheduler } = makeDaemon({
      deps: {
        reconciler: {
          async reconcile() {
            calls += 1
            if (calls === 1) return
            order.push("cycle-start")
            await gate.promise
            order.push("cycle-end")
          },
        },
      },
    })
    await daemon.start()
    scheduler.tick()
    expect(daemon.health().heartbeat.inFlight).toBe(true)

    const stopping = daemon.stop()
    order.push("stop-called")
    gate.resolve()
    await stopping
    order.push("stopped")

    expect(order).toEqual(["cycle-start", "stop-called", "cycle-end", "stopped"])
    expect(scheduler.cleared).toBe(1)
    expect(daemon.health().phase).toBe("stopped")
  })

  it("double stop() is safe and shares one promise", async () => {
    const { daemon, scheduler } = makeDaemon({})
    await daemon.start()
    const first = daemon.stop()
    const second = daemon.stop()
    expect(second).toBe(first)
    await first
    await daemon.stop()
    expect(scheduler.cleared).toBe(1)
    expect(daemon.health().phase).toBe("stopped")
  })

  it("stop() before start() resolves without error", async () => {
    const { daemon } = makeDaemon({})
    await daemon.stop()
    expect(daemon.health().phase).toBe("stopped")
  })

  it("stop() during the startup recovery pass wins — the heartbeat is never armed", async () => {
    const gate = deferred<void>()
    const { daemon, scheduler } = makeDaemon({
      deps: {
        reconciler: {
          async reconcile() {
            await gate.promise
          },
        },
      },
    })
    const starting = daemon.start()
    const stopping = daemon.stop()
    gate.resolve()
    await starting
    await stopping
    expect(daemon.health().phase).toBe("stopped")
    expect(daemon.health().heartbeat.running).toBe(false)
    expect(scheduler.callback).toBeNull()
  })

  it("a shutdown mid-cycle leaves state recoverable: a second daemon on the same database resumes", async () => {
    const project = writeProject()
    const databasePath = join(tempDir("conductor-daemon-restart-"), "state.db")

    const first = makeDaemon({ projects: [project], databasePath })
    await first.daemon.start()
    const feature = first.daemon.store.createFeature({ title: "F", slug: "f", projectDir: project })
    await first.daemon.engine.dispatch(feature.id, { kind: "feature.start" })
    const beforeStop = first.daemon.store.getFeature(feature.id)
    expect(beforeStop?.currentStep).toBe("implement")
    await first.daemon.stop()

    const second = makeDaemon({ projects: [project], databasePath })
    await second.daemon.start()
    const recovered = second.daemon.store.getFeature(feature.id)
    expect(recovered?.currentStep).toBe("implement")
    expect(recovered?.status).toBe(beforeStop?.status)
    expect(second.daemon.health().database.appliedNow).toEqual([]) // already migrated
    expect(second.daemon.health().ready).toBe(true)
  })
})

describe("Daemon: structured logs", () => {
  it("project registration logs carry the project field and never config contents", async () => {
    const secretToken = "shhh-token-value"
    const project = writeProject({
      ...minimalConfig,
      reviewPublish: { mode: "github-review", tokenCommand: `echo ${secretToken}` },
    })
    const { daemon, logger } = makeDaemon({ projects: [project] })
    await daemon.start()
    const registered = logger.entries.find(e => e.message === "project registered")
    expect(registered).toBeDefined()
    expect(String(registered!.fields?.project)).toContain("conductor-daemon-project-")
    for (const entry of logger.entries) {
      expect(JSON.stringify(entry)).not.toContain(secretToken)
    }
  })

  it("engine log lines are forwarded through the daemon logger with the engine component field", async () => {
    const project = writeProject()
    const { daemon, logger } = makeDaemon({ projects: [project] })
    await daemon.start()
    const feature = daemon.store.createFeature({ title: "F", slug: "f", projectDir: project })
    await daemon.engine.dispatch(feature.id, { kind: "feature.start" })
    const engineEntry = logger.entries.find(e => e.fields?.component === "engine")
    expect(engineEntry).toBeDefined()
    expect(engineEntry!.message).toContain("feature=f")
  })
})
