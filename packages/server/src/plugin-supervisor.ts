/**
 * Plugin backend supervisor — spawns, restarts and reaps the child
 * processes for enabled plugins whose manifest declares `backend`
 * (design D2, plugin-runtime spec "Backend lifecycle is supervised with
 * patience"). A static-only plugin (no `backend`) needs no process: its
 * state is reported "running" for listing purposes whenever it is
 * enabled, since it is always immediately servable from its `ui/`
 * directory — there is no process lifecycle to reflect, and reporting
 * "stopped" would read as a false failure signal in the panel rail.
 *
 * Restart policy borrows the retry-policy philosophy (exponential
 * backoff, a cap, a finite attempt budget) but keeps its own local
 * constants — this is daemon-internal supervision, not a workflow-
 * authored retry policy, and jitter is deliberately "none": the
 * sequence must be exactly reproducible for tests asserting it
 * lengthens to the cap. Budget exhaustion parks the plugin in `error`
 * with a diagnostic (last exit code/signal, a cheap stderr tail) rather
 * than retrying forever or crashing the daemon.
 *
 * All I/O crosses injected ports (`PluginProcessSpawner`, `PortAllocator`,
 * `Logger`, an injectable `sleep` for backoff/grace waits) — unit tests
 * drive the restart and shutdown timelines without a real timer by
 * controlling when `sleep` and `handle.exited` resolve.
 */

import { baseDelayMs } from "@conductor/core"
import type { BackoffDef } from "@conductor/core"
import { realSleep } from "./action-host.ts"
import type { Logger, PluginProcessExit, PluginProcessHandle, PluginProcessSpawner, PortAllocator } from "./ports.ts"
import type { DiscoveredPlugin, PluginDiagnostic, PluginState, PluginStateKey, PluginStateLookup } from "./plugin-registry.ts"

/** Total attempts including the first — matches `RetryBudget.maxAttempts`'s convention. */
const MAX_RESTART_ATTEMPTS = 5
const RESTART_BACKOFF: BackoffDef = { strategy: "exponential", initial: 1_000, multiplier: 2, max: 60_000, jitter: "none" }
const SHUTDOWN_GRACE_MS = 5_000

export interface PluginSupervisorConfig {
  /** The daemon's own base URL, passed to backends as `CONDUCTOR_URL`. */
  readonly conductorUrl: string
  /** The daemon's API token, passed as `CONDUCTOR_TOKEN`. Absent when auth is "none". */
  readonly conductorToken?: string
}

export interface PluginSupervisorDeps {
  readonly spawner: PluginProcessSpawner
  readonly ports: PortAllocator
  readonly log: Logger
  /** Injectable delay for backoff/shutdown-grace waits. Real `setTimeout` by
   *  default; tests inject a controllable fake (mirrors `ActionHostDeps.sleep`). */
  readonly sleep?: (ms: number) => Promise<void>
}

interface SupervisedEntry {
  readonly key: PluginStateKey
  readonly plugin: DiscoveredPlugin
  state: PluginState
  port: number | null
  diagnostic: PluginDiagnostic | null
  handle: PluginProcessHandle | null
  /** Set by `stop()` (or a future per-plugin stop) so a supervise loop
   *  mid-backoff or mid-spawn knows not to restart even if it wakes. */
  stopping: boolean
  /** Bumped by `stop()` to invalidate any in-flight loop iteration for
   *  this entry — a stale iteration checks its captured generation. */
  generation: number
  attempt: number
}

function stringKey(key: PluginStateKey): string {
  return `${key.scope}:${key.projectId ?? ""}:${key.id}`
}

function keyFor(plugin: DiscoveredPlugin): PluginStateKey {
  return { scope: plugin.scope, id: plugin.id, ...(plugin.projectId !== undefined ? { projectId: plugin.projectId } : {}) }
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n").map(line => line.trim()).filter(line => line !== "")
  return lines[lines.length - 1] ?? ""
}

function exhaustedMessage(id: string, attempts: number, exit: PluginProcessExit, stderrTail: string): string {
  const exitDesc = exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`
  const tail = lastNonEmptyLine(stderrTail)
  return `plugin "${id}" backend crashed ${attempts} time(s) (last: ${exitDesc}); restart budget exhausted`
    + (tail === "" ? "" : ` — recent stderr: ${tail}`)
}

/**
 * Supervises plugin backend processes. `start()` awaits the FIRST spawn
 * attempt of every enabled backend plugin (so its env contract is
 * observable immediately after the call resolves) then hands each off
 * to a background loop that restarts on unexpected exit. `stop()`
 * signals every live child (SIGTERM), waits up to the grace period, and
 * force-kills anything still alive.
 */
export class PluginSupervisor {
  private readonly entries = new Map<string, SupervisedEntry>()
  private readonly listeners = new Set<(key: PluginStateKey) => void>()
  private readonly sleep: (ms: number) => Promise<void>
  private stopped = false

  constructor(
    private readonly deps: PluginSupervisorDeps,
    private readonly config: PluginSupervisorConfig,
  ) {
    this.sleep = deps.sleep ?? realSleep
  }

  /**
   * Starts supervision for every plugin in `plugins` that is not in
   * `disabled` and declares a `backend`. Static-only plugins get an
   * entry with no process, reported "running" immediately. Disabled
   * plugins get no entry at all — `stateOf` returns `undefined` for
   * them and the registry's own disabled precedence wins regardless.
   */
  async start(plugins: readonly DiscoveredPlugin[], options?: { readonly disabled?: ReadonlySet<string> }): Promise<void> {
    const disabled = options?.disabled ?? new Set<string>()
    const launches: Promise<void>[] = []
    for (const plugin of plugins) {
      if (disabled.has(plugin.id)) continue
      const key = keyFor(plugin)
      if (plugin.manifest.backend === undefined) {
        this.entries.set(stringKey(key), {
          key, plugin, state: "running", port: null, diagnostic: null, handle: null, stopping: false, generation: 0, attempt: 0,
        })
        continue
      }
      const entry: SupervisedEntry = {
        key, plugin, state: "stopped", port: null, diagnostic: null, handle: null, stopping: false, generation: 0, attempt: 0,
      }
      this.entries.set(stringKey(key), entry)
      launches.push(this.launch(entry))
    }
    await Promise.all(launches)
  }

  private async launch(entry: SupervisedEntry): Promise<void> {
    await this.spawnOnce(entry)
    // Fire-and-forget: `start()` must resolve once the FIRST spawn is
    // observable, not wait for the plugin's entire restart lifetime. A
    // rejection here (e.g. `ports.allocate()` throwing during a later
    // restart's `spawnOnce`) must never become an unhandled rejection —
    // it parks the entry as `error` with a diagnostic and a
    // state-change notification, exactly like budget exhaustion, rather
    // than crashing the process on an unrelated async error.
    this.supervise(entry, entry.generation).catch(error => {
      entry.state = "error"
      entry.handle = null
      entry.diagnostic = {
        path: entry.plugin.dir,
        message: `plugin "${entry.plugin.id}" supervision loop failed unexpectedly: ${errorMessage(error)}`,
      }
      this.deps.log.log(`plugin "${entry.plugin.id}" supervision loop failed: ${errorMessage(error)}`)
      this.notify(entry.key)
    })
  }

  private async spawnOnce(entry: SupervisedEntry): Promise<void> {
    entry.attempt += 1
    const port = await this.deps.ports.allocate()
    entry.port = port
    const handle = this.deps.spawner.spawn(entry.plugin.manifest.backend!.run, {
      cwd: entry.plugin.dir,
      env: this.envFor(entry.plugin, port),
    })
    entry.handle = handle
    entry.state = "running"
    entry.diagnostic = null
    this.notify(entry.key)
  }

  private envFor(plugin: DiscoveredPlugin, port: number): Record<string, string> {
    const env: Record<string, string> = {
      CONDUCTOR_PLUGIN_PORT: String(port),
      CONDUCTOR_URL: this.config.conductorUrl,
    }
    if (this.config.conductorToken !== undefined) env.CONDUCTOR_TOKEN = this.config.conductorToken
    if (plugin.scope === "project" && plugin.projectRoot !== undefined) env.CONDUCTOR_PROJECT_DIR = plugin.projectRoot
    return env
  }

  private async supervise(entry: SupervisedEntry, generation: number): Promise<void> {
    for (;;) {
      const handle = entry.handle
      if (handle === null) return
      const exit = await handle.exited
      if (this.stopped || entry.stopping || entry.generation !== generation) {
        entry.state = "stopped"
        entry.handle = null
        this.notify(entry.key)
        return
      }

      if (entry.attempt >= MAX_RESTART_ATTEMPTS) {
        entry.state = "error"
        entry.handle = null
        entry.diagnostic = {
          path: entry.plugin.dir,
          message: exhaustedMessage(entry.plugin.id, entry.attempt, exit, handle.recentStderr()),
        }
        this.deps.log.log(`plugin "${entry.plugin.id}" restart budget exhausted: ${entry.diagnostic.message}`)
        this.notify(entry.key)
        return
      }

      entry.state = "stopped"
      entry.handle = null
      this.notify(entry.key)

      const delayMs = baseDelayMs(RESTART_BACKOFF, entry.attempt)
      this.deps.log.log(`plugin "${entry.plugin.id}" backend exited unexpectedly — restarting in ${delayMs}ms (attempt ${entry.attempt + 1}/${MAX_RESTART_ATTEMPTS})`)
      await this.sleep(delayMs)
      if (this.stopped || entry.stopping || entry.generation !== generation) {
        entry.state = "stopped"
        return
      }
      await this.spawnOnce(entry)
    }
  }

  /** Signals every live child (SIGTERM), waits up to the grace period,
   *  force-kills anything still alive. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const waits: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      entry.stopping = true
      entry.generation += 1
      if (entry.handle !== null) waits.push(this.gracefulKill(entry))
    }
    await Promise.all(waits)
  }

  private async gracefulKill(entry: SupervisedEntry): Promise<void> {
    const handle = entry.handle
    if (handle === null) return
    handle.signal("SIGTERM")
    let timedOut = false
    const timeout = this.sleep(SHUTDOWN_GRACE_MS).then(() => {
      timedOut = true
    })
    await Promise.race([handle.exited.then(() => {}), timeout])
    if (timedOut) handle.signal("SIGKILL")
    await handle.exited
    entry.state = "stopped"
    entry.handle = null
  }

  /** `PluginStateLookup`-compatible: `undefined` for a plugin the
   *  supervisor never started (unknown, or filtered as disabled). */
  readonly stateOf: PluginStateLookup = (key: PluginStateKey): PluginState | undefined => {
    return this.entries.get(stringKey(key))?.state
  }

  /** The plugin's current loopback port, or `null` when it has no
   *  backend or no process is currently alive. */
  portOf(key: PluginStateKey): number | null {
    return this.entries.get(stringKey(key))?.port ?? null
  }

  /** The runtime diagnostic (crash/exhaustion detail) for a plugin
   *  currently in `error` state; `null` otherwise. */
  diagnosticOf(key: PluginStateKey): PluginDiagnostic | null {
    return this.entries.get(stringKey(key))?.diagnostic ?? null
  }

  /** Subscribe to state changes (spawn, exit, restart, exhaustion,
   *  shutdown). Returns an unsubscribe function. */
  onStateChange(callback: (key: PluginStateKey) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  private notify(key: PluginStateKey): void {
    for (const callback of this.listeners) callback(key)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
