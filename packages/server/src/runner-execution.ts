/**
 * Transport-neutral runner-safety contracts (acp-runner design.md D4–D6,
 * D8). This module owns:
 *
 *  - the durable operation/binding/fence VOCABULARY (types only — no
 *    SQL, no process, no SDK import ever crosses into here);
 *  - the narrow PERSISTENCE port `RunnerSafetyStore` that `Store`
 *    implements (task 2.1+) and the ACP adapter/engine consume, so
 *    owners B (Store/engine) and C (ACP adapter) can compile and test
 *    against fakes before the real implementation lands;
 *  - the pure computation `deriveOperationLogicalKey` — the ONE place
 *    that decides how a create/prompt/answer/nudge maps to its durable
 *    idempotency key, so the engine, the Store and every test agree on
 *    it byte-for-byte.
 *
 * "Transport-neutral" is load-bearing: nothing here knows about ACP
 * JSON-RPC, MCP tools or HTTP. `packages/server/src/acp/**` and
 * `run-auth.ts`/`run-reporting.ts` depend on this module; this module
 * depends on nothing runner-specific.
 */

import type { OperationPurpose, RunnerOperationDelivery } from "./ports.ts"

// --------------------------------------------------------------- vocabulary

/** Which transport a run is durably bound to (D5 `runner_binding.transport`).
 *  Set ONCE, at run insertion, before any process/session await — never
 *  reread from current config after that point (design.md: "Transport
 *  selection changes SHALL NOT reroute existing attempts"). */
export type RunnerTransport = "native" | "acp" | "opencode"

/** The four durable operation kinds (D5 `runner_operation.kind`). Every
 *  kind has its own logical-key derivation rule (see
 *  `deriveOperationLogicalKey`) and, except `nudge`, its own uniqueness
 *  scope of "at most one unresolved instance per binding". */
export type RunnerOperationKind = "create" | "prompt" | "answer" | "nudge"

/**
 * A durable operation's lifecycle phase (D5). Mirrors
 * `OperationObservationStatus` from `ports.ts` but is the PERSISTED
 * vocabulary — `prepared` exists here (before any write is attempted)
 * where the port's observation type does not need it, since an
 * implementation only observes a submitted-or-later operation.
 *
 *   prepared → sending → submitted → completed
 *                  \-------------------> not_sent (proven no write happened)
 *   (any non-terminal phase) → unknown (restart/crash without a durable
 *                                        completion record)
 *
 * `unknown` and `not_sent` are TERMINAL for the operation row itself —
 * once set, the safety layer never transitions it further; a fresh
 * attempt gets a fresh operation row under a fresh binding.
 */
export type RunnerOperationPhase = "prepared" | "sending" | "submitted" | "completed" | "not_sent" | "unknown"

const NON_TERMINAL_OPERATION_PHASES: ReadonlySet<RunnerOperationPhase> = new Set(["prepared", "sending", "submitted"])

export function isTerminalOperationPhase(phase: RunnerOperationPhase): boolean {
  return !NON_TERMINAL_OPERATION_PHASES.has(phase)
}

/** Why a run was fenced (D5 `runner_fence.reason_code`). Purely
 *  descriptive/audit — routing never branches on this beyond "a fence
 *  exists for this run". */
export type RunnerFenceReasonCode =
  | "lost_create_response"
  | "lost_prompt_response"
  | "lost_answer_response"
  | "process_or_daemon_restart"
  | "turn_deadline_exceeded"
  | "no_report_timeout"
  | "cancellation_during_uncertain_write"
  | "startup_recovery"

/** Evidence of process-group cleanup recorded alongside a fence (D6/D9/
 *  runner-execution-safety spec's "confirmed or operator-attested orphan
 *  cleanup"). `unconfirmed` blocks replacement work until an operator
 *  acknowledges cleanup explicitly through recovery. */
export type RunnerCleanupState = "confirmed_terminated" | "operator_attested" | "unconfirmed"

/** Answer-delivery dispositions this change adds on top of the existing
 *  `AnswerDeliveryStatus` (`pending|claimed|delivered|failed|cancelled`)
 *  from `harden-interactive-answer-delivery`. `submitted` is open but
 *  NON-reclaimable (a lease cannot resend it); `unknown` is terminal for
 *  automatic handling and fences the run. */
export type UncertainAnswerDisposition = "submitted" | "unknown"

/** A durable binding row (D5 `runner_binding`) — the projection every
 *  consumer of `RunnerSafetyStore` reads. `sessionRef` is opaque to this
 *  module: for ACP it is the local process/session identity, for native
 *  it is unused (native has its own routing through `runner-registry`/
 *  `runner-transport`). */
export interface RunnerBindingRecord {
  readonly runId: string
  readonly transport: RunnerTransport
  readonly profileId: string | null
  readonly configDigest: string | null
  readonly directory: string
  readonly daemonGeneration: number
  readonly sessionRef: string | null
  readonly remoteSessionId: string | null
  readonly processGeneration: number
  readonly phase: "active" | "fenced" | "concluded"
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RunnerOperationRecord {
  readonly id: string
  readonly runId: string
  readonly kind: RunnerOperationKind
  readonly logicalKey: string
  readonly payloadDigest: string
  readonly phase: RunnerOperationPhase
  readonly ownerGeneration: number
  readonly version?: number
  readonly stopReason: string | null
  readonly diagnosticCode: string | null
  readonly diagnostic?: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RunnerFenceRecord {
  readonly runId: string
  readonly reasonCode: RunnerFenceReasonCode
  readonly operationId: string | null
  readonly cleanupState: RunnerCleanupState
  readonly createdAt: number
  readonly resolvedAt: number | null
  readonly resolutionNote: string | null
  /** Self-healing D1 — null until cleanup evidence lets the engine classify. */
  readonly classification?: "no_effect" | "replay_safe" | "unsafe" | null
  readonly evidence?: Readonly<Record<string, unknown>> | null
  readonly classifiedAt?: number | null
}

export interface RunCredentialRecord {
  readonly id: string
  readonly runId: string
  readonly attempt: number
  readonly processGeneration: number
  readonly tokenHash: string
  readonly issuedAt: number
  readonly expiresAt: number | null
  readonly revokedAt: number | null
  readonly revocationReason: string | null
}

// ------------------------------------------------------------ logical keys

/**
 * The ONE derivation of a durable operation's logical key (D5): `create`
 * is keyed by the run id itself (at most one `session/new` per run,
 * ever); `answer` is keyed by the answer-delivery's own `delivery_token`
 * (harden-interactive-answer-delivery's existing idempotency marker,
 * reused rather than inventing a second one); `nudge` is keyed by a
 * durable per-run ordinal the caller supplies (each nudge is its own
 * logical operation — nudges are not deduplicated against each other,
 * only against themselves if redelivered); `prompt` outside of an answer
 * or nudge (the step's initial prompt) reuses the run id exactly like
 * `create` — a run has exactly one initial prompt.
 */
export function deriveOperationLogicalKey(
  kind: RunnerOperationKind,
  input: { readonly runId: string; readonly deliveryToken?: string; readonly nudgeOrdinal?: number },
): string {
  switch (kind) {
    case "create":
      return input.runId
    case "prompt":
      return input.runId
    case "answer":
      if (input.deliveryToken === undefined) {
        throw new Error("deriveOperationLogicalKey(\"answer\") requires deliveryToken")
      }
      return input.deliveryToken
    case "nudge":
      if (input.nudgeOrdinal === undefined) {
        throw new Error("deriveOperationLogicalKey(\"nudge\") requires nudgeOrdinal")
      }
      return `nudge:${input.nudgeOrdinal}`
  }
}

/** Maps a prompt's `OperationPurpose` (ports.ts) onto the durable
 *  `RunnerOperationKind` it is journaled under — `initial` and `answer`
 *  purposes both go through `session/prompt`, but only `answer` is keyed
 *  by delivery token; `nudge` gets its own kind because it is never
 *  deduplicated against the step's initial prompt. */
export function operationKindForPurpose(purpose: OperationPurpose | undefined): RunnerOperationKind {
  if (purpose === "answer") return "answer"
  if (purpose === "nudge") return "nudge"
  return "prompt"
}

// ----------------------------------------------------------- fence input

/** A structured fencing request (D6) — the pure input to the atomic
 *  `fenceRunnerExecution` transaction (`Store`, task 2.3). Always
 *  produced from EITHER a `RunnerOperationError` with `delivery:
 *  "unknown"` or a safety-timeout observation; never from an ordinary
 *  classified failure (those keep their existing `step.failed` route). */
export interface FenceRequest {
  readonly runId: string
  readonly jobId: string
  readonly stepId: string
  readonly reasonCode: RunnerFenceReasonCode
  readonly operationId?: string
  readonly diagnostic: string
}

/** The classification a caller uses to decide fence vs. ordinary bounded
 *  retry (runner-execution-safety spec: "Proven no-write failure ...
 *  bounded ordinary retry ... remains available"). */
export function requiresFence(delivery: RunnerOperationDelivery): boolean {
  return delivery === "unknown"
}

// -------------------------------------------------------- persistence port

/**
 * The narrow persistence surface owners C (ACP adapter) and D (reporting)
 * depend on WITHOUT depending on the concrete `Store` — satisfied by
 * `Store` in production (task 2.1+) and by an in-memory fake in tests
 * authored before Store lands. Every method here is intentionally a
 * small, single-purpose durable transition; the wider durable-safety
 * transaction (`fenceRunnerExecution`) lives on `Store` itself because it
 * also touches `run`/`answer_delivery`/interpreter state this narrow
 * port does not otherwise expose.
 */
export interface RunnerSafetyStore {
  /** Persist the transport binding at run insertion (D5: "BEFORE
   *  process/session awaits"). Idempotent no-op if a binding already
   *  exists for this run (a retried insert path never double-binds). */
  bindRunnerTransport(input: {
    readonly runId: string
    readonly transport: RunnerTransport
    readonly profileId?: string
    readonly configDigest?: string
    readonly directory: string
    readonly daemonGeneration: number
  }): RunnerBindingRecord

  getRunnerBinding(runId: string): RunnerBindingRecord | null

  /** Attach the adapter's opaque session/process identity once known
   *  (after `session/new` completes) — distinct from the initial bind so
   *  a lost `session/new` response still has a durable binding to fence. */
  setBindingSessionRef(runId: string, sessionRef: string, remoteSessionId?: string): boolean

  /**
   * Records live liveness (review F3): a `session/update` notification
   * proves the agent is actively working the turn, independent of any
   * completion/report. Only updates `time_last_activity` for a `running`
   * run — a no-op once the run has concluded (fenced, reaped, reported)
   * so a stray/late notification can never resurrect its TTL clock.
   * Callers MUST throttle their own call rate (D9: "Activity
   * notifications update existing run liveness through the Store
   * without treating silence as idle" is about SILENCE, not about
   * writing on every single chunk of a streamed turn) — this method
   * itself performs the write unconditionally when called.
   */
  touchRunActivity(runId: string, time?: number): void

  /**
   * Claim a fresh operation row, or return the existing one for an
   * identical `(runId, kind, logicalKey)` with a matching payload digest
   * (D5: "Duplicate logical keys with matching digest return existing
   * state; differing payloads conflict"). Throws on a payload-digest
   * conflict — callers must treat that as a programming error, not a
   * retryable condition.
   */
  claimOperation(input: {
    readonly runId: string
    readonly kind: RunnerOperationKind
    readonly logicalKey: string
    readonly payloadDigest: string
    readonly ownerGeneration: number
  }): RunnerOperationRecord

  /** CAS phase transition — false when the current phase/generation no
   *  longer matches (a concurrent caller already moved it, or a fence
   *  already terminated it). Never allows a transition OUT of a terminal
   *  phase (`not_sent`/`unknown`). */
  transitionOperationPhase(
    operationId: string,
    from: RunnerOperationPhase,
    to: RunnerOperationPhase,
    detail?: { readonly stopReason?: string; readonly diagnosticCode?: string; readonly diagnostic?: string; readonly expectedVersion?: number; readonly ownerGeneration?: number },
  ): boolean

  getOperation(operationId: string): RunnerOperationRecord | null
  findOperation(runId: string, kind: RunnerOperationKind, logicalKey: string): RunnerOperationRecord | null

  /** Every non-terminal operation for bindings under an OLDER daemon
   *  generation than `currentGeneration` — the startup-recovery scan
   *  (D5/D10: "mark old-generation nonterminal ACP operations/bindings
   *  unknown ... before activation reconcile"). */
  listStaleGenerationOperations(currentGeneration: number): readonly RunnerOperationRecord[]

  recordFence(input: FenceRequest & { readonly cleanupState: RunnerCleanupState }): RunnerFenceRecord
  getFence(runId: string): RunnerFenceRecord | null
  resolveFence(runId: string, note: string): boolean

  issueCredential(input: { readonly runId: string; readonly attempt: number; readonly processGeneration: number; readonly tokenHash: string; readonly issuedAt: number; readonly expiresAt?: number }): RunCredentialRecord
  /** Looks up a credential by hash — the ONLY lookup path; a plaintext
   *  token never round-trips back out of the store (D8: "no plaintext
   *  token in database/projections"). */
  findCredentialByHash(tokenHash: string): RunCredentialRecord | null
  revokeCredential(id: string, reason: string): boolean
  revokeCredentialsForRun(runId: string, reason: string): number
}

// -------------------------------------------------------- reporting/readiness

/**
 * Owner D's readiness signal, consumed by owner C/B's engine integration
 * (task 2.4: "Before first prompt, wait for the injected bridge's
 * authenticated initialized + tools/list readiness signal" — D8). Kept
 * here (transport-neutral) rather than in `run-reporting.ts` so the
 * engine can depend on the NARROW readiness contract without depending
 * on the whole MCP/HTTP reporting module. The real implementation
 * (task 4.1/4.2) records these against the run's attempt credential;
 * this interface is what a test fake and the engine both compile
 * against in the meantime.
 */
export interface ReportingReadinessPort {
  /** True once BOTH `initialized` and `tools/list` have been observed
   *  for this run's current bridge generation — never true from mere
   *  process spawn (D8: "Merely spawning a bridge is not tool
   *  readiness"). */
  isReady(runId: string): boolean
  /** Called by the restricted `/v1/worker/ready` route (task 4.1) when
   *  the bridge reports a phase; the engine never calls this directly. */
  markPhase(runId: string, phase: "initialized" | "tools_listed"): void
}

/**
 * `ReportingReadinessPort` plus explicit bounded cleanup. A bare
 * in-memory `Map<runId, ...>` that only ever grows for the daemon's
 * WHOLE lifetime (one entry per run ever dispatched, never freed) is an
 * unbounded-memory review finding, not a correctness one — every ACP
 * run's local id is unique and the process never restarts the map. The
 * composition layer (task 5.1's `composeManagedRunners`) calls `clear`
 * once a run's ACP session is cleaned up (fence/terminal
 * conclusion/abandon/shutdown — every `Engine.cleanupRunner` call site),
 * the same lifecycle moment credentials are revoked (D8: "Revoke on
 * terminal outcome, fence, replacement, abandon and shutdown/restart
 * loss of ownership") — readiness tracking for a run with no live
 * credential can never matter again.
 */
export interface ManagedReportingReadiness extends ReportingReadinessPort {
  /** Frees this run's tracked phases. Idempotent — clearing a run that
   *  was never tracked (or already cleared) is a harmless no-op. */
  clear(runId: string): void
}

function createReadinessTracker(): ManagedReportingReadiness {
  const phases = new Map<string, Set<"initialized" | "tools_listed">>()
  return {
    isReady(runId) {
      const seen = phases.get(runId)
      return seen !== undefined && seen.has("initialized") && seen.has("tools_listed")
    },
    markPhase(runId, phase) {
      const seen = phases.get(runId) ?? new Set()
      seen.add(phase)
      phases.set(runId, seen)
    },
    clear(runId) {
      phases.delete(runId)
    },
  }
}

/**
 * The PRODUCTION readiness tracker (task 4.1) — wired by
 * `packages/cli/src/main.ts` into `composeManagedRunners`. Distinct in
 * name (not "Fake") from the identically-shaped test double below: this
 * one is bounded by the composition layer's explicit `clear()` calls on
 * session cleanup, where the fake is a standalone unbounded double a
 * test constructs and discards per-test (its unboundedness never
 * matters at test-process lifetime).
 */
export function createReportingReadiness(): ManagedReportingReadiness {
  return createReadinessTracker()
}

/** Minimal in-memory fake satisfying `ReportingReadinessPort` — exported
 *  for tests authored before task 4.1's real implementation lands (and
 *  reusable by task 4's own unit tests for the same shape). Structurally
 *  identical to `createReportingReadiness`; kept as a separate named
 *  export so test call sites read as intentionally test-scoped. */
export function createFakeReportingReadiness(): ManagedReportingReadiness {
  return createReadinessTracker()
}

// ------------------------------------------------------------- fail-closed

/**
 * The single "was this operation potentially delivered" predicate every
 * caller (nudge, TTL/reap, restart recovery, answer delivery) must use
 * instead of ad hoc phase comparisons — conservative by construction:
 * anything that is not proven `not_sent` is potentially delivered and
 * therefore requires a fence, never a retry.
 */
export function operationPotentiallyDelivered(phase: RunnerOperationPhase): boolean {
  return phase !== "not_sent"
}
