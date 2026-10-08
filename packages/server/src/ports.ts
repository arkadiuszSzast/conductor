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
  readonly signal?: AbortSignal
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
//
// D4 (openspec/changes/acp-runner/design.md): the native HTTP transport
// and the new ACP adapter share exactly one `SessionClient` port. Every
// addition below is OPTIONAL or additive to an existing return type so
// `createRunnerSessionClient` (native) and every existing test fixture
// keep satisfying this interface with zero changes — "unsupported
// optional operations fail closed" means a caller that needs a
// capability an implementation does not provide must treat its absence
// as unavailable/incompatible, never silently assume success.

/**
 * Live status of a session. "retry" (provider retrying) is reported
 * distinctly but treated like busy by callers. "missing" = the session
 * is gone (server restart / deleted). "unknown" (D4) is new: an
 * ambiguous observation — e.g. ACP's stable protocol has no receiver-side
 * status query, so a disconnected/silent peer is NOT evidence of idle or
 * missing. Callers MUST NOT treat "unknown" as either "busy" (which can
 * excuse forever-silent work) or "idle"/"missing" (which can trigger a
 * nudge or reap that races an effect that may already be in flight) —
 * see runner-execution.ts's fencing contract for the safe caller-side
 * handling of this value.
 */
export type SessionStatus = "busy" | "idle" | "retry" | "missing" | "unknown"

/**
 * What a session client can actually do, queried once per attempt so the
 * engine never guesses. Absent (no `capabilities()` method) means the
 * NATIVE full feature set (`NATIVE_SESSION_CAPABILITIES` below) — every
 * existing native fixture without this method is unaffected.
 */
export interface SessionCapabilities {
  /** Whether `createSession({ parentID })` produces a real, addressable
   *  parent the engine can reuse across a feature's steps. */
  readonly parentSessions: boolean
  /** Whether `note()` reaches the runtime without triggering inference
   *  (opencode's `noReply`). False means the engine must record an
   *  informational note in Conductor's own timeline instead of calling
   *  `note()` at all — never emulate it with a real prompt. */
  readonly nonInferentialNotes: boolean
  /**
   * How strongly a resolved `prompt()` call proves the runtime accepted
   * the work:
   *  - "immediate": the native HTTP transport's existing contract — a
   *    resolved promise means the runner processed the prompt request.
   *  - "submitted": ACP's contract — a resolved `{kind:"submitted"}`
   *    means only that the local JSON-RPC write completed; it is NOT
   *    remote acceptance. The eventual turn outcome must be observed
   *    through `observeOperation`.
   */
  readonly promptConfirmation: "immediate" | "submitted"
}

/** The native transport's implicit capabilities — the default assumed
 *  whenever a `SessionClient` omits `capabilities()` entirely. */
export const NATIVE_SESSION_CAPABILITIES: SessionCapabilities = {
  parentSessions: true,
  nonInferentialNotes: true,
  promptConfirmation: "immediate",
}

/** Input to an optional pre-dispatch `prepare()` call (D4): launches/
 *  initializes a process and negotiates capabilities WITHOUT creating a
 *  session or sending a prompt — the engine can hold an in-flight target
 *  guard while this is outstanding and recheck durable eligibility
 *  before ever inserting a run. */
export interface PrepareInput {
  readonly projectDir: string
  readonly directory: string
  readonly agent: string
  readonly model?: string
  /** Model variant/effort, resolved role ?? binding. */
  readonly variant?: string
}

/**
 * A bounded, ONE-USE reservation plus the negotiated capabilities, or a
 * structured refusal. `ok: false` is not an error the caller retries
 * blindly: "unavailable" is a capacity/transient condition (durable
 * resource-wait territory, consumes no attempt); "incompatible" is a
 * permanent mismatch (wrong protocol major, unsupported role/model) that
 * must fail closed before any prompt, never silently fall back to
 * another profile/runner.
 */
export type PrepareResult =
  | { readonly ok: true; readonly reservationId: string; readonly capabilities: SessionCapabilities }
  | { readonly ok: false; readonly reason: "unavailable" | "incompatible"; readonly diagnostic: string }

/** Why a durable operation was submitted — the logical key an
 *  implementation derives its idempotency identity from (D5: initial
 *  key is the run id, answer key is the delivery token, nudge key is a
 *  durable ordinal). Purely descriptive here; the actual key computation
 *  lives with whoever owns the durable operation journal (Store, task
 *  2.1+), not in this port. */
export type OperationPurpose = "initial" | "answer" | "nudge"

/**
 * Conservative observation of a durable operation's outcome (D4/D5).
 * Never inferred from silence: an implementation without positive
 * evidence for a phase must report "unknown", not guess "completed" or
 * "not_sent". `not_sent` is the one phase a caller may safely retry from
 * — it asserts the write boundary was never entered.
 */
export type OperationObservationStatus = "prepared" | "sending" | "submitted" | "completed" | "not_sent" | "unknown"

export interface OperationObservation {
  readonly status: OperationObservationStatus
  /** ACP turn stop reason when known (`end_turn`, `max_tokens`, …) — a
   *  transport diagnostic, never a workflow outcome by itself. */
  readonly stopReason?: string
  /** Bounded, sanitized diagnostic text — never raw protocol frames, env
   *  or tool arguments (acp-execution spec: "Worker environment and
   *  diagnostics are explicit"). */
  readonly diagnostic?: string
}

/** `RunnerOperationError.delivery` — the ONLY two shapes a
 *  runtime-neutral error may assert about a failed operation:
 *  "not_sent" (proven never to have entered the write boundary — safe
 *  to retry through the ordinary bounded budget) or "unknown" (dominates
 *  any retryable classification; must fence rather than retry). There is
 *  no third "confirmed not delivered" shape — a stable ACP peer offers
 *  no receiver-side proof of that. */
export type RunnerOperationDelivery = "not_sent" | "unknown"

/**
 * Structured runner failure (D4). Replaces exception-message regex
 * classification for anything that can assert delivery uncertainty: a
 * caller MUST branch on `.delivery` before falling back to generic
 * message-based classification (`classifyThrownBoundary`), and
 * `delivery: "unknown"` MUST dominate — it can never be downgraded to a
 * retryable class by a resource-unavailable check, which only applies
 * when `delivery === "not_sent"`.
 *
 * `failureClass`, when present, is an EXPLICIT structural classification
 * (e.g. an unsupported/unadvertised mode or model selection is always
 * `invalid_config` — a workflow/binding-configuration defect, never a
 * transient boundary condition a message-regex could plausibly guess
 * right) that a caller MUST prefer over `classifyThrownBoundary`'s
 * message-text heuristic. Only meaningful when `delivery === "not_sent"`
 * (a proven-safe-to-fail-fast case) — `"unknown"` deliveries fence
 * regardless of any class.
 */
export class RunnerOperationError extends Error {
  readonly delivery: RunnerOperationDelivery
  readonly operationId?: string
  readonly diagnostic: string
  readonly failureClass?: "invalid_config"

  constructor(message: string, options: { readonly delivery: RunnerOperationDelivery; readonly operationId?: string; readonly diagnostic?: string; readonly failureClass?: "invalid_config" }) {
    super(message)
    this.name = "RunnerOperationError"
    this.delivery = options.delivery
    this.diagnostic = options.diagnostic ?? message
    if (options.operationId !== undefined) this.operationId = options.operationId
    if (options.failureClass !== undefined) this.failureClass = options.failureClass
  }
}

/**
 * Minimal, runtime-agnostic surface the engine needs from an agent
 * runner. No opencode SDK types leak through this port — runners
 * (opencode today, ACP later in this change) implement it against their
 * own client. Every D4 addition is optional or additive so the existing
 * native `SessionClient` (createRunnerSessionClient) and every test
 * fixture keep satisfying this interface unmodified.
 */
export interface SessionClient {
  createSession(input: {
    title: string
    directory: string
    parentID?: string
    runId?: string
    /** One-use reservation from a prior `prepare()` call — ACP consumes
     *  it to bind the already-launched process to this session. Ignored
     *  by implementations that do not support `prepare()`. */
    reservationId?: string
    /** Durable create-operation identity (D5) — ACP's `session/new` is
     *  keyed by this so a lost response fences instead of retrying with
     *  a fresh `session/new`. Ignored by the native transport. */
    operationId?: string
  }): Promise<{ id: string }>
  prompt(input: {
    sessionID: string
    text: string
    agent?: string
    model?: string
    /** Durable prompt-operation identity (D5) — required for any
     *  implementation whose `capabilities().promptConfirmation` is
     *  "submitted". Ignored by the native transport. */
    operationId?: string
    /** Why this prompt is being sent — distinguishes the step's initial
     *  work from an answer delivery or a silence nudge for durable
     *  operation-key derivation. Defaults to "initial" when omitted. */
    purpose?: OperationPurpose
    /**
     * D5: any object that supports operation confirmation.
     */
  }): Promise<
    | void
    /** Local JSON-RPC write completed — NOT remote acceptance. The
     *  caller observes eventual completion via `observeOperation`. Only
     *  ever returned by an implementation whose `capabilities()`
     *  advertises `promptConfirmation: "submitted"`. */
    | { readonly kind: "submitted"; readonly operationId: string }
  >
  sessionExists(sessionID: string): Promise<boolean>
  status(sessionID: string): Promise<SessionStatus>
  /**
   * Append an informational message to a session WITHOUT triggering
   * inference (noReply). Used to keep the feature's parent session a
   * readable timeline of what each step/agent did. An implementation
   * whose `capabilities().nonInferentialNotes` is false MUST NOT be
   * called here — the engine records a Conductor-timeline diagnostic
   * instead (acp-execution spec: "Agent lacks a note operation").
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
  /**
   * Optional pre-dispatch reservation (D4). Absent means "no
   * preparation is needed" — the native transport's implicit contract,
   * where capacity is unbounded from the engine's point of view (the
   * runner hub owns its own liveness). An implementation that DOES
   * support `prepare()` must be called before `createSession` for a
   * fresh attempt; the engine holds the returned reservation only long
   * enough to pass it straight into `createSession`.
   */
  prepare?(input: PrepareInput): Promise<PrepareResult>
  /**
   * Conservative observation of a durable operation started via
   * `createSession`/`prompt`. Absent means the implementation has no
   * asynchronous operations to observe (the native transport's prompt
   * already fully confirms by returning). Required for any
   * implementation whose `capabilities().promptConfirmation` is
   * "submitted".
   */
  observeOperation?(operationId: string): Promise<OperationObservation>
  /** Queried once per attempt; absent means `NATIVE_SESSION_CAPABILITIES`. */
  capabilities?(): SessionCapabilities
}

/** Fail-closed capability lookup: an implementation without
 *  `capabilities()` gets the native defaults, never an assumed-weaker or
 *  assumed-stronger guess. Every call site that branches on capability
 *  MUST go through this helper rather than reading `sessions.capabilities?.()`
 *  directly, so a missing method can never silently read as `undefined`
 *  and short-circuit a capability check to "false" by accident. */
export function sessionCapabilitiesOf(sessions: SessionClient): SessionCapabilities {
  return sessions.capabilities?.() ?? NATIVE_SESSION_CAPABILITIES
}
