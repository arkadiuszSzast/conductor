/**
 * The active-state/terminal DAG invariant (design.md "Explicit active-state
 * invariant"): every non-terminal feature must have at least one durable
 * progress anchor, and a `running` feature whose entire DAG has gone
 * terminal with a failure is the legacy stranded shape that must normalize
 * to `escalated` — never left silently `running` forever.
 *
 * Pure predicate only: retry episodes, resource waits and the completion
 * outbox live in SQLite (task 2.2+, out of scope here), so this module
 * takes their presence as an explicit `AnchorState` the caller (the
 * engine's reconciler) supplies rather than reaching into a store itself.
 */

import type { FeatureState, JobStatus } from "./types.ts"

export type ProgressAnchor =
  | "active_run"
  | "human_gate"
  | "due_retry"
  | "resource_wait"
  | "paused_pending_work"
  | "unhandled_outbox_decision"

/** External durable anchors the pure core cannot see for itself. */
export interface AnchorState {
  readonly hasActiveRun: boolean
  readonly hasDueRetry: boolean
  readonly hasResourceWait: boolean
  readonly hasUnhandledOutboxDecision: boolean
}

export const NO_EXTERNAL_ANCHORS: AnchorState = {
  hasActiveRun: false,
  hasDueRetry: false,
  hasResourceWait: false,
  hasUnhandledOutboxDecision: false,
}

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(["succeeded", "failed", "skipped"])

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status)
}

/** True once every job in the workflow has reached a terminal status. */
export function allJobsTerminalStatus(state: FeatureState): boolean {
  const jobs = Object.values(state.jobs)
  return jobs.length > 0 && jobs.every(job => isTerminalJobStatus(job.status))
}

export function anyJobFailed(state: FeatureState): boolean {
  return Object.values(state.jobs).some(job => job.status === "failed")
}

function hasHumanGateAnchor(state: FeatureState): boolean {
  return Object.values(state.jobs).some(job =>
    Object.values(job.steps).some(step => step.status === "waiting_human"))
}

/** Every anchor currently held for `state`. Empty means the feature is
 *  stuck: nothing durable will ever move it forward again. */
export function progressAnchors(state: FeatureState, external: AnchorState): readonly ProgressAnchor[] {
  const anchors: ProgressAnchor[] = []
  if (external.hasActiveRun) anchors.push("active_run")
  if (hasHumanGateAnchor(state)) anchors.push("human_gate")
  if (external.hasDueRetry) anchors.push("due_retry")
  if (external.hasResourceWait) anchors.push("resource_wait")
  if (state.status === "paused") anchors.push("paused_pending_work")
  if (external.hasUnhandledOutboxDecision) anchors.push("unhandled_outbox_decision")
  return anchors
}

export type InvariantCheckResult =
  | { readonly kind: "ok" }
  | { readonly kind: "terminal" }
  | { readonly kind: "stranded_legacy_failure"; readonly reason: string }
  | { readonly kind: "stranded_no_anchor"; readonly reason: string; readonly anchors: readonly ProgressAnchor[] }

/**
 * `done`/`abandoned` are unconditionally terminal. `escalated` explains its
 * own halt (retry-budget spec: escalation SHALL persist why automation
 * stopped and what recovery is allowed) so it needs no anchor either. A
 * `running` feature whose jobs are ALL terminal with at least one failure
 * is the pre-durable-retries stranded shape (durable-retries spec
 * scenario "Legacy feature has only failed and skipped jobs") and must be
 * reported for normalization to `escalated` without replaying completed
 * work. Any other non-terminal feature needs ≥ 1 progress anchor.
 */
export function checkActiveStateInvariant(state: FeatureState, external: AnchorState): InvariantCheckResult {
  if (state.status === "done" || state.status === "abandoned" || state.status === "escalated") {
    return { kind: "terminal" }
  }
  if (state.status === "running" && allJobsTerminalStatus(state) && anyJobFailed(state)) {
    return {
      kind: "stranded_legacy_failure",
      reason: `feature "${state.slug}" is "running" but every job is terminal and at least one failed`,
    }
  }
  const anchors = progressAnchors(state, external)
  if (anchors.length === 0) {
    return {
      kind: "stranded_no_anchor",
      reason: `feature "${state.slug}" is "${state.status}" with no active run, human gate, due retry, resource wait, paused work or unhandled decision`,
      anchors,
    }
  }
  return { kind: "ok" }
}
