/**
 * Start-work target derivation — pure, DOM-free.
 *
 * Targets come from daemon health (`GET /v1/health`'s `projects`), never
 * from feature-list scopes: a project with no active features must still
 * be startable, and historical feature data is not the workflow registry
 * (design.md "Model selection as a project/workflow target"). Each
 * configured project currently contributes exactly one project/workflow
 * target — `valid`/`stale` are selectable (stale carries a warning and
 * uses the last valid snapshot), `invalid`/`unregistered` are visible but
 * not startable, and get their reason from the SAME diagnostics health
 * already reports.
 *
 * A selected target's workflow name, stale diagnostics, and input
 * definitions come from that project's own workflow projection
 * (`GET /v1/projects/workflow?dir=`, surfaced as the store's
 * `WorkflowState`) — `resolveTarget` joins the two.
 *
 * `projectLabel` is a short DISPLAY label, never the sole identity a
 * caller renders: two configured projects can share a basename (e.g.
 * `/home/a/webapp` and `/home/b/webapp`), and the rendered target list
 * must still let an operator tell them apart safely — every `StartTarget`
 * therefore also carries the full `projectDir`, and `deriveStartTargets`
 * disambiguates a basename collision by prefixing the parent segment
 * (`b/webapp`) so the short label itself stops colliding whenever
 * possible, independent of whatever the caller additionally renders.
 */

import type { DaemonHealth, InputDef } from "../api/types.ts"
import type { WorkflowState } from "../api/store.ts"

export interface StartTarget {
  readonly projectDir: string
  readonly projectLabel: string
  readonly state: DaemonHealth["projects"][number]["state"]
  /** `valid` or `stale` — the only states a workflow snapshot can be resolved from. */
  readonly selectable: boolean
  readonly stale: boolean
  /** Health's diagnostic messages for this project (stale/invalid only; empty otherwise). */
  readonly diagnostics: readonly string[]
}

function basename(projectDir: string): string {
  const trimmed = projectDir.replace(/\/+$/, "")
  const parts = trimmed.split("/")
  return parts[parts.length - 1] || trimmed
}

/** Parent path segment, used only to disambiguate a basename collision. */
function parentSegment(projectDir: string): string | null {
  const trimmed = projectDir.replace(/\/+$/, "")
  const parts = trimmed.split("/")
  const parent = parts[parts.length - 2]
  return parent !== undefined && parent !== "" ? parent : null
}

/** Basename by default; `parent/basename` for any directory whose
 *  basename collides with another directory in the same list — keeps
 *  the common case short while making a real collision distinguishable
 *  without falling back to the full absolute path everywhere. */
function disambiguatedLabels(dirs: readonly string[]): ReadonlyMap<string, string> {
  const byBasename = new Map<string, string[]>()
  for (const dir of dirs) {
    const base = basename(dir)
    const group = byBasename.get(base)
    if (group === undefined) byBasename.set(base, [dir])
    else group.push(dir)
  }
  const labels = new Map<string, string>()
  for (const [base, group] of byBasename) {
    if (group.length === 1) {
      labels.set(group[0]!, base)
      continue
    }
    for (const dir of group) {
      const parent = parentSegment(dir)
      labels.set(dir, parent !== null ? `${parent}/${base}` : dir)
    }
  }
  return labels
}

/** Every configured project as a start target, alphabetically by label
 *  then directory — a stable order independent of health's own array
 *  order (which is sorted by canonical path, but keeping the sort here
 *  makes the contract explicit and re-derivation-stable). */
export function deriveStartTargets(health: DaemonHealth | null): readonly StartTarget[] {
  if (health === null) return []
  const labels = disambiguatedLabels(health.projects.map(p => p.projectDir))
  return [...health.projects]
    .map(project => ({
      projectDir: project.projectDir,
      projectLabel: labels.get(project.projectDir) ?? basename(project.projectDir),
      state: project.state,
      selectable: project.state === "valid" || project.state === "stale",
      stale: project.state === "stale",
      // `safeMessage` is the path-free rendering — `message` may embed
      // daemon-local absolute filesystem paths for action-resolution
      // failures. Fall back to `message` only for wire compatibility
      // with a daemon that predates `safeMessage`.
      diagnostics: project.diagnostics.map(d => d.safeMessage ?? d.message),
    }))
    .sort((a, b) => a.projectLabel.localeCompare(b.projectLabel) || a.projectDir.localeCompare(b.projectDir))
}

export function selectableTargets(targets: readonly StartTarget[]): readonly StartTarget[] {
  return targets.filter(t => t.selectable)
}

/** Exactly one eligible (valid/stale) target ⇒ preselect it. Zero or
 *  multiple eligible targets ⇒ null, and the operator chooses explicitly. */
export function preselectedTarget(targets: readonly StartTarget[]): StartTarget | null {
  const eligible = selectableTargets(targets)
  return eligible.length === 1 ? eligible[0]! : null
}

/** True once there is more than one eligible target to choose between. */
export function requiresExplicitSelection(targets: readonly StartTarget[]): boolean {
  return selectableTargets(targets).length > 1
}

/**
 * Keep the current selection alive as long as it still names a target —
 * mirrors `board.tsx`'s `pickStableDefaultScopeKey` freeze-unless-gone
 * rule so a health refresh never yanks the operator's choice away.
 * Falls back to the sole eligible target (or null) once the current
 * selection disappears or nothing was selected yet.
 */
export function resolveSelectedProjectDir(targets: readonly StartTarget[], current: string | null): string | null {
  if (current !== null && targets.some(t => t.projectDir === current)) return current
  return preselectedTarget(targets)?.projectDir ?? null
}

/** Daemon-wide runner availability — a visible, non-blocking warning
 *  independent of which target is selected. */
export function runnerUnavailable(health: DaemonHealth | null): boolean {
  return health?.runner === "unavailable"
}

export interface ResolvedTarget {
  readonly projectDir: string
  readonly projectLabel: string
  /** Whether this target currently has a usable workflow snapshot (cached
   *  or fresh) worth rendering/submitting against — independent of
   *  `refreshError`, which is its own, separately-checked submit gate
   *  (see that field's doc). */
  readonly submittable: boolean
  readonly workflowName: string | null
  /** Non-null only when the served snapshot is stale (last-valid, reload failed). */
  readonly staleWarning: string | null
  /** Non-null when the target cannot be started at all — invalid/
   *  unregistered project, or an INITIAL workflow fetch that itself
   *  failed with no prior data to fall back on (a transport error, not
   *  merely still loading — never rendered identically to "loading"). */
  readonly unavailableReason: string | null
  readonly inputs: Readonly<Record<string, InputDef>>
  /**
   * Non-null only when the workflow resource's MOST RECENT refresh
   * failed while a PRIOR cached projection is still being shown/used —
   * in practice, `refetchWorkflow` after a configuration-race rejection
   * (`unknown_workflow`/`invalid_input`) itself failing. Distinct from
   * `staleWarning` (a stale but successfully SERVED snapshot) and from
   * `unavailableReason` (no usable snapshot exists at all): here a
   * cached projection IS still being rendered, but Conductor already
   * knows the target's underlying metadata may have changed and could
   * not confirm the refreshed shape — so it is never silently treated
   * as fresh. The chosen safe policy is to BLOCK submission while this
   * is set (`deriveSubmitGate`), while preserving every already-entered
   * field, until a later refresh of this same target succeeds.
   */
  readonly refreshError: string | null
  /**
   * True exactly when a bounded recovery retry is meaningful right now:
   * either an INITIAL workflow fetch transport failure (no data at all
   * yet — `unavailableReason` set from that failure, not from health
   * reporting the project itself invalid/unregistered), or a failed
   * REFRESH of a previously-cached snapshot (`refreshError` set). Both
   * are transport-layer failures a retry of the SAME request can
   * plausibly resolve; an actual `invalid`/`unregistered` project state
   * (from health, or from the workflow endpoint itself resolving to
   * "unregistered"/"invalid") is a real configuration state a request
   * retry cannot fix by itself, so it is deliberately excluded here —
   * callers gate an explicit "Retry" action's visibility on this flag.
   */
  readonly canRetryWorkflow: boolean
}

/** The subset of `WorkflowResourceState` `resolveTarget` needs — kept
 *  structural rather than importing the concrete type so pure target
 *  derivation stays decoupled from the store's resource-state shape. */
export interface WorkflowResourceStateInput {
  readonly status: "loading" | "ready" | "error"
  readonly data: WorkflowState | null
  readonly error: { readonly message: string } | null
}

/**
 * Join one target's health-derived eligibility with its fetched workflow
 * RESOURCE state (the full `status`/`data`/`error`, not merely `data` —
 * using only `data` cannot distinguish an initial transport failure from
 * "still loading" (both have `data: null`), and cannot distinguish a
 * failed REFRESH from a fresh one (both keep the prior `data` non-null).
 * `workflow` is expected to come from the SAME project the target names
 * — callers key their `useWorkflow` call by `target.projectDir`.
 */
export function resolveTarget(target: StartTarget | null, workflow: WorkflowResourceStateInput | null): ResolvedTarget | null {
  if (target === null) return null

  if (!target.selectable) {
    return {
      projectDir: target.projectDir,
      projectLabel: target.projectLabel,
      submittable: false,
      workflowName: null,
      staleWarning: null,
      unavailableReason: target.diagnostics.length > 0 ? target.diagnostics.join("; ") : `project is ${target.state}`,
      inputs: {},
      refreshError: null,
      canRetryWorkflow: false,
    }
  }

  if (workflow === null || workflow.data === null) {
    if (workflow?.status === "error") {
      // An INITIAL fetch failure (never had data) — must be visibly
      // distinct from "still loading", never rendered as endless
      // loading (spec: "Do not show initial failure as endless loading").
      // A transport-layer failure — worth an explicit retry.
      return {
        projectDir: target.projectDir,
        projectLabel: target.projectLabel,
        submittable: false,
        workflowName: null,
        staleWarning: null,
        unavailableReason: workflow.error?.message ?? "could not load this project's workflow",
        inputs: {},
        refreshError: null,
        canRetryWorkflow: true,
      }
    }
    // Still loading this target's workflow projection for the first time.
    return {
      projectDir: target.projectDir,
      projectLabel: target.projectLabel,
      submittable: false,
      workflowName: null,
      staleWarning: null,
      unavailableReason: null,
      inputs: {},
      refreshError: null,
      canRetryWorkflow: false,
    }
  }

  // From here `workflow.data` is non-null: either a fresh load, or a
  // cached projection kept after a failed REFRESH (`ResourceState`
  // never clears `data` on a refresh error — see `DataSource.dataOf`).
  const cached = workflow.data
  const refreshFailed = workflow.status === "error"
  const refreshError = refreshFailed ? (workflow.error?.message ?? "could not confirm this target's current configuration") : null

  if (!cached.ok) {
    // Defensive: health said valid/stale but the workflow fetch itself
    // resolved to unregistered/invalid (or a prior such result is being
    // kept after a since-failed refresh of it). `canRetryWorkflow` only
    // when the MOST RECENT attempt was itself a transport failure
    // (`refreshFailed`) — a plain "unregistered"/"invalid" RESPONSE (no
    // transport error) is a real configuration state a request retry
    // cannot fix by itself.
    return {
      projectDir: target.projectDir,
      projectLabel: target.projectLabel,
      submittable: false,
      workflowName: null,
      staleWarning: null,
      unavailableReason: cached.message,
      inputs: {},
      refreshError,
      canRetryWorkflow: refreshFailed,
    }
  }

  return {
    projectDir: target.projectDir,
    projectLabel: target.projectLabel,
    submittable: true,
    workflowName: cached.workflow.name,
    staleWarning: cached.workflow.stale
      ? `last valid workflow snapshot in use${cached.workflow.diagnostics.length > 0 ? ` — ${cached.workflow.diagnostics.join("; ")}` : ""}`
      : null,
    unavailableReason: null,
    inputs: cached.workflow.inputs,
    refreshError,
    canRetryWorkflow: refreshFailed,
  }
}

/** Discovery status of the target list itself — distinct from any one
 *  target's own submittability. Modeled off `ResourceState["status"]`
 *  (`loading`/`ready`/`error`) but scoped to "can the operator even see
 *  a trustworthy list of projects to start work in", so a health load
 *  failure never gets silently read as "zero configured projects" by a
 *  caller that only checks `targets.length === 0`. */
export type TargetDiscoveryState =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string | null; readonly stale: boolean }

/**
 * Derive discovery status from the health resource's own load state.
 * `stale: true` on an error means `targets` still reflects a PRIOR
 * successful health load (health keeps its last-known `data` on a
 * failed refresh, per `DataSource.setResource`) — the caller may still
 * choose to render those targets, but only labeled as possibly stale,
 * never as a silently-trustworthy fresh list (spec: "does not leave a
 * stale cached target silently selectable after a failed refresh unless
 * explicitly warning").
 */
export function deriveDiscoveryState(health: {
  readonly status: "loading" | "ready" | "error"
  readonly data: DaemonHealth | null
  readonly error: { readonly message: string } | null
}): TargetDiscoveryState {
  if (health.status === "error") {
    return { status: "error", message: health.error?.message ?? null, stale: health.data !== null }
  }
  if (health.status === "loading" && health.data === null) return { status: "loading" }
  return { status: "ready" }
}

/**
 * Whether the start form can currently be submitted — the single place
 * "can the operator press start work" is decided, so the sheet's submit
 * button and any inline explanation stay in sync (spec: "Duplicate
 * submit is blocked while pending", "does not enable submission" for an
 * unavailable target). Reasons are ordered most-blocking-first; the
 * first applicable one is what a caller should show as the disabled
 * explanation.
 */
export interface SubmitGate {
  readonly canSubmit: boolean
  /** Human-readable reason submission is blocked, or null when submittable.
   *  Absent while merely `pending` — pending has its own dedicated label
   *  ("starting…") callers already render. */
  readonly blockedReason: string | null
}

export function deriveSubmitGate(input: {
  readonly pending: boolean
  readonly discovery: TargetDiscoveryState
  readonly resolved: ResolvedTarget | null
  /** Whether the CURRENT draft would pass client validation against the
   *  resolved target's inputs right now — a live re-check, not merely
   *  whatever `errors` state a previous submit attempt left behind, so
   *  fixing a field re-enables submit without requiring another failed
   *  attempt first. */
  readonly formValid: boolean
  /** Whether at least one client-validation problem is CURRENTLY VISIBLE
   *  to the operator (i.e. `hasFieldErrors` on the touched/submission-
   *  gated `visibleFieldErrors` result, not the raw live validation) —
   *  distinguishes "the draft is invalid but nothing is highlighted yet
   *  because the operator hasn't touched anything" from "the draft is
   *  invalid AND a highlighted field explains why", so the blocked
   *  reason never claims fields are highlighted when none are (spec:
   *  "never leave submit disabled with 'highlighted fields' and no
   *  highlights"). */
  readonly hasVisibleErrors: boolean
}): SubmitGate {
  if (input.pending) return { canSubmit: false, blockedReason: null }
  if (input.discovery.status === "loading") return { canSubmit: false, blockedReason: "discovering configured projects…" }
  if (input.discovery.status === "error" && !input.discovery.stale) {
    return { canSubmit: false, blockedReason: "could not load configured projects" }
  }
  if (input.resolved === null) return { canSubmit: false, blockedReason: "select a project to start work in" }
  if (!input.resolved.submittable || input.resolved.workflowName === null) {
    return { canSubmit: false, blockedReason: input.resolved.unavailableReason ?? "this target is not available to start work in" }
  }
  if (input.resolved.refreshError !== null) {
    // A cached projection is being shown, but the most recent refresh of
    // THIS target (typically `refetchWorkflow` after a configuration-
    // race rejection) itself failed — the safe policy is to block
    // submission rather than silently resubmit against a projection
    // Conductor already flagged as possibly stale-and-unconfirmed (spec:
    // "must not silently treat cached projection as fresh"). All fields
    // remain intact; the operator can retry once the refresh succeeds.
    return { canSubmit: false, blockedReason: `could not confirm this target's current configuration — ${input.resolved.refreshError}` }
  }
  if (!input.formValid) {
    return {
      canSubmit: false,
      blockedReason: input.hasVisibleErrors ? "fix the highlighted fields" : "fill in the required fields to continue",
    }
  }
  return { canSubmit: true, blockedReason: null }
}
