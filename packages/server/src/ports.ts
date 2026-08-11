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
}
