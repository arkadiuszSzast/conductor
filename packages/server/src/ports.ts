/**
 * Explicit dependency interfaces for the graph engine.
 *
 * Nothing in the engine reaches for an opencode SDK import, a
 * process-wide global, `Date.now()`, `process.cwd()`, or a hardcoded
 * model gateway — every side effect crosses one of these ports,
 * injected by the caller (daemon wiring or tests).
 */

// --------------------------------------------------------------- clock

/** Recovers `Date.now()` as an injectable port — deterministic in tests. */
export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

// -------------------------------------------------------------- logger

export interface Logger {
  log(message: string): void
}

// ------------------------------------------------------------ process

export interface ProcessExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /**
   * stdout and stderr chronologically interleaved as the child emitted
   * them (a single capture buffer). Command-step failure output must
   * preserve arrival order — concatenating `stdout` then `stderr` would
   * silently reorder interleaved output.
   */
  readonly output: string
}

export interface ProcessExecOptions {
  readonly cwd: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  /** Piped to the child's stdin, then closed. Avoids shell heredoc construction for untrusted content. */
  readonly stdin?: string
}

/**
 * Runtime-neutral process/filesystem execution effect. `command` steps
 * run through this port — never a global `runShell`, never a bare
 * `spawn`, never `process.cwd()` as an implicit default.
 */
export interface ProcessRunner {
  exec(command: readonly string[], options: ProcessExecOptions): Promise<ProcessExecResult>
  /** Run a shell command line (bash -lc) — used by `command` workflow steps. */
  shell(command: string, options: ProcessExecOptions): Promise<ProcessExecResult>
}

// ------------------------------------------------------- long-running process

/** Allocates an ephemeral loopback TCP port for a plugin backend — bind
 *  port 0, read back, release, so the daemon never configures a port. */
export interface PortAllocator {
  allocate(): Promise<number>
}

export interface PluginProcessSpawnOptions {
  readonly cwd: string
  /**
   * The EXACT environment the child receives — no ambient merge happens
   * here; the caller decides what crosses (e.g. the supervisor passes
   * only its `CONDUCTOR_*` contract, and the real spawner adds a small
   * PATH/HOME-style passthrough on top, never the daemon's whole env).
   */
  readonly env: Readonly<Record<string, string>>
}

export interface PluginProcessExit {
  readonly code: number | null
  readonly signal: string | null
}

/** A supervised long-running child process — distinct from `ProcessRunner`,
 *  whose `exec`/`shell` run to completion. A plugin backend is a server
 *  the supervisor starts, signals, and outlives across restarts. */
export interface PluginProcessHandle {
  /** Sends `name` (default `SIGTERM`) to the child. A no-op once exited. */
  signal(name?: NodeJS.Signals): void
  /** Resolves exactly once, when the child has exited. */
  readonly exited: Promise<PluginProcessExit>
  /** Bounded recent stderr output — a cheap crash diagnostic, not a log. */
  recentStderr(): string
}

/**
 * Spawns a long-running child process. `command` steps and plugin
 * backends never call `spawn` directly — this is the only long-running-
 * process boundary, mirroring `ProcessRunner` for run-to-completion
 * commands.
 */
export interface PluginProcessSpawner {
  spawn(command: readonly string[], options: PluginProcessSpawnOptions): PluginProcessHandle
}

// ------------------------------------------------------------ sessions

/**
 * Minimal, runtime-agnostic surface the engine needs from an agent
 * runner. No opencode SDK types leak through this port — runners
 * (opencode today, others later) implement it against their own client.
 */
export interface SessionClient {
  createSession(input: { title: string; directory: string; parentID?: string; runId?: string }): Promise<{ id: string }>
  prompt(input: {
    sessionID: string
    text: string
    agent?: string
    model?: string
  }): Promise<void>
  sessionExists(sessionID: string): Promise<boolean>
  /**
   * Live status of a session. "retry" (provider retrying) is reported
   * distinctly but treated like busy by callers. "missing" = the session
   * is gone (server restart / deleted).
   */
  status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing">
  /**
   * Append an informational message to a session WITHOUT triggering
   * inference (noReply). Used to keep the feature's parent session a
   * readable timeline of what each step/agent did.
   */
  note(input: { sessionID: string; text: string }): Promise<void>
  /**
   * Stop a session's current processing — the engine calls this when it
   * reaps a run so the runtime does not keep an orphan session burning
   * tokens against a concluded run. Aborting a session that is already
   * finished or missing is a no-op success; a thrown error is treated
   * as best-effort failure by callers (logged, never blocks the reap).
   */
  abort(sessionID: string): Promise<void>
}
