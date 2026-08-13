/**
 * Pure retry/resource-wait/recover route decisions built on the finite
 * normalized policies (`retry-policy.ts`) and scheduling arithmetic
 * (`scheduling.ts`). No I/O, no ambient clock or randomness — every
 * timestamp and jittered delay is computed from an explicit `nowMs` and
 * injected `Random`, so decisions are exhaustively unit-testable.
 *
 * Deliberately separate from `interpret.ts`: the existing
 * `PipelineEvent`/`Decision` contract and its `step.failed { reason:
 * string }` / `human.resumed` behaviour are preserved unchanged for
 * workflow-format compatibility. These functions model the durable-retries/
 * retry-budget episode semantics (class-aware budgets, pause-excluded
 * elapsed time, resource waits distinct from attempt failures, recover as
 * a new audited episode) that a future engine phase wires into dispatch —
 * they decide route INTENT only; the store persists the schedule and the
 * engine acts on it.
 */

import type { FailureClass, FailureEnvelope, ResourceReason } from "./failure.ts"
import { behaviourForClass } from "./retry-policy.ts"
import type { NormalizedResourceWaitPolicy, NormalizedRetryPolicy } from "./retry-policy.ts"
import { checkRetryBudget, computeScheduledDelayMs, elapsedBudgetMs, nextAttemptAt } from "./scheduling.ts"
import type { Random } from "./scheduling.ts"

// ---------------------------------------------------------------------------
// Retry episode: route a classified failure to retry or escalate
// ---------------------------------------------------------------------------

export interface RetryEpisodeState {
  /** Attempts already made in the current episode, including the one that
   *  just failed. */
  readonly attempts: number
  readonly startedAtMs: number
  /** Accumulated pause time excluded from elapsed accounting. */
  readonly pausedMs: number
}

export type FailureRouteDecision =
  | {
      readonly kind: "retry"
      readonly attempt: number
      readonly nextAttemptAtMs: number
      readonly delayMs: number
      readonly scheduleSource: "backoff" | "retry_hint"
    }
  | { readonly kind: "escalate"; readonly reason: string; readonly exhaustedBy: "attempts" | "elapsed" }

/**
 * Decide whether a classified failure gets another attempt or exhausts its
 * budget. `episode.attempts` already counts the failed attempt, matching
 * `max_attempts` "includes the first executable attempt" (retry-budget
 * spec). The candidate next-attempt time is checked against the elapsed
 * deadline BEFORE it is returned — an attempt that would start past the
 * deadline is never scheduled, matching "no one extra attempt" at deadline.
 */
export function decideFailureRoute(
  envelope: FailureEnvelope,
  policy: NormalizedRetryPolicy,
  episode: RetryEpisodeState,
  nowMs: number,
  random: Random,
): FailureRouteDecision {
  const behaviour = behaviourForClass(policy, envelope.class)
  const schedule = computeScheduledDelayMs(behaviour.backoff, episode.attempts, random, envelope.retryHintMs)
  const candidateAtMs = nextAttemptAt(nowMs, schedule.delayMs)

  const budget = checkRetryBudget({
    attempts: episode.attempts,
    maxAttempts: behaviour.budget.maxAttempts,
    maxElapsedMs: behaviour.budget.maxElapsedMs,
    episodeStartedAtMs: episode.startedAtMs,
    pausedMs: episode.pausedMs,
    candidateAttemptAtMs: candidateAtMs,
  })

  if (!budget.ok) {
    const elapsed = elapsedBudgetMs(episode, nowMs)
    return {
      kind: "escalate",
      exhaustedBy: budget.exhaustedBy,
      reason: budget.exhaustedBy === "attempts"
        ? `exhausted ${behaviour.budget.maxAttempts} attempt(s) for class "${envelope.class}": ${envelope.diagnostic}`
        : `exceeded ${behaviour.budget.maxElapsedMs}ms elapsed budget (${elapsed}ms elapsed) for class "${envelope.class}": ${envelope.diagnostic}`,
    }
  }

  return {
    kind: "retry",
    attempt: episode.attempts + 1,
    nextAttemptAtMs: candidateAtMs,
    delayMs: schedule.delayMs,
    scheduleSource: schedule.source,
  }
}

// ---------------------------------------------------------------------------
// Resource wait: observe an unavailable resource without spending attempts
// ---------------------------------------------------------------------------

export interface ResourceWaitState {
  readonly firstObservedAtMs: number
  /** Observations made so far — never increments the step's attempt
   *  budget (retry-budget spec: "Observing an unavailable resource SHALL
   *  NOT increment step attempts"). */
  readonly observationCount: number
}

export type ResourceWaitRouteDecision =
  | { readonly kind: "wait_resource"; readonly nextObservationAtMs: number; readonly delayMs: number }
  | { readonly kind: "escalate"; readonly reason: string }

/** Decide the next observation time for an unavailable resource, or
 *  escalate once the finite wait deadline (measured from first
 *  observation) has passed. */
export function decideResourceWaitRoute(
  reason: ResourceReason,
  policy: NormalizedResourceWaitPolicy,
  wait: ResourceWaitState,
  nowMs: number,
  random: Random,
): ResourceWaitRouteDecision {
  const elapsed = Math.max(0, nowMs - wait.firstObservedAtMs)
  if (elapsed >= policy.maxWaitMs) {
    return {
      kind: "escalate",
      reason: `resource "${reason}" remained unavailable through ${policy.maxWaitMs}ms deadline (${wait.observationCount} observation(s))`,
    }
  }
  const delayMs = computeScheduledDelayMs(policy.observation, wait.observationCount + 1, random).delayMs
  return { kind: "wait_resource", nextObservationAtMs: nextAttemptAt(nowMs, delayMs), delayMs }
}

// ---------------------------------------------------------------------------
// Recover: an explicit, audited new episode for an escalated target
// ---------------------------------------------------------------------------

export type RecoverableStatus = "failed" | "escalated" | "blocked"

export interface RecoverTarget {
  readonly status: RecoverableStatus
  /** Optimistic concurrency guard: the caller's expected current status
   *  and a version/revision marker. `decideRecover` rejects a stale target
   *  by comparing `expectedVersion` against `currentVersion` — the actual
   *  compare-and-swap happens where the version lives (store, task 2.3);
   *  here it is pure equality. */
  readonly currentVersion: number
}

export interface RecoverRequest {
  readonly expectedStatus: RecoverableStatus
  readonly expectedVersion: number
  readonly note: string
  readonly budgetOverride?: { readonly maxAttempts?: number; readonly maxElapsedMs?: number }
}

export type RecoverDecision =
  | { readonly kind: "recovered"; readonly episode: RetryEpisodeState }
  | { readonly kind: "rejected"; readonly reason: string }

/**
 * Validate and start a new audited retry episode for a recoverable target.
 * Rejects an empty note (recover always requires an operator explanation),
 * a stale optimistic version (someone already acted on this target) and a
 * target whose status is not one of the recoverable statuses — it never
 * falls through to replaying workflow start (design.md: "It never falls
 * through to replay workflow start").
 */
export function decideRecover(target: RecoverTarget, request: RecoverRequest, nowMs: number): RecoverDecision {
  if (request.note.trim() === "") {
    return { kind: "rejected", reason: "recover requires an operator note" }
  }
  if (target.status !== request.expectedStatus) {
    return {
      kind: "rejected",
      reason: `target is "${target.status}", not the expected "${request.expectedStatus}" — recover was not applied`,
    }
  }
  if (target.currentVersion !== request.expectedVersion) {
    return { kind: "rejected", reason: "target changed since the recover request was issued (stale version) — reload and retry" }
  }
  return { kind: "recovered", episode: { attempts: 0, startedAtMs: nowMs, pausedMs: 0 } }
}

// ---------------------------------------------------------------------------
// Pause-aware resume: due schedules never fire early, never lose the wait
// ---------------------------------------------------------------------------

export type DueScheduleKind = "retry" | "resource_wait"

export interface DueSchedule {
  readonly kind: DueScheduleKind
  /** The stored `next_attempt_at` / `next_observation_at` wall-clock time. */
  readonly dueAtMs: number
}

export type ResumeScheduleDecision =
  | { readonly kind: "claim_now" }
  | { readonly kind: "still_waiting"; readonly dueAtMs: number }

/**
 * Reconcile a durable due schedule against pause (durable-retries spec,
 * "Pause is a scheduling barrier" / "Retry becomes due while paused"): a
 * schedule whose `dueAtMs` already passed while paused is claimed exactly
 * once immediately after resume — no attempt fired during the pause, and
 * resuming does not push the due time further out. A schedule not yet due
 * keeps its original timestamp unchanged; pause never shifts it earlier.
 */
export function decidePauseAwareResume(schedule: DueSchedule, nowMs: number): ResumeScheduleDecision {
  return nowMs >= schedule.dueAtMs ? { kind: "claim_now" } : { kind: "still_waiting", dueAtMs: schedule.dueAtMs }
}

export type { FailureClass }
