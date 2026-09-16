import { randomUUID } from "node:crypto"
import type { Database } from "./database.ts"
import { applyPatch, initialFeatureState } from "./state.ts"
import type { CreateFeatureInput } from "./state.ts"
import { DEFAULT_RETRY_BUDGET, accumulatePausedMs, boundDiagnostic } from "@conductor/core"
import type {
  Decision,
  FailureClass,
  FailureEnvelope,
  Feedback,
  FeatureState,
  FeatureStatus,
  JobRuntime,
  PipelineEvent,
  ResourceReason,
  Transition,
} from "@conductor/core"

/**
 * Post-commit change notification — the invalidation signal the API's
 * SSE stream fans out. Deliberately carries no payload beyond the kind
 * and feature id: subscribers refetch authoritative state over REST,
 * the notification itself is never a state carrier.
 */
export interface StoreChange {
  readonly kind: "feature" | "transition" | "run" | "finding" | "run_log"
  readonly featureId: string
}

interface FeatureRow {
  id: string
  title: string
  slug: string
  project_dir: string
  status: FeatureStatus
  workflow: string | null
  description: string | null
  pr: number | null
  escalation: string | null
  state: string
  feedback: string | null
  paused_at: number | null
  paused_ms: number
  time_created: number
  time_updated: number
}

function toFeatureState(row: FeatureRow): FeatureState {
  return JSON.parse(row.state) as FeatureState
}

function hasWaitingHumanStep(state: FeatureState): boolean {
  return Object.values(state.jobs).some(job =>
    Object.values(job.steps).some(step => step.status === "waiting_human"),
  )
}

/**
 * A feature's interpreter state plus the row metadata the API projects
 * (creation/update timestamps). The timestamps deliberately live OUTSIDE
 * `FeatureState`: the interpreter never writes them, so they are store
 * metadata returned alongside the state, not part of it.
 */
export interface FeatureRecord {
  readonly state: FeatureState
  readonly createdAt: number
  readonly updatedAt: number
}

function toFeatureRecord(row: FeatureRow): FeatureRecord {
  return { state: toFeatureState(row), createdAt: row.time_created, updatedAt: row.time_updated }
}

/** Pause-time accounting row (design.md: "budget clocks store accumulated
 *  paused duration") — lives outside `FeatureState`, same as escalation. */
export interface PauseAccounting {
  /** Set the instant the feature entered `paused`; null while not paused. */
  readonly pausedAt: number | null
  /** Total ms accumulated across every CLOSED pause span so far. */
  readonly pausedMs: number
}

function toPauseAccounting(row: { paused_at: number | null; paused_ms: number }): PauseAccounting {
  return { pausedAt: row.paused_at, pausedMs: row.paused_ms }
}

export interface FeatureFilter {
  activeOnly?: boolean
  projectDir?: string
  statuses?: readonly FeatureStatus[]
}

function featureWhere(filter?: FeatureFilter): { where: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (filter?.activeOnly) clauses.push("status IN ('running','paused','waiting_human','escalated')")
  if (filter?.projectDir !== undefined) {
    clauses.push("project_dir = ?")
    params.push(filter.projectDir)
  }
  if (filter?.statuses !== undefined && filter.statuses.length > 0) {
    clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`)
    params.push(...filter.statuses)
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

interface RunRow {
  id: string
  feature_id: string
  job_id: string
  step_id: string
  step_type: "agent" | "command" | "action"
  attempt: number
  status: "running" | "succeeded" | "failed" | "reaped"
  session_id: string | null
  outputs: string
  reason: string | null
  nudges: number
  completion_event: string | null
  completion_decisions: string | null
  action_handled: number
  metadata: string | null
  pending_state: string | null
  next_observation: number | null
  pending_question: string | null
  asked_at: number | null
  failure_class: FailureClass | null
  failure_source: string | null
  failure_retry_hint_ms: number | null
  paused_ms_at_dispatch: number
  time_started: number
  time_last_activity: number | null
  time_finished: number | null
}

/** Resolved action identity recorded on an action run — pins `uses`, the
 *  resolved manifest version and the content digest the run executed
 *  against, independent of what the registry resolves to later. */
export interface RunActionMetadata {
  readonly uses: string
  readonly version: string
  readonly digest: string
}

export interface RunSummary {
  readonly id: string
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly stepType: "agent" | "command" | "action"
  readonly attempt: number
  readonly status: "running" | "succeeded" | "failed" | "reaped"
  readonly sessionId: string | null
  readonly outputs: Readonly<Record<string, string>>
  readonly reason: string | null
  readonly nudges: number
  readonly metadata: RunActionMetadata | null
  /** Opaque state a durable-pending action asked to see again on its next observation. */
  readonly pendingState: Readonly<Record<string, unknown>> | null
  /** When the reconciler should re-invoke a durable-pending action run. Null while not pending. */
  readonly nextObservation: number | null
  /** Question an interactive agent run asked; null when not waiting for an answer. */
  readonly pendingQuestion: string | null
  readonly askedAt: number | null
  /** The classified failure envelope this run concluded with, if any —
   *  null for a run that succeeded, is still running, or concluded
   *  before the retry-policy failure taxonomy existed. */
  readonly failure: FailureEnvelope | null
  /** The feature's cumulative `paused_ms` at the instant this run was
   *  dispatched — the streak-anchor baseline `planFailureDisposition`
   *  needs for a FIRST attempt (see `retry_episode.feature_paused_ms_at_start`'s
   *  doc comment): there is no other durable record of what the
   *  feature's pause total was at that past instant. */
  readonly pausedMsAtDispatch: number
  readonly timeStarted: number
  /** When this run last showed life — dispatch, accepted log appends,
   *  question flow, nudges. The reaper's TTL measures silence from here,
   *  never age from `timeStarted`. Falls back to `timeStarted` for rows
   *  predating the column. */
  readonly timeLastActivity: number
  readonly timeFinished: number | null
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    featureId: row.feature_id,
    jobId: row.job_id,
    stepId: row.step_id,
    stepType: row.step_type,
    attempt: row.attempt,
    status: row.status,
    sessionId: row.session_id,
    outputs: JSON.parse(row.outputs) as Record<string, string>,
    reason: row.reason,
    nudges: row.nudges,
    metadata: row.metadata ? (JSON.parse(row.metadata) as RunActionMetadata) : null,
    pendingState: row.pending_state ? (JSON.parse(row.pending_state) as Record<string, unknown>) : null,
    nextObservation: row.next_observation,
    pendingQuestion: row.pending_question,
    askedAt: row.asked_at,
    failure: toFailureEnvelope(row.failure_class, row.failure_source, row.reason, row.failure_retry_hint_ms),
    pausedMsAtDispatch: row.paused_ms_at_dispatch,
    timeStarted: row.time_started,
    timeLastActivity: row.time_last_activity ?? row.time_started,
    timeFinished: row.time_finished,
  }
}

function toFailureEnvelope(
  failureClass: FailureClass | null,
  source: string | null,
  diagnostic: string | null,
  retryHintMs: number | null,
): FailureEnvelope | null {
  if (failureClass === null || source === null) return null
  return {
    class: failureClass,
    diagnostic: diagnostic ?? "",
    source,
    ...(retryHintMs !== null ? { retryHintMs } : {}),
  }
}

export interface TransitionEntry {
  readonly event: PipelineEvent
  readonly decisions: readonly Decision[]
  readonly time: number
}

export interface FindingCounts {
  readonly new: number
  readonly fixed: number
  readonly dismissed: number
  readonly reopened: number
}

export type RunLogSource = "process" | "action" | "agent" | "tool" | "step"

export interface RunLogEntryInput {
  readonly source: RunLogSource
  readonly text: string
}

export interface RunLogLine {
  readonly seq: number
  readonly time: number
  readonly source: RunLogSource
  readonly text: string
}

export interface RunLogPage {
  readonly lines: readonly RunLogLine[]
  /** Cursor for the next fetch: the highest seq the caller has seen. */
  readonly nextSeq: number
  /** True when more lines exist beyond this page. */
  readonly truncated: boolean
}

/** Per-run size cap for run_log chunk text — enforced at write, drop-oldest. */
const RUN_LOG_CAP_BYTES = 2 * 1024 * 1024
/** run_log change notifications for one run coalesce within this window. */
const RUN_LOG_EMIT_WINDOW_MS = 1_000

export interface FindingView {
  readonly id: string
  readonly stepId: string
  readonly path: string
  readonly line: number
  readonly severity: string
  readonly tags: string[]
  readonly body: string
  readonly status: "new" | "fixed" | "dismissed" | "reopened"
  readonly resolution: string | null
  readonly threadId: string | null
  readonly synced: boolean
}

// --------------------------------------------------------------- retry episodes

export type RetryEpisodeStatus = "scheduled" | "claimed" | "closed"

interface RetryEpisodeRow {
  id: string
  feature_id: string
  job_id: string
  step_id: string
  status: RetryEpisodeStatus
  attempts: number
  started_at: number
  paused_ms: number
  feature_paused_ms_at_start: number
  next_attempt_at: number | null
  delay_ms: number | null
  schedule_source: "backoff" | "retry_hint" | null
  max_attempts: number
  max_elapsed_ms: number
  last_failure_class: FailureClass | null
  last_failure_source: string | null
  last_failure_diagnostic: string | null
  last_failure_retry_hint_ms: number | null
  last_failure_at: number | null
  recovered_from: string | null
  version: number
  closed_reason: string | null
  time_created: number
  time_updated: number
}

/**
 * A durable retry episode — the persisted counterpart of
 * `RetryEpisodeState`/`FailureRouteDecision` in
 * `packages/core/src/lifecycle.ts`. `attempts`/`startedAt`/`pausedMs`
 * round-trip straight into `decideFailureRoute`'s episode argument; the
 * store never re-derives that arithmetic.
 */
export interface RetryEpisodeRecord {
  readonly id: string
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly status: RetryEpisodeStatus
  readonly attempts: number
  readonly startedAt: number
  /** The stale, only-updated-while-this-episode-is-open pause total —
   *  kept for backward-compatible reads, but budget math should use
   *  `featurePausedMsAtStart` plus the feature's CURRENT cumulative
   *  `paused_ms` instead (see that field's doc comment): this column
   *  misses any pause span that happened while the episode was
   *  scheduled-but-not-yet-open or while no episode existed at all. */
  readonly pausedMs: number
  /** Snapshot of the feature's cumulative `paused_ms` at the streak's
   *  anchor time — the anchor run's `pausedMsAtDispatch` for a genuinely
   *  first episode, or copied forward unchanged from the immediately
   *  preceding episode for a chained one (mirrors `startedAt`'s own
   *  inheritance rule). Effective streak pause time = feature's CURRENT
   *  cumulative `paused_ms` − this snapshot, which — unlike `pausedMs`
   *  above — counts every pause span inside the streak exactly once,
   *  including spans during an executing attempt (no open episode row
   *  to fold into). */
  readonly featurePausedMsAtStart: number
  /** Null once claimed or closed — a claimed/closed episode is not "due". */
  readonly nextAttemptAt: number | null
  readonly delayMs: number | null
  readonly scheduleSource: "backoff" | "retry_hint" | null
  readonly maxAttempts: number
  readonly maxElapsedMs: number
  readonly lastFailure: FailureEnvelope | null
  readonly lastFailureAt: number | null
  /** The episode this one was recovered from (retry-budget spec: "old
   *  failure history remains in the timeline"), null for a first episode. */
  readonly recoveredFrom: string | null
  readonly version: number
  readonly closedReason: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

function toRetryEpisodeRecord(row: RetryEpisodeRow): RetryEpisodeRecord {
  return {
    id: row.id,
    featureId: row.feature_id,
    jobId: row.job_id,
    stepId: row.step_id,
    status: row.status,
    attempts: row.attempts,
    startedAt: row.started_at,
    pausedMs: row.paused_ms,
    featurePausedMsAtStart: row.feature_paused_ms_at_start,
    nextAttemptAt: row.next_attempt_at,
    delayMs: row.delay_ms,
    scheduleSource: row.schedule_source,
    maxAttempts: row.max_attempts,
    maxElapsedMs: row.max_elapsed_ms,
    lastFailure: toFailureEnvelope(row.last_failure_class, row.last_failure_source, row.last_failure_diagnostic, row.last_failure_retry_hint_ms),
    lastFailureAt: row.last_failure_at,
    recoveredFrom: row.recovered_from,
    version: row.version,
    closedReason: row.closed_reason,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

// --------------------------------------------------------------- resource waits

export type ResourceWaitStatus = "waiting" | "claimed" | "closed"

interface ResourceWaitRow {
  id: string
  feature_id: string
  job_id: string
  step_id: string
  status: ResourceWaitStatus
  reason: ResourceReason
  first_observed_at: number
  latest_observed_at: number
  observation_count: number
  next_observation_at: number | null
  deadline_at: number
  diagnostic: string | null
  version: number
  closed_reason: string | null
  time_created: number
  time_updated: number
}

/**
 * A durable resource-wait observation episode — the persisted
 * counterpart of `ResourceWaitState`/`ResourceWaitRouteDecision` in
 * `packages/core/src/lifecycle.ts`. No executable attempt began for a
 * resource wait (failure-classification spec: "distinct from an
 * attempt failure"), so it never touches a step's retry budget.
 */
export interface ResourceWaitRecord {
  readonly id: string
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly status: ResourceWaitStatus
  readonly reason: ResourceReason
  readonly firstObservedAt: number
  readonly latestObservedAt: number
  readonly observationCount: number
  /** Null once claimed or closed. */
  readonly nextObservationAt: number | null
  readonly deadlineAt: number
  readonly diagnostic: string | null
  readonly version: number
  readonly closedReason: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

function toResourceWaitRecord(row: ResourceWaitRow): ResourceWaitRecord {
  return {
    id: row.id,
    featureId: row.feature_id,
    jobId: row.job_id,
    stepId: row.step_id,
    status: row.status,
    reason: row.reason,
    firstObservedAt: row.first_observed_at,
    latestObservedAt: row.latest_observed_at,
    observationCount: row.observation_count,
    nextObservationAt: row.next_observation_at,
    deadlineAt: row.deadline_at,
    diagnostic: row.diagnostic,
    version: row.version,
    closedReason: row.closed_reason,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

// --------------------------------------------------------------- answer deliveries

export type AnswerDeliveryStatus = "pending" | "claimed" | "delivered" | "failed" | "cancelled"

interface AnswerDeliveryRow {
  id: string
  feature_id: string
  run_id: string
  job_id: string
  step_id: string
  question_generation: number
  notes: string
  target_session_id: string | null
  delivery_token: string
  status: AnswerDeliveryStatus
  failure_detail: string | null
  claimed_at: number | null
  lease_expires_at: number | null
  /** Delivery attempts made so far (transient-failure releases increment
   *  this) — the same bounded-retry counter `retry_episode.attempts`
   *  keeps for step retries, mirrored here so a persistently unreachable
   *  session/runner cannot retry forever. */
  attempt_count: number
  /** When this delivery becomes due for its NEXT attempt again — NULL
   *  means due now (a fresh `pending` row, or a `claimed` row whose
   *  lease alone governs due-ness). Set on a transient-failure release
   *  to the class-default backoff's computed delay from acceptance. */
  next_attempt_at: number | null
  /** The finite wall-clock elapsed deadline from acceptance, fixed once
   *  at INSERT time — mirrors `retry_episode.max_elapsed_ms`'s role but
   *  stored as an absolute time since a delivery has no separate
   *  "episode start" from its own acceptance. */
  deadline_at: number | null
  version: number
  time_created: number
  time_updated: number
}

/**
 * A durably accepted human answer awaiting confirmed delivery into its
 * run's live session — the confirmation-of-effect split
 * harden-interactive-answer-delivery adds ahead of the runner prompt:
 * acceptance (this row) commits BEFORE the side effect, delivery
 * confirmation clears the question only after the runner accepts it.
 */
export interface AnswerDeliveryRecord {
  readonly id: string
  readonly featureId: string
  readonly runId: string
  readonly jobId: string
  readonly stepId: string
  /** The asking run's `asked_at` at acceptance — identifies which
   *  question this delivery answers (a run has no explicit generation
   *  counter; `asked_at` already changes each time a new question is
   *  parked). */
  readonly questionGeneration: number
  readonly notes: string
  readonly targetSessionId: string | null
  /** Conductor-generated idempotency marker carried into the prompt. */
  readonly deliveryToken: string
  readonly status: AnswerDeliveryStatus
  readonly failureDetail: string | null
  readonly claimedAt: number | null
  readonly leaseExpiresAt: number | null
  readonly attemptCount: number
  readonly nextAttemptAt: number | null
  readonly deadlineAt: number | null
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

function toAnswerDeliveryRecord(row: AnswerDeliveryRow): AnswerDeliveryRecord {
  return {
    id: row.id,
    featureId: row.feature_id,
    runId: row.run_id,
    jobId: row.job_id,
    stepId: row.step_id,
    questionGeneration: row.question_generation,
    notes: row.notes,
    targetSessionId: row.target_session_id,
    deliveryToken: row.delivery_token,
    status: row.status,
    failureDetail: row.failure_detail,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    deadlineAt: row.deadline_at,
    version: row.version,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

// --------------------------------------------------------------- recovery dispatch

export type RecoveryDispatchStatus = "unhandled" | "handled"

interface RecoveryDispatchRow {
  id: string
  feature_id: string
  job_id: string
  step_id: string
  status: RecoveryDispatchStatus
  time_created: number
  time_updated: number
}

/**
 * A durable dispatch-intent row for one operator-recovered target — the
 * run-less counterpart of the `run.completion_decisions` outbox. Written
 * in the SAME transaction as `recoverStepTargets`'s DAG repair, so a
 * crash between "feature flipped to running" and "the recovered step's
 * run/wait actually got created" leaves a durable trace the reconciler
 * can replay instead of a `running` feature with no anchor at all.
 */
export interface RecoveryDispatchRecord {
  readonly id: string
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly status: RecoveryDispatchStatus
  readonly createdAt: number
  readonly updatedAt: number
}

function toRecoveryDispatchRecord(row: RecoveryDispatchRow): RecoveryDispatchRecord {
  return {
    id: row.id,
    featureId: row.feature_id,
    jobId: row.job_id,
    stepId: row.step_id,
    status: row.status,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

export type AcceptAnswerResult =
  | { readonly kind: "accepted"; readonly delivery: AnswerDeliveryRecord }
  | { readonly kind: "already_accepted" }
  | { readonly kind: "not_asking" }
  | { readonly kind: "run_not_active" }

/**
 * `Store.confirmAnswerDelivered`'s discriminated outcome (review fix):
 * `confirmed` is the normal effect-confirmed success; `stale_superseded`
 * is the atomically-cancelled-instead-of-confirmed outcome when the
 * run's open question moved on before this delivery could be confirmed
 * (see the method's doc comment); `not_claimed` covers every other
 * reason the guard failed (delivery no longer claimed, run no longer
 * running, or a repeat call racing an earlier winner).
 */
export type ConfirmAnswerDeliveredResult =
  | { readonly kind: "confirmed" }
  | { readonly kind: "stale_superseded" }
  | { readonly kind: "not_claimed" }

export class Store {
  private readonly changeListeners = new Set<(change: StoreChange) => void>()
  /** run id → last run_log emission time; throttles run_log notifications at the source. */
  private readonly runLogEmits = new Map<string, number>()

  constructor(
    private readonly db: Database,
    private readonly clock: { now(): number } = { now: () => Date.now() },
  ) {}

  /**
   * Subscribe to post-commit change notifications. Listeners fire AFTER
   * the mutating transaction has committed — a notified subscriber
   * refetching over the same store always observes the new state. A
   * throwing listener is swallowed: observation must never break a
   * state transition that is already durable.
   */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private emit(change: StoreChange): void {
    for (const listener of this.changeListeners) {
      try {
        listener(change)
      } catch {
        // Listeners are projections; a broken one never blocks the store.
      }
    }
  }

  createFeature(input: CreateFeatureInput): FeatureState {
    const now = Date.now()
    const state = initialFeatureState({ ...input, id: randomUUID() })
    this.db.run(
      `INSERT INTO feature (id, slug, project_dir, title, workflow, description, status, pr, escalation, state, feedback, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        state.id,
        state.slug,
        state.projectDir,
        state.title,
        state.workflow,
        state.description,
        state.status,
        state.pr,
        null,
        JSON.stringify(state),
        null,
        now,
        now,
      ],
    )
    this.emit({ kind: "feature", featureId: state.id })
    return state
  }

  getFeature(id: string): FeatureState | null {
    const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(id) as FeatureRow | null
    return row ? toFeatureState(row) : null
  }

  /** Feedback snapshot attached by the most recent rerun transition, if any. */
  getFeedback(id: string): Feedback | null {
    const row = this.db.query("SELECT feedback FROM feature WHERE id = ?").get(id) as { feedback: string | null } | null
    return row?.feedback ? (JSON.parse(row.feedback) as Feedback) : null
  }

  listFeatures(filter?: FeatureFilter): FeatureState[] {
    return this.listFeatureRecords(filter).map(record => record.state)
  }

  /** Feature state plus row timestamps — the API's projection read. */
  getFeatureRecord(id: string): FeatureRecord | null {
    const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(id) as FeatureRow | null
    return row ? toFeatureRecord(row) : null
  }

  listFeatureRecords(filter?: FeatureFilter): FeatureRecord[] {
    const { where, params } = featureWhere(filter)
    const rows = this.db.query(`SELECT * FROM feature ${where} ORDER BY time_created DESC`).all(...params) as FeatureRow[]
    return rows.map(toFeatureRecord)
  }

  findFeatureByPr(pr: number): FeatureState | null {
    const row = this.db.query("SELECT * FROM feature WHERE pr = ? AND status NOT IN ('done','abandoned')").get(pr) as FeatureRow | null
    return row ? toFeatureState(row) : null
  }

  /** Escalation reason, tracked outside the core `FeatureState` shape. Null when not escalated. */
  getEscalation(id: string): string | null {
    const row = this.db.query("SELECT escalation FROM feature WHERE id = ?").get(id) as { escalation: string | null } | null
    return row?.escalation ?? null
  }

  /**
   * Applies a `Transition`'s patch to the feature's persisted graph
   * state and appends the audit row in ONE transaction: the invariant
   * every restart-recovery/duplicate-report guarantee depends on.
   */
  applyTransition(featureId: string, event: PipelineEvent, transition: Transition): void {
    this.db.transaction(() => this.applyTransitionTx(featureId, event, transition))()
    this.emit({ kind: "transition", featureId })
  }

  /**
   * Reconciliation repair for legacy stranded records: a feature whose
   * every job is terminal with at least one failure cannot reach
   * `escalated` through any interpreter event (there is no running step
   * left to fail), yet must not stay falsely `running`. This marks it
   * escalated with the invariant reason and appends an audit entry —
   * the only I/O repair path that bypasses the pure interpreter, and it
   * is only invoked by the reconciler when the invariant check reports
   * a stranded feature.
   */
  markEscalated(featureId: string, reason: string): boolean {
    const now = Date.now()
    const changed = this.db.transaction(() => {
      const row = this.db.query("SELECT status, state FROM feature WHERE id = ?").get(featureId) as { status: string; state: string } | null
      if (!row || row.status === "escalated" || row.status === "done" || row.status === "abandoned") return false
      const stateObj = JSON.parse(row.state) as Record<string, unknown>
      stateObj["status"] = "escalated"
      this.db.run(
        "UPDATE feature SET status = ?, escalation = ?, state = ?, time_updated = ? WHERE id = ?",
        ["escalated", reason, JSON.stringify(stateObj), now, featureId],
      )
      this.db.run(
        "INSERT INTO transition_log (feature_id, event, decisions, time_created) VALUES (?, ?, ?, ?)",
        [featureId, JSON.stringify({ kind: "reconcile.repair" }), JSON.stringify([{ kind: "escalate", reason }]), now],
      )
      return true
    })()
    if (changed) this.emit({ kind: "transition", featureId })
    return changed
  }

  setFeatureStatus(featureId: string, status: FeatureStatus): boolean {
    const now = Date.now()
    const changed = this.db.transaction(() => {
      const row = this.db.query("SELECT status, state FROM feature WHERE id = ?").get(featureId) as { status: string; state: string } | null
      if (!row || row.status === status) return false
      const stateObj = JSON.parse(row.state) as Record<string, unknown>
      stateObj["status"] = status
      this.db.run(
        "UPDATE feature SET status = ?, state = ?, time_updated = ?, escalation = NULL WHERE id = ?",
        [status, JSON.stringify(stateObj), now, featureId],
      )
      return true
    })()
    if (changed) this.emit({ kind: "transition", featureId })
    return changed
  }

  /**
   * Operator recovery: put the recovered targets back into a consistent
   * DAG shape so completions land and the cascade can resume. Each
   * target job goes back to running with its step as currentStep (the
   * interpreter's completion guard requires `currentStep === stepId` —
   * without this the recovered run's conclusion is "stale" and dropped)
   * and its attempt counter resets to 0 so the interpreter's budget
   * check starts a fresh episode instead of counting toward the
   * exhausted one (retry-budget spec: "the selected failed step
   * receives a new finite budget"). Jobs skipped by the original
   * failure cascade reset to pending so the cascade re-evaluates them
   * when the recovered jobs conclude.
   *
   * The status/version/idempotency guards that used to run as engine
   * preflight checks are authoritative HERE, inside the same
   * transaction as the mutation: a racing duplicate delivery or a
   * status/version that moved between the engine's read and this call
   * is caught atomically instead of leaving a window where two callers
   * both pass the preflight and both mutate. The engine may still run
   * its own preflight for a fast, cheap rejection message — this
   * transaction is what actually decides.
   */
  recoverStepTargets(
    featureId: string,
    targets: readonly { jobId: string; stepId: string }[],
    options: { readonly expectedVersion?: number; readonly idempotencyKey?: string } = {},
  ): "recovered" | "duplicate" | "stale_version" | "not_escalated" | "not_found" {
    const now = Date.now()
    let featureIdForEmit: string | null = null
    const result = this.db.transaction((): "recovered" | "duplicate" | "stale_version" | "not_escalated" | "not_found" => {
      const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(featureId) as FeatureRow | null
      if (!row || targets.length === 0) return "not_found"
      if (options.idempotencyKey !== undefined && this.hasRecoverKey(featureId, options.idempotencyKey)) return "duplicate"
      if (row.status !== "escalated") return "not_escalated"
      if (options.expectedVersion !== undefined && options.expectedVersion !== row.time_updated) return "stale_version"

      const state = toFeatureState(row)
      const jobs: Record<string, JobRuntime> = { ...state.jobs }
      const appliedTargets: { jobId: string; stepId: string }[] = []
      for (const target of targets) {
        const runtime = jobs[target.jobId]
        if (!runtime) continue
        const { [target.stepId]: _dropped, ...remainingAttempts } = runtime.attempts
        const { [target.stepId]: _droppedReruns, ...remainingReruns } = runtime.reruns
        jobs[target.jobId] = {
          ...runtime,
          status: "running",
          currentStep: target.stepId,
          attempts: remainingAttempts,
          reruns: remainingReruns,
          steps: { ...runtime.steps, [target.stepId]: { status: "running", outputs: {} } },
        }
        appliedTargets.push(target)
      }
      for (const [jobId, runtime] of Object.entries(jobs)) {
        if (runtime.status === "skipped") {
          jobs[jobId] = { ...runtime, status: "pending", currentStep: null, outputs: {}, steps: {} }
        }
      }
      const next: FeatureState = { ...state, status: "running", jobs }
      this.db.run(
        "UPDATE feature SET status = 'running', escalation = NULL, state = ?, time_updated = ? WHERE id = ?",
        [JSON.stringify(next), now, featureId],
      )
      this.db.run(
        "INSERT INTO transition_log (feature_id, event, decisions, time_created) VALUES (?, ?, ?, ?)",
        [
          featureId,
          JSON.stringify({ kind: "human.recovered", ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}) }),
          JSON.stringify(targets.map(target => ({ kind: "execute_step", jobId: target.jobId, stepId: target.stepId }))),
          now,
        ],
      )
      // Durable dispatch intent for each recovered target, in the SAME
      // commit as the DAG repair above — see `RecoveryDispatchRecord`'s
      // doc comment. A crash right after this transaction still leaves
      // this row for the reconciler to replay instead of a `running`
      // feature with no anchor at all.
      for (const target of appliedTargets) {
        this.db.run(
          `INSERT INTO recovery_dispatch (id, feature_id, job_id, step_id, status, time_created, time_updated)
           VALUES (?, ?, ?, ?, 'unhandled', ?, ?)`,
          [randomUUID(), featureId, target.jobId, target.stepId, now, now],
        )
      }
      featureIdForEmit = featureId
      return "recovered"
    })()
    if (featureIdForEmit !== null) this.emit({ kind: "transition", featureId: featureIdForEmit })
    return result
  }

  /** Whether a recover with this idempotency key already committed for
   *  the feature — the dedup read for retried recover deliveries. */
  hasRecoverKey(featureId: string, idempotencyKey: string): boolean {
    const rows = this.db.query(
      `SELECT event FROM transition_log WHERE feature_id = ? AND event LIKE '%"human.recovered"%'`,
    ).all(featureId) as Array<{ event: string }>
    for (const row of rows) {
      try {
        const event = JSON.parse(row.event) as { kind?: string; idempotencyKey?: string }
        if (event.kind === "human.recovered" && event.idempotencyKey === idempotencyKey) return true
      } catch {
        // Malformed legacy row — never blocks a recover.
      }
    }
    return false
  }

  /** Every unhandled recovery-dispatch row for a feature — what the
   *  reconciler replays before the active-state invariant check runs. */
  getUnhandledRecoveryDispatches(featureId: string): RecoveryDispatchRecord[] {
    const rows = this.db.query(
      `SELECT * FROM recovery_dispatch WHERE feature_id = ? AND status = 'unhandled' ORDER BY time_created ASC`,
    ).all(featureId) as RecoveryDispatchRow[]
    return rows.map(toRecoveryDispatchRecord)
  }

  /** Atomic 0→1 claim, same shape as `markRunActionHandled`: false if the
   *  row was never unhandled or another caller already closed it out. */
  markRecoveryDispatchHandled(id: string): boolean {
    return this.db.run(
      "UPDATE recovery_dispatch SET status = 'handled', time_updated = ? WHERE id = ? AND status = 'unhandled'",
      [Date.now(), id],
    ).changes > 0
  }

  private applyTransitionTx(featureId: string, event: PipelineEvent, transition: Transition): void {
    const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(featureId) as FeatureRow | null
    if (!row) throw new Error(`conductor: feature ${featureId} not found`)
    const current = toFeatureState(row)
    const patched = applyPatch(current, transition.patch)
    const next = this.withAggregateHumanAttention(featureId, patched)
    const now = Date.now()
    const escalation = transition.patch.status === "escalated"
      ? escalationReason(transition.decisions)
      : (transition.patch.status !== undefined ? null : undefined)

    const sets: string[] = ["time_updated = ?", "state = ?"]
    const params: (string | number | null)[] = [now, JSON.stringify(next)]
    if (next.status !== current.status || transition.patch.status !== undefined) {
      sets.push("status = ?")
      params.push(next.status)
    }
    if (escalation !== undefined) {
      sets.push("escalation = ?")
      params.push(escalation)
    }
    if (transition.feedback !== undefined) {
      sets.push("feedback = ?")
      params.push(JSON.stringify(transition.feedback))
    }
    // Pause-time accounting (design.md: "budget clocks store accumulated
    // paused duration"): the ONLY place a feature's status flips
    // paused↔other, so it is the single source of truth for both edges
    // of the span — entering sets `paused_at`, leaving folds the closed
    // span into the feature's CUMULATIVE `paused_ms`. Retry-episode
    // budget math reads this cumulative total directly (via
    // `getFeaturePausedMsAsOf`/`RetryEpisodeRecord.featurePausedMsAtStart`)
    // rather than folding the span into any per-episode column — a
    // per-episode fold only ever covered spans while an episode was
    // OPEN (`scheduled`/`claimed`), silently losing every pause during
    // an executing attempt (no open row to fold into). The feature's
    // own cumulative total has no such gap: every pause↔resume edge
    // updates it here, unconditionally, regardless of what episode is
    // or isn't open at the time.
    if (next.status !== current.status) {
      if (next.status === "paused" && row.paused_at === null) {
        sets.push("paused_at = ?")
        params.push(now)
      } else if (current.status === "paused" && row.paused_at !== null) {
        sets.push("paused_at = NULL", "paused_ms = ?")
        params.push(accumulatePausedMs(row.paused_ms, row.paused_at, now))
      }
    }
    params.push(featureId)
    this.db.run(`UPDATE feature SET ${sets.join(", ")} WHERE id = ?`, params as never)
    this.db.run(
      `INSERT INTO transition_log (feature_id, event, decisions, time_created)
       VALUES (?, ?, ?, ?)`,
      [featureId, JSON.stringify(event), JSON.stringify(transition.decisions), now],
    )
  }

  private withAggregateHumanAttention(featureId: string, state: FeatureState): FeatureState {
    if (state.status === "done" || state.status === "abandoned" || state.status === "escalated" || state.status === "paused") {
      return state
    }
    const pendingQuestion = this.db.query(
      "SELECT 1 FROM run WHERE feature_id = ? AND status = 'running' AND pending_question IS NOT NULL LIMIT 1",
    ).get(featureId) !== null
    const status: FeatureStatus = hasWaitingHumanStep(state) || pendingQuestion ? "waiting_human" : "running"
    return status === state.status ? state : { ...state, status }
  }

  /** Pause-time accounting for a feature — null if the feature does not exist. */
  getPauseAccounting(featureId: string): PauseAccounting | null {
    const row = this.db.query("SELECT paused_at, paused_ms FROM feature WHERE id = ?").get(featureId) as
      | { paused_at: number | null; paused_ms: number }
      | null
    return row ? toPauseAccounting(row) : null
  }

  /**
   * The feature's cumulative pause total AS OF `nowMs`, including any
   * currently OPEN pause span (`paused_at` set, not yet folded into
   * `paused_ms`) — retry-episode budget math needs "elapsed excludes
   * ALL paused time", including a span still in progress at the moment
   * a schedule/claim decision is made, not merely spans already closed
   * by a resume. Null if the feature does not exist.
   */
  getFeaturePausedMsAsOf(featureId: string, nowMs: number): number | null {
    const row = this.db.query("SELECT paused_at, paused_ms FROM feature WHERE id = ?").get(featureId) as
      | { paused_at: number | null; paused_ms: number }
      | null
    if (!row) return null
    return row.paused_at !== null ? accumulatePausedMs(row.paused_ms, row.paused_at, nowMs) : row.paused_ms
  }

  setFeatureFields(id: string, fields: Partial<{ sessionId: string | null; pr: number | null }>): void {
    const current = this.getFeature(id)
    if (!current) return
    const next: FeatureState = {
      ...current,
      ...("sessionId" in fields ? { sessionId: fields.sessionId ?? null } : {}),
      ...("pr" in fields ? { pr: fields.pr ?? null } : {}),
    }
    const sets: string[] = ["time_updated = ?", "state = ?"]
    const params: (string | number | null)[] = [Date.now(), JSON.stringify(next)]
    if ("pr" in fields) {
      sets.push("pr = ?")
      params.push(next.pr)
    }
    params.push(id)
    this.db.run(`UPDATE feature SET ${sets.join(", ")} WHERE id = ?`, params as never)
    this.emit({ kind: "feature", featureId: id })
  }

  /** Merge named outputs into a step's runtime record (used for the
   *  reserved gate `prompt` output, written when a gate arms). */
  mergeStepOutputs(featureId: string, jobId: string, stepId: string, outputs: Readonly<Record<string, string>>): void {
    const current = this.getFeature(featureId)
    if (!current) return
    const job = current.jobs[jobId]
    if (!job) return
    const step = job.steps[stepId] ?? { status: "pending" as const, outputs: {} }
    const next: FeatureState = {
      ...current,
      jobs: {
        ...current.jobs,
        [jobId]: {
          ...job,
          steps: { ...job.steps, [stepId]: { ...step, outputs: { ...step.outputs, ...outputs } } },
        },
      },
    }
    this.db.run("UPDATE feature SET time_updated = ?, state = ? WHERE id = ?", [Date.now(), JSON.stringify(next), featureId])
    this.emit({ kind: "feature", featureId })
  }

  // ------------------------------------------------------------- interactive steps (questions)

  /**
   * Park a running agent run on a human question. Persists the question
   * text, flips the owning feature to `waiting_human` and logs a
   * transition so the timeline stays honest. Guarded by `status = 'running'`.
   * Returns false when the run already concluded — the caller must not
   * park it.
   */
  setRunQuestion(runId: string, question: string): boolean {
    let featureId: string | null = null
    const ok = this.db.transaction(() => {
      const run = this.db.query("SELECT * FROM run WHERE id = ?").get(runId) as RunRow | undefined
      if (!run || run.status !== "running") return false
      featureId = run.feature_id
      const now = Date.now()
      this.db.run(
        "UPDATE run SET pending_question = ?, asked_at = ?, time_last_activity = ? WHERE id = ?",
        [question, now, now, runId],
      )
      const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(run.feature_id) as FeatureRow | null
      if (!row) return false
      const next = this.withAggregateHumanAttention(run.feature_id, toFeatureState(row))
      this.db.run("UPDATE feature SET time_updated = ?, state = ?, status = ? WHERE id = ?", [now, JSON.stringify(next), next.status, run.feature_id])
      this.db.run(
        "INSERT INTO transition_log (feature_id, event, decisions, time_created) VALUES (?, ?, ?, ?)",
        [run.feature_id, JSON.stringify({ kind: "run.ask", runId, jobId: run.job_id, stepId: run.step_id }), "[]", now],
      )
      return true
    })()
    if (ok && featureId !== null) this.emit({ kind: "feature", featureId })
    return ok
  }

  /**
   * Clear a pending question after the human answers. The feature returns
   * to `running`; the caller is responsible for forwarding the answer into
   * the session.
   */
  clearRunQuestion(runId: string): boolean {
    let featureId: string | null = null
    const ok = this.db.transaction(() => {
      const run = this.db.query("SELECT * FROM run WHERE id = ?").get(runId) as RunRow | undefined
      if (!run || run.status !== "running" || run.pending_question === null) return false
      featureId = run.feature_id
      const now = Date.now()
      this.db.run("UPDATE run SET pending_question = NULL, asked_at = NULL, time_last_activity = ? WHERE id = ?", [now, runId])
      const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(run.feature_id) as FeatureRow | null
      if (!row) return false
      const next = this.withAggregateHumanAttention(run.feature_id, toFeatureState(row))
      this.db.run("UPDATE feature SET time_updated = ?, state = ?, status = ? WHERE id = ?", [now, JSON.stringify(next), next.status, run.feature_id])
      this.db.run(
        "INSERT INTO transition_log (feature_id, event, decisions, time_created) VALUES (?, ?, ?, ?)",
        [run.feature_id, JSON.stringify({ kind: "run.answer", runId, jobId: run.job_id, stepId: run.step_id }), "[]", now],
      )
      return true
    })()
    if (ok && featureId !== null) this.emit({ kind: "feature", featureId })
    return ok
  }

  // ------------------------------------------------------------- interactive steps (answer delivery)

  /**
   * Accepts a human answer for an asking run as a durable delivery
   * record, BEFORE any runner side effect is attempted — the acceptance
   * half of harden-interactive-answer-delivery's confirmation-of-effect
   * split. Guarded, in ONE transaction: the run is still `running`
   * (`run_not_active` otherwise), it still has a pending question
   * (`not_asking` otherwise), and no other non-terminal delivery already
   * exists for it (`already_accepted` otherwise — a second concurrent or
   * repeated answer request for the same accepted-pending question is
   * rejected, never replaces notes, never becomes a second delivery).
   * `pending_question` is deliberately left untouched: the feature stays
   * `waiting_human` (aggregate human attention still sees the
   * outstanding question) until confirmed delivery clears it.
   */
  acceptAnswer(runId: string, notes: string): AcceptAnswerResult {
    const now = Date.now()
    let featureId: string | null = null
    const result = this.db.transaction((): AcceptAnswerResult => {
      const run = this.db.query("SELECT * FROM run WHERE id = ?").get(runId) as RunRow | undefined
      if (!run || run.status !== "running") return { kind: "run_not_active" }
      if (run.pending_question === null) return { kind: "not_asking" }
      const existing = this.db.query(
        "SELECT 1 FROM answer_delivery WHERE run_id = ? AND status IN ('pending','claimed') LIMIT 1",
      ).get(runId)
      if (existing) return { kind: "already_accepted" }
      const id = randomUUID()
      const deliveryToken = randomUUID()
      // The finite elapsed deadline for bounded delivery retries is fixed
      // NOW, from acceptance — the class-default transient-retry budget
      // (`DEFAULT_RETRY_BUDGET`, the same conservative-finite default
      // `retry-policy.ts` applies to a step's transient weather classes)
      // bounds how long a persistently unreachable session/runner may
      // keep this delivery pending before it routes through normal run
      // failure instead of retrying forever.
      const deadlineAt = now + DEFAULT_RETRY_BUDGET.maxElapsedMs
      const row = this.db.query(
        `INSERT INTO answer_delivery (
           id, feature_id, run_id, job_id, step_id, question_generation, notes,
           target_session_id, delivery_token, status, attempt_count, next_attempt_at, deadline_at,
           version, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, 0, ?, ?)
         RETURNING *`,
      ).get(
        id, run.feature_id, runId, run.job_id, run.step_id, run.asked_at ?? 0, notes,
        run.session_id, deliveryToken, deadlineAt, now, now,
      ) as AnswerDeliveryRow
      this.db.run(
        "INSERT INTO transition_log (feature_id, event, decisions, time_created) VALUES (?, ?, ?, ?)",
        [run.feature_id, JSON.stringify({ kind: "run.answer_accepted", runId, jobId: run.job_id, stepId: run.step_id }), "[]", now],
      )
      featureId = run.feature_id
      return { kind: "accepted", delivery: toAnswerDeliveryRecord(row) }
    })()
    if (result.kind === "accepted" && featureId !== null) this.emit({ kind: "transition", featureId })
    return result
  }

  getAnswerDelivery(deliveryId: string): AnswerDeliveryRecord | null {
    const row = this.db.query("SELECT * FROM answer_delivery WHERE id = ?").get(deliveryId) as AnswerDeliveryRow | null
    return row ? toAnswerDeliveryRecord(row) : null
  }

  /** The current non-terminal (pending/claimed) delivery for a run, if any. */
  getOpenAnswerDelivery(runId: string): AnswerDeliveryRecord | null {
    const row = this.db.query(
      "SELECT * FROM answer_delivery WHERE run_id = ? AND status IN ('pending','claimed')",
    ).get(runId) as AnswerDeliveryRow | null
    return row ? toAnswerDeliveryRecord(row) : null
  }

  /**
   * Every delivery due for a (re)attempt: freshly `pending` (or a
   * `pending` row scheduled by `scheduleAnswerDeliveryRetry` whose
   * `next_attempt_at` backoff has elapsed), or `claimed` with an expired
   * lease (a crashed claimant's attempt never confirmed or failed it) —
   * EXCLUDING any feature currently `paused`, mirroring the pause
   * scheduling barrier `listDueRetryEpisodes`/`listDueResourceWaits`
   * already enforce: the runner prompt side effect is never attempted
   * while paused (design.md amendment: pause blocks the immediate/
   * reconcile delivery attempt, not acceptance). A lease-expired
   * `claimed` row is always due regardless of `next_attempt_at` — that
   * column only paces a scheduled RETRY of a `pending` row, never a
   * crash-recovery reclaim.
   */
  listPendingAnswerDeliveries(nowMs: number, limit = 50): AnswerDeliveryRecord[] {
    const rows = this.db.query(
      `SELECT answer_delivery.* FROM answer_delivery
       JOIN feature ON feature.id = answer_delivery.feature_id
       WHERE (
         (answer_delivery.status = 'pending' AND (answer_delivery.next_attempt_at IS NULL OR answer_delivery.next_attempt_at <= ?))
         OR (answer_delivery.status = 'claimed' AND answer_delivery.lease_expires_at <= ?)
       )
       AND feature.status != 'paused'
       ORDER BY answer_delivery.time_created ASC LIMIT ?`,
    ).all(nowMs, nowMs, limit) as AnswerDeliveryRow[]
    return rows.map(toAnswerDeliveryRecord)
  }

  /**
   * Atomically claims one due, unpaused delivery: `pending` (whose
   * scheduled backoff, if any, has elapsed) or a lease-expired `claimed`
   * row → `claimed` with a fresh lease. Two concurrent claimants (an
   * immediate `Engine.answer` attempt racing a reconcile pass, or two
   * reconcile passes) resolve to exactly one winner — the loser sees
   * zero rows affected and gets `null`.
   */
  claimAnswerDelivery(deliveryId: string, nowMs: number, leaseMs: number): AnswerDeliveryRecord | null {
    const row = this.db.query(
      `UPDATE answer_delivery SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, version = version + 1, time_updated = ?
       WHERE id = (
         SELECT answer_delivery.id FROM answer_delivery
         JOIN feature ON feature.id = answer_delivery.feature_id
         WHERE answer_delivery.id = ?
           AND (
             (answer_delivery.status = 'pending' AND (answer_delivery.next_attempt_at IS NULL OR answer_delivery.next_attempt_at <= ?))
             OR (answer_delivery.status = 'claimed' AND answer_delivery.lease_expires_at <= ?)
           )
           AND feature.status != 'paused'
       )
       RETURNING *`,
    ).get(nowMs, nowMs + leaseMs, nowMs, deliveryId, nowMs, nowMs) as AnswerDeliveryRow | null
    return row ? toAnswerDeliveryRecord(row) : null
  }

  /**
   * Bounded transient-failure release (review fix: replaces an unbounded
   * immediate-retry-forever release): returns a claimed delivery to
   * `pending`, but — unlike `releaseAnswerDelivery` — increments
   * `attempt_count` and sets `next_attempt_at` to the caller-computed
   * backoff schedule instead of making it immediately due again. The
   * caller (`Engine.attemptAnswerDelivery`) computes that schedule from
   * the SAME `behaviourForClass`/`computeScheduledDelayMs` core
   * primitives a step's own transient retries use — this method only
   * persists the result. Guarded by the delivery still being `claimed`;
   * a delivery concluded/superseded in the gap returns false and the
   * caller's schedule is simply discarded (nothing left to reschedule).
   */
  scheduleAnswerDeliveryRetry(deliveryId: string, nextAttemptAtMs: number): boolean {
    return this.db.run(
      `UPDATE answer_delivery
       SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL,
           attempt_count = attempt_count + 1, next_attempt_at = ?, version = version + 1, time_updated = ?
       WHERE id = ? AND status = 'claimed'`,
      [nextAttemptAtMs, Date.now(), deliveryId],
    ).changes > 0
  }

  /** Releases a claimed delivery back to `pending` immediately (a transient
   *  prompt failure) instead of waiting out the full lease — the next
   *  claim (immediate or reconcile) can retry right away. No-op-safe: a
   *  delivery no longer `claimed` returns false. */
  releaseAnswerDelivery(deliveryId: string): boolean {
    return this.db.run(
      "UPDATE answer_delivery SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL, version = version + 1, time_updated = ? WHERE id = ? AND status = 'claimed'",
      [Date.now(), deliveryId],
    ).changes > 0
  }

  /**
   * Confirms a claimed delivery's runner prompt succeeded: marks the
   * delivery `delivered`, clears the run's pending question, recalculates
   * aggregate human attention and records the answer transition — all in
   * ONE transaction, the effect-confirmed counterpart of `clearRunQuestion`.
   * Guarded by the delivery still being `claimed` and its run still
   * `running`: a delivery whose run concluded meanwhile returns
   * `not_claimed` instead of resurrecting stale state.
   *
   * Review fix: also guarded by the run's CURRENT open question still
   * being the exact one this delivery answers — `run.asked_at` (refreshed
   * by every `setRunQuestion` call) must still equal
   * `delivery.question_generation`, AND a question must still be pending
   * at all. Without this check, a delivery claimed for question N whose
   * confirmation lands AFTER the agent has already asked question N+1
   * (e.g. the at-least-once redelivered prompt itself prompted a NEW
   * ask before this call ran) would blindly clear `pending_question`/
   * `asked_at` and destroy the NEWER, still-unanswered question. On a
   * mismatch this atomically cancels the now-stale delivery — same
   * terminal disposition `cancelAnswerDelivery` uses, but folded into
   * this same transaction so the check-and-cancel is atomic — and
   * returns `stale_superseded` WITHOUT touching the run's newer question.
   */
  confirmAnswerDelivered(deliveryId: string): ConfirmAnswerDeliveredResult {
    let featureId: string | null = null
    const result = this.db.transaction((): ConfirmAnswerDeliveredResult => {
      const delivery = this.db.query("SELECT * FROM answer_delivery WHERE id = ? AND status = 'claimed'").get(deliveryId) as AnswerDeliveryRow | undefined
      if (!delivery) return { kind: "not_claimed" }
      const run = this.db.query("SELECT * FROM run WHERE id = ? AND status = 'running'").get(delivery.run_id) as RunRow | undefined
      if (!run) return { kind: "not_claimed" }
      const now = Date.now()
      if (run.pending_question === null || run.asked_at !== delivery.question_generation) {
        this.db.run(
          "UPDATE answer_delivery SET status = 'cancelled', failure_detail = ?, version = version + 1, time_updated = ? WHERE id = ?",
          [boundDiagnostic("the run's question was superseded before this delivery could be confirmed"), now, deliveryId],
        )
        return { kind: "stale_superseded" }
      }
      this.db.run("UPDATE run SET pending_question = NULL, asked_at = NULL, time_last_activity = ? WHERE id = ?", [now, run.id])
      this.db.run(
        "UPDATE answer_delivery SET status = 'delivered', version = version + 1, time_updated = ? WHERE id = ?",
        [now, deliveryId],
      )
      const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(run.feature_id) as FeatureRow | null
      if (!row) return { kind: "not_claimed" }
      const next = this.withAggregateHumanAttention(run.feature_id, toFeatureState(row))
      this.db.run("UPDATE feature SET time_updated = ?, state = ?, status = ? WHERE id = ?", [now, JSON.stringify(next), next.status, run.feature_id])
      this.db.run(
        "INSERT INTO transition_log (feature_id, event, decisions, time_created) VALUES (?, ?, ?, ?)",
        [run.feature_id, JSON.stringify({ kind: "run.answer", runId: run.id, jobId: run.job_id, stepId: run.step_id }), "[]", now],
      )
      featureId = run.feature_id
      return { kind: "confirmed" }
    })()
    if (result.kind === "confirmed" && featureId !== null) this.emit({ kind: "feature", featureId })
    return result
  }

  /**
   * Terminal delivery failure (confirmed missing session, terminal
   * prompt error): marks the delivery `failed` with a bounded
   * diagnostic, retaining `notes` for audit — the caller routes the run
   * through normal failure conclusion separately (retry/onFail
   * semantics apply there, not here). Guarded by the delivery still
   * being pending/claimed; a second terminal-failure call on an
   * already-terminal row is a no-op.
   */
  failAnswerDelivery(deliveryId: string, detail: string): boolean {
    return this.db.run(
      "UPDATE answer_delivery SET status = 'failed', failure_detail = ?, version = version + 1, time_updated = ? WHERE id = ? AND status IN ('pending','claimed')",
      [boundDiagnostic(detail), Date.now(), deliveryId],
    ).changes > 0
  }

  /**
   * Stale-target cancellation: the run concluded or its question was
   * superseded before this delivery could be attempted — retains `notes`
   * for audit, same as `failAnswerDelivery`, but under a distinct
   * disposition (this was never a delivery failure; the target simply
   * stopped accepting delivery).
   */
  cancelAnswerDelivery(deliveryId: string, reason: string): boolean {
    return this.db.run(
      "UPDATE answer_delivery SET status = 'cancelled', failure_detail = ?, version = version + 1, time_updated = ? WHERE id = ? AND status IN ('pending','claimed')",
      [boundDiagnostic(reason), Date.now(), deliveryId],
    ).changes > 0
  }

  listAnswerDeliveries(featureId: string): AnswerDeliveryRecord[] {
    const rows = this.db.query(
      "SELECT * FROM answer_delivery WHERE feature_id = ? ORDER BY time_created ASC",
    ).all(featureId) as AnswerDeliveryRow[]
    return rows.map(toAnswerDeliveryRecord)
  }

  insertRun(input: {
    featureId: string
    jobId: string
    stepId: string
    stepType: "agent" | "command" | "action"
    attempt: number
    sessionId?: string
    metadata?: RunActionMetadata
  }): string {
    const id = randomUUID()
    this.db.transaction(() => {
      // Snapshot the feature's CURRENT cumulative `paused_ms` at
      // dispatch time — the streak-anchor baseline a first attempt's
      // pause accounting needs (see `pausedMsAtDispatch`'s doc comment).
      // Read inside the same transaction as the insert so the snapshot
      // is exactly what was true the instant this run's row became
      // durable, never a value that could race a concurrent pause/resume.
      const feature = this.db.query("SELECT paused_ms FROM feature WHERE id = ?").get(input.featureId) as { paused_ms: number } | null
      const now = this.clock.now()
      this.db.run(
        `INSERT INTO run (id, feature_id, job_id, step_id, step_type, attempt, session_id, metadata, paused_ms_at_dispatch, time_started, time_last_activity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.featureId,
          input.jobId,
          input.stepId,
          input.stepType,
          input.attempt,
          input.sessionId ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          feature?.paused_ms ?? 0,
          now,
          now,
        ],
      )
    })()
    this.emit({ kind: "run", featureId: input.featureId })
    return id
  }

  finishRun(
    runId: string,
    status: "succeeded" | "failed" | "reaped",
    detail?: { outputs?: Readonly<Record<string, string>>; reason?: string; failure?: FailureEnvelope },
  ): void {
    this.db.run(
      "UPDATE run SET status = ?, outputs = ?, reason = ?, failure_class = ?, failure_source = ?, failure_retry_hint_ms = ?, time_finished = ? WHERE id = ?",
      [
        status,
        JSON.stringify(detail?.outputs ?? {}),
        detail?.reason ?? null,
        detail?.failure?.class ?? null,
        detail?.failure?.source ?? null,
        detail?.failure?.retryHintMs ?? null,
        Date.now(),
        runId,
      ],
    )
    const featureId = (this.db.query("SELECT feature_id FROM run WHERE id = ?").get(runId) as { feature_id: string } | null)?.feature_id
    if (featureId) this.emit({ kind: "run", featureId })
  }

  /**
   * Records a durable-pending action's next-observation policy on its run
   * row — the run stays `running`, no new row is inserted, and the
   * attempt counter is untouched. Guarded by `WHERE status = 'running'`:
   * if the run concluded meanwhile (e.g. TTL-reaped by a concurrent
   * reconcile pass), this returns false and the caller drops the
   * observation instead of resurrecting a finished run.
   */
  recordPendingObservation(runId: string, state: Readonly<Record<string, unknown>> | null, nextObservation: number): boolean {
    return this.db.run(
      "UPDATE run SET pending_state = ?, next_observation = ?, time_last_activity = ? WHERE id = ? AND status = 'running'",
      [state ? JSON.stringify(state) : null, nextObservation, this.clock.now(), runId],
    ).changes > 0
  }

  /**
   * Claims a run's session id — only while the run is still 'running'. A
   * run can be reaped (TTL, missing session) by the reconciler WHILE a
   * dispatch call is still awaiting session creation for it; when that
   * stale call finally resolves, this guard makes the claim a no-op (0
   * rows affected → false) instead of writing a session id onto an
   * already-concluded run row. Callers MUST check the return value and
   * skip prompting when it is false.
   */
  setRunSession(runId: string, sessionId: string): boolean {
    return this.db.run("UPDATE run SET session_id = ? WHERE id = ? AND status = 'running'", [sessionId, runId]).changes > 0
  }

  /**
   * Atomically concludes a run and applies the feature transition it
   * triggers: closes the crash window between "run finished" and
   * "feature advanced" by making both writes one transaction. The
   * `WHERE status = 'running'` guard is also the single point where a
   * duplicate report (e.g. an agent retries `report()` after a timeout)
   * is caught — the second call sees zero rows affected and returns
   * false without touching the feature or its transition log.
   *
   * Also persists `options.persistDecisions ?? transition.decisions` as
   * `completion_decisions` with `action_handled = 0` — a durable outbox
   * row. If the process crashes between this commit and the engine
   * acting on those decisions, a restarted reconciler can find and
   * finish them instead of leaving the feature stuck on its old current
   * step forever.
   *
   * Three optional pieces of follow-up work happen in the SAME
   * transaction, so a durable failed-run retry never has a crash window
   * between "run concluded" and "its retry disposition recorded" (the
   * atomicity this method exists for):
   *  - `options.followUp` applies a SECOND transition right after the
   *    main one (e.g. a `step.failed` immediately followed by the
   *    `step.budget_exhausted` route it degrades to) — both land in the
   *    transition log from this one commit.
   *  - `options.retrySchedule` calls `scheduleRetry` inside the SAME
   *    transaction the run conclusion and transition(s) commit in
   *    (durable-retries spec: "persist attempt count, budget start, last
   *    failure class/time, computed delay and `next_attempt_at` in the
   *    SAME transaction as the failed attempt's terminal state"). Its
   *    result (`null` when a racing episode already owns the target) is
   *    returned so the caller can decide whether to fall back to
   *    dispatching the kept decisions — callers of THIS retry path
   *    intentionally do not: the owning episode already fires on its own
   *    schedule, so no immediate dispatch is needed.
   */
  concludeRun(
    runId: string,
    status: "succeeded" | "failed" | "reaped",
    detail: { outputs?: Readonly<Record<string, string>>; reason?: string; failure?: FailureEnvelope } | undefined,
    event: PipelineEvent,
    transition: Transition,
    options?: {
      readonly persistDecisions?: readonly Decision[]
      readonly retrySchedule?: {
        readonly jobId: string
        readonly stepId: string
        readonly attempts: number
        readonly startedAt: number
        readonly pausedMs?: number
        readonly featurePausedMsAtStart?: number
        readonly nextAttemptAt: number
        readonly delayMs: number
        readonly scheduleSource: "backoff" | "retry_hint"
        readonly maxAttempts: number
        readonly maxElapsedMs: number
        readonly failure: FailureEnvelope
      }
      readonly followUp?: { readonly event: PipelineEvent; readonly transition: Transition }
    },
  ): { readonly claimed: boolean; readonly episode: RetryEpisodeRecord | null } {
    let featureId: string | null = null
    let episode: RetryEpisodeRecord | null = null
    const claimed = this.db.transaction(() => {
      const result = this.db.run(
        `UPDATE run SET status = ?, outputs = ?, reason = ?, failure_class = ?, failure_source = ?, failure_retry_hint_ms = ?,
                        completion_event = ?, completion_decisions = ?, action_handled = 0, time_finished = ?
         WHERE id = ? AND status = 'running'`,
        [
          status,
          JSON.stringify(detail?.outputs ?? {}),
          detail?.reason ?? null,
          detail?.failure?.class ?? null,
          detail?.failure?.source ?? null,
          detail?.failure?.retryHintMs ?? null,
          JSON.stringify(event),
          JSON.stringify(options?.persistDecisions ?? transition.decisions),
          Date.now(),
          runId,
        ],
      )
      if (result.changes === 0) return false
      const run = this.db.query("SELECT feature_id FROM run WHERE id = ?").get(runId) as { feature_id: string } | null
      if (!run) return false
      this.applyTransitionTx(run.feature_id, event, transition)
      if (options?.followUp) this.applyTransitionTx(run.feature_id, options.followUp.event, options.followUp.transition)
      if (options?.retrySchedule) {
        const schedule = options.retrySchedule
        episode = this.scheduleRetry({
          featureId: run.feature_id, jobId: schedule.jobId, stepId: schedule.stepId,
          attempts: schedule.attempts, startedAt: schedule.startedAt, pausedMs: schedule.pausedMs,
          featurePausedMsAtStart: schedule.featurePausedMsAtStart,
          nextAttemptAt: schedule.nextAttemptAt, delayMs: schedule.delayMs, scheduleSource: schedule.scheduleSource,
          maxAttempts: schedule.maxAttempts, maxElapsedMs: schedule.maxElapsedMs, failure: schedule.failure,
        })
      }
      featureId = run.feature_id
      return true
    })()
    if (claimed && featureId !== null) this.emit({ kind: "transition", featureId })
    return { claimed, episode }
  }

  /**
   * The latest concluded-but-unacted-on decisions for a feature — the
   * durable pending-action outbox `concludeRun` writes. Null once
   * `markRunActionHandled` closes it out (the normal, no-crash path) or
   * when nothing has ever concluded via `concludeRun` for this feature.
   */
  getPendingRunAction(featureId: string): { runId: string; decisions: readonly Decision[] } | null {
    const row = this.db.query(
      `SELECT id, completion_decisions FROM run
       WHERE feature_id = ? AND action_handled = 0 AND completion_decisions IS NOT NULL
       ORDER BY time_finished DESC LIMIT 1`,
    ).get(featureId) as { id: string; completion_decisions: string } | null
    if (!row) return null
    return { runId: row.id, decisions: JSON.parse(row.completion_decisions) as Decision[] }
  }

  /** Atomic 0→1 claim: false if the run was never pending or is already handled. */
  markRunActionHandled(runId: string): boolean {
    return this.db.run("UPDATE run SET action_handled = 1 WHERE id = ? AND action_handled = 0", [runId]).changes > 0
  }

  getActiveRun(featureId: string): RunSummary | null {
    const row = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? AND status = 'running' ORDER BY time_started DESC LIMIT 1`,
    ).get(featureId) as RunRow | null
    return row ? toRunSummary(row) : null
  }

  /** Every currently in-flight run for a feature — a DAG feature can have several at once (fan-out). */
  listActiveRuns(featureId: string): RunSummary[] {
    const rows = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? AND status = 'running' ORDER BY time_started ASC`,
    ).all(featureId) as RunRow[]
    return rows.map(toRunSummary)
  }

  /** The in-flight run (if any) for one exact job+step — used to detect a dispatch that never happened. */
  getActiveRunForStep(featureId: string, jobId: string, stepId: string): RunSummary | null {
    const row = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? AND job_id = ? AND step_id = ? AND status = 'running'
       ORDER BY time_started DESC LIMIT 1`,
    ).get(featureId, jobId, stepId) as RunRow | null
    return row ? toRunSummary(row) : null
  }

  listRuns(featureId: string, limit = 100): RunSummary[] {
    const rows = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? ORDER BY time_started DESC LIMIT ?`,
    ).all(featureId, limit) as RunRow[]
    return rows.map(toRunSummary)
  }

  incrementNudges(runId: string): number {
    this.db.run("UPDATE run SET nudges = nudges + 1, time_last_activity = ? WHERE id = ?", [this.clock.now(), runId])
    const row = this.db.query("SELECT nudges FROM run WHERE id = ?").get(runId) as { nudges: number } | null
    return row?.nudges ?? 0
  }

  /**
   * Marks a run as alive NOW — the reaper's activity clock. Called from
   * every write path that proves the run's session is doing something
   * (log ingestion, question flow, nudge sends). O(1) by PK; guarded to
   * running runs so late signals cannot resurrect a concluded row's
   * timestamp.
   */
  touchRunActivity(runId: string, time: number = this.clock.now()): void {
    this.db.run("UPDATE run SET time_last_activity = ? WHERE id = ? AND status = 'running'", [time, runId])
  }

  /**
   * Newest run id per (jobId, stepId) across a feature's WHOLE run
   * history — one grouped query, immune to any list limit. Backs the
   * detail projection's truncated-output pointer.
   */
  newestRunIdsByStep(featureId: string): ReadonlyMap<string, string> {
    // SQLite's bare-column-with-MAX() semantics: `id` comes from the row
    // holding the per-group MAX(time_started).
    const rows = this.db.query(
      `SELECT job_id, step_id, id, MAX(time_started) FROM run
       WHERE feature_id = ?
       GROUP BY job_id, step_id`,
    ).all(featureId) as Array<{ job_id: string; step_id: string; id: string }>
    const ids = new Map<string, string>()
    for (const row of rows) ids.set(`${row.job_id}\u0000${row.step_id}`, row.id)
    return ids
  }

  getRunById(runId: string): RunSummary | null {
    const row = this.db.query("SELECT * FROM run WHERE id = ?").get(runId) as RunRow | null
    return row ? toRunSummary(row) : null
  }

  // ------------------------------------------------------------- retry episodes

  scheduleRetry(input: {
    featureId: string
    jobId: string
    stepId: string
    attempts: number
    startedAt: number
    pausedMs?: number
    /** Streak-pause baseline (see `RetryEpisodeRecord.featurePausedMsAtStart`'s
     *  doc comment) — the caller (`planFailureDisposition`) computes this
     *  the SAME way it computes `startedAt`: inherited unchanged from the
     *  previous episode when chained, or the anchor run's own
     *  `pausedMsAtDispatch` for a genuinely first episode. Defaults to 0
     *  only for callers (tests) that don't care about pause accounting. */
    featurePausedMsAtStart?: number
    nextAttemptAt: number
    delayMs: number
    scheduleSource: "backoff" | "retry_hint"
    maxAttempts: number
    maxElapsedMs: number
    failure: FailureEnvelope
  }): RetryEpisodeRecord | null {
    const id = randomUUID()
    const now = Date.now()
    // The partial unique index on (feature_id, job_id, step_id) WHERE
    // status IN ('scheduled','claimed') enforces "one active attempt per
    // target" (design.md risk: "database uniqueness invariant for one
    // active attempt per target") — a caller racing another scheduler for
    // the same job+step loses this insert and gets null back instead of
    // a duplicate open episode.
    const row = this.db.query(
      `INSERT INTO retry_episode (
         id, feature_id, job_id, step_id, status, attempts, started_at, paused_ms, feature_paused_ms_at_start,
         next_attempt_at, delay_ms, schedule_source, max_attempts, max_elapsed_ms,
         last_failure_class, last_failure_source, last_failure_diagnostic, last_failure_retry_hint_ms, last_failure_at,
         version, time_created, time_updated
       ) VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (feature_id, job_id, step_id) WHERE status IN ('scheduled','claimed') DO NOTHING
       RETURNING *`,
    ).get(
      id, input.featureId, input.jobId, input.stepId,
      input.attempts, input.startedAt, input.pausedMs ?? 0, input.featurePausedMsAtStart ?? 0,
      input.nextAttemptAt, input.delayMs, input.scheduleSource, input.maxAttempts, input.maxElapsedMs,
      input.failure.class, input.failure.source, input.failure.diagnostic, input.failure.retryHintMs ?? null, now,
      now, now,
    ) as RetryEpisodeRow | null
    return row ? toRetryEpisodeRecord(row) : null
  }

  getOpenRetryEpisode(featureId: string, jobId: string, stepId: string): RetryEpisodeRecord | null {
    const row = this.db.query(
      `SELECT * FROM retry_episode WHERE feature_id = ? AND job_id = ? AND step_id = ? AND status IN ('scheduled','claimed')`,
    ).get(featureId, jobId, stepId) as RetryEpisodeRow | null
    return row ? toRetryEpisodeRecord(row) : null
  }

  getRetryEpisode(episodeId: string): RetryEpisodeRecord | null {
    const row = this.db.query("SELECT * FROM retry_episode WHERE id = ?").get(episodeId) as RetryEpisodeRow | null
    return row ? toRetryEpisodeRecord(row) : null
  }

  /**
   * Every `scheduled` episode whose `next_attempt_at` is due, EXCLUDING
   * any feature currently `paused` — the pause scheduling barrier
   * (durable-retries spec: "no attempt starts" during a pause) enforced
   * at the read that feeds claiming, not merely at claim time, so a
   * reconcile pass never even considers a paused feature's due work.
   */
  listDueRetryEpisodes(nowMs: number, limit = 50): RetryEpisodeRecord[] {
    const rows = this.db.query(
      `SELECT retry_episode.* FROM retry_episode
       JOIN feature ON feature.id = retry_episode.feature_id
       WHERE retry_episode.status = 'scheduled' AND retry_episode.next_attempt_at <= ?
         AND feature.status != 'paused'
       ORDER BY retry_episode.next_attempt_at ASC LIMIT ?`,
    ).all(nowMs, limit) as RetryEpisodeRow[]
    return rows.map(toRetryEpisodeRecord)
  }

  /**
   * Atomically claims one due, unpaused episode by id: `scheduled` →
   * `claimed`, guarded by the exact due time so a stale claim (the
   * caller read it as due, then a racing claim already moved it) is
   * rejected instead of double-dispatching. Two reconcile passes racing
   * the same episode: one claims it, the other sees zero rows affected
   * (durable-retries spec, "Two reconcile passes see due work").
   */
  claimRetryEpisode(episodeId: string, nowMs: number): RetryEpisodeRecord | null {
    const row = this.db.query(
      `UPDATE retry_episode SET status = 'claimed', version = version + 1, time_updated = ?
       WHERE id = (
         SELECT retry_episode.id FROM retry_episode
         JOIN feature ON feature.id = retry_episode.feature_id
         WHERE retry_episode.id = ? AND retry_episode.status = 'scheduled'
           AND retry_episode.next_attempt_at <= ? AND feature.status != 'paused'
       )
       RETURNING *`,
    ).get(nowMs, episodeId, nowMs) as RetryEpisodeRow | null
    return row ? toRetryEpisodeRecord(row) : null
  }

  /** Closes an open (scheduled or claimed) episode — e.g. once its
   *  attempt has been dispatched, or on escalation. Idempotent-safe:
   *  a second close on an already-closed episode is a no-op. */
  closeRetryEpisode(episodeId: string, reason: string): boolean {
    return this.db.run(
      `UPDATE retry_episode SET status = 'closed', closed_reason = ?, time_updated = ?
       WHERE id = ? AND status IN ('scheduled','claimed')`,
      [reason, Date.now(), episodeId],
    ).changes > 0
  }

  /**
   * Operator recovery (retry-budget spec: "recover SHALL … create a new
   * audited episode … old failure history remains in the timeline"):
   * closes the target episode (if still open) and inserts a fresh one
   * chained to it via `recovered_from`, in one transaction. Version-
   * guarded: `expectedVersion` must match the episode's current version
   * or the whole recovery is rejected (stale-target CAS), matching
   * `decideRecover`'s optimistic-concurrency contract in
   * `packages/core/src/lifecycle.ts`.
   */
  recoverRetryEpisode(
    episodeId: string,
    expectedVersion: number,
    input: { startedAt: number; maxAttempts: number; maxElapsedMs: number },
  ): RetryEpisodeRecord | null {
    return this.db.transaction(() => {
      const prior = this.db.query("SELECT * FROM retry_episode WHERE id = ? AND version = ?").get(episodeId, expectedVersion) as RetryEpisodeRow | null
      if (!prior) return null
      const now = Date.now()
      if (prior.status !== "closed") {
        this.db.run(
          "UPDATE retry_episode SET status = 'closed', closed_reason = 'recovered', version = version + 1, time_updated = ? WHERE id = ?",
          [now, episodeId],
        )
      }
      const id = randomUUID()
      // A fresh streak (attempts: 0, started_at: input.startedAt — "now",
      // not inherited) gets a fresh pause baseline too: the feature's
      // cumulative paused_ms AT THIS RECOVERY INSTANT, read in the same
      // transaction, mirrors `started_at` resetting to "now" instead of
      // inheriting the recovered episode's stale anchor.
      const feature = this.db.query("SELECT paused_ms FROM feature WHERE id = ?").get(prior.feature_id) as { paused_ms: number } | null
      const row = this.db.query(
        `INSERT INTO retry_episode (
           id, feature_id, job_id, step_id, status, attempts, started_at, paused_ms, feature_paused_ms_at_start,
           max_attempts, max_elapsed_ms, recovered_from, version, time_created, time_updated
         ) VALUES (?, ?, ?, ?, 'scheduled', 0, ?, 0, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (feature_id, job_id, step_id) WHERE status IN ('scheduled','claimed') DO NOTHING
         RETURNING *`,
      ).get(
        id, prior.feature_id, prior.job_id, prior.step_id, input.startedAt, feature?.paused_ms ?? 0,
        input.maxAttempts, input.maxElapsedMs, episodeId, now, now,
      ) as RetryEpisodeRow | null
      return row ? toRetryEpisodeRecord(row) : null
    })()
  }

  listRetryEpisodes(featureId: string): RetryEpisodeRecord[] {
    const rows = this.db.query(
      "SELECT * FROM retry_episode WHERE feature_id = ? ORDER BY time_created ASC",
    ).all(featureId) as RetryEpisodeRow[]
    return rows.map(toRetryEpisodeRecord)
  }

  // ------------------------------------------------------------- resource waits

  /**
   * Upsert a resource wait for one job+step target: the first
   * observation creates it; a later observation while still `waiting`
   * updates `latest_observed_at`/`observation_count`/`next_observation_at`/
   * `diagnostic` in place (durable-retries spec: "persist … first/latest
   * observation, next observation time and finite deadline" — one row
   * per target, not one row per observation). A concurrent claim wins
   * over a concurrent observation update by construction: the `DO
   * UPDATE … WHERE status = 'waiting'` clause makes the update a no-op
   * once another caller has claimed it, and the caller gets back the
   * (now claimed) row unchanged rather than corrupting a claim in flight.
   */
  upsertResourceWait(input: {
    featureId: string
    jobId: string
    stepId: string
    reason: ResourceReason
    observedAt: number
    nextObservationAt: number
    deadlineAt: number
    diagnostic?: string
  }): ResourceWaitRecord {
    const id = randomUUID()
    const now = Date.now()
    const row = this.db.query(
      `INSERT INTO resource_wait (
         id, feature_id, job_id, step_id, status, reason,
         first_observed_at, latest_observed_at, observation_count, next_observation_at, deadline_at,
         diagnostic, version, time_created, time_updated
       ) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (feature_id, job_id, step_id) WHERE status IN ('waiting','claimed')
       DO UPDATE SET
         latest_observed_at = excluded.latest_observed_at,
         observation_count = resource_wait.observation_count + 1,
         next_observation_at = excluded.next_observation_at,
         diagnostic = excluded.diagnostic,
         version = resource_wait.version + 1,
         time_updated = excluded.time_updated
       WHERE resource_wait.status = 'waiting'
       RETURNING *`,
    ).get(
      id, input.featureId, input.jobId, input.stepId, input.reason,
      input.observedAt, input.observedAt, input.nextObservationAt, input.deadlineAt,
      input.diagnostic ?? null, now, now,
    ) as ResourceWaitRow | null
    // SQLite returns no row from an upsert whose DO UPDATE ... WHERE guard
    // blocked the write (conflict hit, but the existing row is already
    // 'claimed') — the insert never landed either, since the conflict
    // target itself prevented it. Read back the current (claimed) row so
    // the caller always gets the live state rather than null on a target
    // that unambiguously exists.
    if (row) return toResourceWaitRecord(row)
    return this.getOpenResourceWait(input.featureId, input.jobId, input.stepId)!
  }

  getOpenResourceWait(featureId: string, jobId: string, stepId: string): ResourceWaitRecord | null {
    const row = this.db.query(
      `SELECT * FROM resource_wait WHERE feature_id = ? AND job_id = ? AND step_id = ? AND status IN ('waiting','claimed')`,
    ).get(featureId, jobId, stepId) as ResourceWaitRow | null
    return row ? toResourceWaitRecord(row) : null
  }

  getResourceWait(waitId: string): ResourceWaitRecord | null {
    const row = this.db.query("SELECT * FROM resource_wait WHERE id = ?").get(waitId) as ResourceWaitRow | null
    return row ? toResourceWaitRecord(row) : null
  }

  /** Every `waiting` row due for re-observation, excluding paused features
   *  — same pause barrier as `listDueRetryEpisodes` (observation must not
   *  advance while paused either, per the durable-retries scheduling
   *  barrier). */
  listDueResourceWaits(nowMs: number, limit = 50): ResourceWaitRecord[] {
    const rows = this.db.query(
      `SELECT resource_wait.* FROM resource_wait
       JOIN feature ON feature.id = resource_wait.feature_id
       WHERE resource_wait.status = 'waiting' AND resource_wait.next_observation_at <= ?
         AND feature.status != 'paused'
       ORDER BY resource_wait.next_observation_at ASC LIMIT ?`,
    ).all(nowMs, limit) as ResourceWaitRow[]
    return rows.map(toResourceWaitRecord)
  }

  /** Atomic due claim, same shape/guarantees as `claimRetryEpisode`. */
  claimResourceWait(waitId: string, nowMs: number): ResourceWaitRecord | null {
    const row = this.db.query(
      `UPDATE resource_wait SET status = 'claimed', version = version + 1, time_updated = ?
       WHERE id = (
         SELECT resource_wait.id FROM resource_wait
         JOIN feature ON feature.id = resource_wait.feature_id
         WHERE resource_wait.id = ? AND resource_wait.status = 'waiting'
           AND resource_wait.next_observation_at <= ? AND feature.status != 'paused'
       )
       RETURNING *`,
    ).get(nowMs, waitId, nowMs) as ResourceWaitRow | null
    return row ? toResourceWaitRecord(row) : null
  }

  /** Closes an open (waiting or claimed) resource wait — the resource became
   *  available and a run was dispatched, or the wait deadline escalated. */
  closeResourceWait(waitId: string, reason: string): boolean {
    return this.db.run(
      `UPDATE resource_wait SET status = 'closed', closed_reason = ?, time_updated = ?
       WHERE id = ? AND status IN ('waiting','claimed')`,
      [reason, Date.now(), waitId],
    ).changes > 0
  }

  listResourceWaits(featureId: string): ResourceWaitRecord[] {
    const rows = this.db.query(
      "SELECT * FROM resource_wait WHERE feature_id = ? ORDER BY time_created ASC",
    ).all(featureId) as ResourceWaitRow[]
    return rows.map(toResourceWaitRecord)
  }

  // ------------------------------------------------------------- run logs

  /**
   * Appends a batch of log lines to a run's log in ONE transaction:
   * per-run monotonic seq assignment, the inserts, and the per-run size
   * cap (drop-oldest — the tail always survives) all commit together.
   * Returns the appended seq range. The post-commit `run_log`
   * notification is throttled at the source: successive appends to the
   * same run within one window coalesce into at most one emission, so a
   * chatty producer can never flood SSE subscribers. The append itself
   * is never delayed — only the notification is coalesced.
   *
   * `requireRunning` makes the running-state check part of the SAME
   * transaction as the insert — the atomic authority the HTTP write
   * route relies on (its pre-await status snapshot can go stale while
   * the request body is still being read; a concurrent conclusion must
   * not slip an append through the gap). Returns null without writing
   * when the run is no longer `running`. Daemon-internal producers
   * (process/action capture) stay lenient: their run may legitimately be
   * concluded by a concurrent reaper while output is still settling, and
   * a best-effort narrative keeps that tail rather than dropping it.
   */
  appendRunLog(
    runId: string,
    entries: readonly RunLogEntryInput[],
    options?: { requireRunning?: boolean },
  ): { firstSeq: number; lastSeq: number } | null {
    if (entries.length === 0) return null
    const now = this.clock.now()
    let firstSeq = 0
    const appended = this.db.transaction(() => {
      if (options?.requireRunning) {
        const run = this.db.query("SELECT status FROM run WHERE id = ?").get(runId) as { status: string } | null
        if (run?.status !== "running") return false
      }
      const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_log WHERE run_id = ?").get(runId) as { maxSeq: number }
      firstSeq = row.maxSeq + 1
      for (const [offset, entry] of entries.entries()) {
        this.db.run(
          "INSERT INTO run_log (run_id, seq, time, source, chunk) VALUES (?, ?, ?, ?, ?)",
          [runId, firstSeq + offset, now, entry.source, entry.text],
        )
      }
      this.enforceRunLogCap(runId)
      this.db.run("UPDATE run SET time_last_activity = ? WHERE id = ? AND status = 'running'", [now, runId])
      return true
    })()
    if (!appended) return null
    this.emitRunLogChange(runId)
    return { firstSeq, lastSeq: firstSeq + entries.length - 1 }
  }

  private enforceRunLogCap(runId: string): void {
    const total = (this.db.query("SELECT COALESCE(SUM(LENGTH(chunk)), 0) AS bytes FROM run_log WHERE run_id = ?").get(runId) as { bytes: number }).bytes
    if (total <= RUN_LOG_CAP_BYTES) return
    let excess = total - RUN_LOG_CAP_BYTES
    const rows = this.db.query("SELECT seq, LENGTH(chunk) AS bytes FROM run_log WHERE run_id = ? ORDER BY seq ASC").all(runId) as Array<{ seq: number; bytes: number }>
    let dropUpTo = 0
    // Never drop the newest line: even when a single oversized chunk
    // exceeds the whole cap, "the tail survives" stays literally true —
    // an append can never erase itself.
    for (const row of rows.slice(0, -1)) {
      if (excess <= 0) break
      dropUpTo = row.seq
      excess -= row.bytes
    }
    if (dropUpTo > 0) this.db.run("DELETE FROM run_log WHERE run_id = ? AND seq <= ?", [runId, dropUpTo])
  }

  private emitRunLogChange(runId: string): void {
    const featureId = (this.db.query("SELECT feature_id FROM run WHERE id = ?").get(runId) as { feature_id: string } | null)?.feature_id
    if (featureId === undefined) return
    const now = this.clock.now()
    const last = this.runLogEmits.get(runId)
    if (last !== undefined && now - last < RUN_LOG_EMIT_WINDOW_MS) return
    this.runLogEmits.set(runId, now)
    // Opportunistic cleanup: stale entries from runs that stopped logging.
    if (this.runLogEmits.size > 1024) {
      for (const [id, at] of this.runLogEmits) {
        if (now - at >= RUN_LOG_EMIT_WINDOW_MS) this.runLogEmits.delete(id)
      }
    }
    this.emit({ kind: "run_log", featureId })
  }

  /** Cursor-incremental read: lines with seq > afterSeq, capped at limit. */
  getRunLog(runId: string, options?: { afterSeq?: number; limit?: number }): RunLogPage {
    const afterSeq = options?.afterSeq ?? 0
    const limit = options?.limit ?? 500
    const rows = this.db.query(
      "SELECT seq, time, source, chunk FROM run_log WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    ).all(runId, afterSeq, limit + 1) as Array<{ seq: number; time: number; source: RunLogSource; chunk: string }>
    const truncated = rows.length > limit
    const page = truncated ? rows.slice(0, limit) : rows
    const lines = page.map(row => ({ seq: row.seq, time: row.time, source: row.source, text: row.chunk }))
    const nextSeq = lines.length > 0 ? lines[lines.length - 1]!.seq : afterSeq
    return { lines, nextSeq, truncated }
  }

  // ------------------------------------------------------------ findings

  listFindings(featureId: string): FindingView[] {
    const rows = this.db.query("SELECT * FROM finding WHERE feature_id = ? ORDER BY seq").all(featureId) as Array<{
      id: string
      step_id: string
      path: string
      line: number
      severity: string
      tags: string
      body: string
      status: "new" | "fixed" | "dismissed" | "reopened"
      resolution: string | null
      thread_id: string | null
      synced: number
    }>
    return rows.map(row => ({
      id: row.id.split(":").pop() ?? row.id,
      stepId: row.step_id,
      path: row.path,
      line: row.line,
      severity: row.severity,
      tags: JSON.parse(row.tags) as string[],
      body: row.body,
      status: row.status,
      resolution: row.resolution,
      threadId: row.thread_id,
      synced: row.synced === 1,
    }))
  }

  /** One grouped query for the list projection — never one query per feature. */
  countFindingsByStatus(featureIds: readonly string[]): ReadonlyMap<string, FindingCounts> {
    const counts = new Map<string, FindingCounts>()
    if (featureIds.length === 0) return counts
    const rows = this.db.query(
      `SELECT feature_id, status, COUNT(*) AS total FROM finding
       WHERE feature_id IN (${featureIds.map(() => "?").join(", ")})
       GROUP BY feature_id, status`,
    ).all(...featureIds) as Array<{ feature_id: string; status: "new" | "fixed" | "dismissed" | "reopened"; total: number }>
    for (const row of rows) {
      const existing = counts.get(row.feature_id) ?? { new: 0, fixed: 0, dismissed: 0, reopened: 0 }
      counts.set(row.feature_id, { ...existing, [row.status]: row.total })
    }
    return counts
  }

  insertFindings(featureId: string, stepId: string, findings: ReadonlyArray<{
    path: string
    line: number
    severity: string
    tags: readonly string[]
    body: string
  }>): string[] {
    const now = Date.now()
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM finding WHERE feature_id = ?").get(featureId) as { maxSeq: number }
    const ids: string[] = []
    this.db.transaction(() => {
      for (const [offset, finding] of findings.entries()) {
        const seq = row.maxSeq + offset + 1
        const id = `F${seq}`
        this.db.run(
          `INSERT INTO finding (id, feature_id, seq, step_id, path, line, severity, tags, body, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`${featureId}:${id}`, featureId, seq, stepId, finding.path, finding.line, finding.severity, JSON.stringify(finding.tags), finding.body, now, now],
        )
        ids.push(id)
      }
    })()
    if (ids.length > 0) this.emit({ kind: "finding", featureId })
    return ids
  }

  setFindingStatus(featureId: string, shortId: string, status: "new" | "fixed" | "dismissed" | "reopened", resolution?: string): boolean {
    const result = this.db.run(
      `UPDATE finding SET status = ?, resolution = COALESCE(?, resolution), synced = 0, time_updated = ?
       WHERE id = ?`,
      [status, resolution ?? null, Date.now(), `${featureId}:${shortId}`],
    )
    if (result.changes > 0) this.emit({ kind: "finding", featureId })
    return result.changes > 0
  }

  // --------------------------------------------------------------- audit

  getTransitions(featureId: string, limit = 50): TransitionEntry[] {
    const rows = this.db.query(
      `SELECT event, decisions, time_created FROM transition_log
       WHERE feature_id = ? ORDER BY time_created DESC LIMIT ?`,
    ).all(featureId, limit) as Array<{ event: string; decisions: string; time_created: number }>
    return rows.map(row => ({
      event: JSON.parse(row.event) as PipelineEvent,
      decisions: JSON.parse(row.decisions) as Decision[],
      time: row.time_created,
    }))
  }
}

function escalationReason(decisions: readonly Decision[]): string | null {
  const escalation = decisions.find((decision): decision is Extract<Decision, { kind: "escalate" }> => decision.kind === "escalate")
  return escalation?.reason ?? null
}
