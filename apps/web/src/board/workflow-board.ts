/**
 * Workflow-scoped board derivation — pure, DOM-free.
 *
 * Replaces status-column grouping with per-scope (project + workflow) job
 * columns whose cards are a feature's active job *frontier*: every
 * currently running job, or every ready job when none is running, or (for
 * an escalated feature with no running/ready job) every failed job as a
 * fallback so the escalation still lands somewhere concrete. A feature
 * that resolves to no frontier job stays out of the columns entirely and
 * surfaces in an explicit diagnostic tray instead of silently vanishing.
 *
 * Column order follows topological (longest-path) layering, reusing the
 * same `assignLayers` the graph canvas uses for layout — jobs earlier in
 * the workflow's dependency chain sit in earlier columns.
 *
 * Paused and terminal (done/abandoned) features never occupy job columns:
 * they belong to the compact cross-workflow overview/recent sections
 * (`deriveOverview`) so active columns stay focused on work in flight.
 */

import type { FeatureListItem, JobStatus, WorkflowProjection } from "../api/types.ts"
import { assignLayers } from "../graph/layout.ts"
import { projectBasename } from "../graph/merge.ts"
import { cardModel, groupIntoZones, type BoardCardModel } from "./card-model.ts"

export interface WorkflowScopeSummary {
  readonly key: string
  readonly projectDir: string
  readonly workflow: string
  readonly projectLabel: string
  readonly featureCount: number
  readonly activeCount: number
}

export function scopeKey(projectDir: string, workflow: string | null): string {
  return `${projectDir}::${workflow ?? "default"}`
}

/**
 * `GET /v1/projects/workflow?dir=` returns exactly one structural
 * projection per project directory — the currently registered workflow,
 * not one per historical workflow name a project's features may carry.
 * A scope derived from the feature list can therefore name a workflow
 * that no longer matches what the endpoint serves for that project (a
 * rename, or features started under a workflow that has since been
 * replaced). Rendering that projection's job columns under the old
 * scope's label would silently mislabel every card, so callers must
 * check this before deriving a board from the pair.
 */
export function scopeMatchesWorkflow(scope: ScopeIdentity, workflow: Pick<WorkflowProjection, "name">): boolean {
  return workflow.name === scope.workflow
}

/**
 * Freeze-friendly default-scope selection. `deriveWorkflowScopes` sorts
 * by `activeCount`, which shifts every time an SSE-driven feature-list
 * refetch changes how many features are active in a scope — without
 * this, the board would silently jump the operator to a different
 * project/workflow mid-triage. Keeps `current` as long as it still names
 * an existing scope; only re-picks (the busiest scope) when `current` is
 * null or has disappeared entirely (its last active/paused feature
 * completed, so there is nothing left to freeze onto).
 */
export function pickStableDefaultScopeKey(
  current: string | null,
  scopes: readonly WorkflowScopeSummary[],
): string | null {
  if (current !== null && scopes.some(s => s.key === current)) return current
  return scopes[0]?.key ?? null
}

/** Group non-terminal features into project+workflow scopes, busiest first. */
export function deriveWorkflowScopes(items: readonly FeatureListItem[]): readonly WorkflowScopeSummary[] {
  const map = new Map<string, { projectDir: string; workflow: string; featureCount: number; activeCount: number }>()
  for (const item of items) {
    if (item.status === "done" || item.status === "abandoned") continue
    const workflow = item.workflow ?? "default"
    const key = scopeKey(item.projectDir, workflow)
    let entry = map.get(key)
    if (entry === undefined) {
      entry = { projectDir: item.projectDir, workflow, featureCount: 0, activeCount: 0 }
      map.set(key, entry)
    }
    entry.featureCount++
    if (item.status === "running" || item.status === "waiting_human" || item.status === "escalated") entry.activeCount++
  }
  return [...map.entries()]
    .map(([key, entry]) => ({
      key,
      projectDir: entry.projectDir,
      workflow: entry.workflow,
      projectLabel: projectBasename(entry.projectDir),
      featureCount: entry.featureCount,
      activeCount: entry.activeCount,
    }))
    .sort(
      (a, b) =>
        b.activeCount - a.activeCount ||
        a.projectLabel.localeCompare(b.projectLabel) ||
        a.workflow.localeCompare(b.workflow),
    )
}

export type FrontierKind = "running" | "ready" | "escalated-fallback"

export interface FrontierResult {
  readonly jobIds: readonly string[]
  readonly kind: FrontierKind | null
}

/** Which jobs currently represent a feature's position in its workflow. */
export function resolveFrontierJobIds(item: FeatureListItem): FrontierResult {
  const running = Object.entries(item.jobs)
    .filter(([, job]) => job.status === "running")
    .map(([id]) => id)
  if (running.length > 0) return { jobIds: running, kind: "running" }

  const ready = Object.entries(item.jobs)
    .filter(([, job]) => job.status === "ready")
    .map(([id]) => id)
  if (ready.length > 0) return { jobIds: ready, kind: "ready" }

  if (item.status === "escalated") {
    const failed = Object.entries(item.jobs)
      .filter(([, job]) => job.status === "failed")
      .map(([id]) => id)
    if (failed.length > 0) return { jobIds: failed, kind: "escalated-fallback" }
  }

  return { jobIds: [], kind: null }
}

/** Topological column order: longest-path layer, then declaration order. */
export function jobColumnOrder(workflow: WorkflowProjection): readonly string[] {
  const jobs = Object.entries(workflow.jobs).map(([id, def]) => ({
    id,
    needs: def.needs,
    stepCount: def.steps.length,
  }))
  const layers = assignLayers(jobs)
  return jobs.map(job => job.id).sort((a, b) => (layers.get(a) ?? 0) - (layers.get(b) ?? 0))
}

export interface FrontierCardModel extends BoardCardModel {
  /** `${featureId}::${jobId}` — card identity when one feature spans columns. */
  readonly cardId: string
  readonly jobId: string
  readonly jobStatus: JobStatus
  readonly frontierKind: FrontierKind
  /** Count of frontier job instances for this feature; >1 marks it parallel. */
  readonly parallelCount: number
}

export interface JobColumnModel {
  readonly jobId: string
  readonly cards: readonly FrontierCardModel[]
}

export interface WorkflowBoardModel {
  readonly columns: readonly JobColumnModel[]
  readonly unresolved: readonly BoardCardModel[]
}

const ATTENTION_ORDER: Record<FeatureListItem["status"], number> = {
  waiting_human: 0,
  escalated: 1,
  running: 2,
  paused: 3,
  done: 4,
  abandoned: 4,
}

export interface ScopeIdentity {
  readonly projectDir: string
  readonly workflow: string
}

/** Build the job columns for one project+workflow scope. */
export function deriveWorkflowBoard(
  items: readonly FeatureListItem[],
  workflow: WorkflowProjection,
  scope: ScopeIdentity,
  now: number,
): WorkflowBoardModel {
  const order = jobColumnOrder(workflow)
  const columnMap = new Map<string, FrontierCardModel[]>()
  for (const jobId of order) columnMap.set(jobId, [])
  const unresolved: BoardCardModel[] = []

  for (const item of items) {
    if (item.projectDir !== scope.projectDir) continue
    if ((item.workflow ?? "default") !== scope.workflow) continue
    if (item.status !== "running" && item.status !== "waiting_human" && item.status !== "escalated") continue

    const frontier = resolveFrontierJobIds(item)
    const base = cardModel(item, now)
    if (frontier.kind === null) {
      unresolved.push(base)
      continue
    }
    for (const jobId of frontier.jobIds) {
      const card: FrontierCardModel = {
        ...base,
        cardId: `${item.id}::${jobId}`,
        jobId,
        jobStatus: item.jobs[jobId]?.status ?? "pending",
        frontierKind: frontier.kind,
        parallelCount: frontier.jobIds.length,
      }
      const bucket = columnMap.get(jobId)
      if (bucket === undefined) columnMap.set(jobId, [card])
      else bucket.push(card)
    }
  }

  for (const bucket of columnMap.values()) {
    bucket.sort((a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status] || a.updatedAt - b.updatedAt)
  }
  unresolved.sort((a, b) => a.updatedAt - b.updatedAt)

  // Columns follow workflow declaration order, plus any job id that only
  // shows up in runtime status (e.g. a stale projection) appended after.
  const known = new Set(order)
  const extra = [...columnMap.keys()].filter(id => !known.has(id))
  const columns: JobColumnModel[] = [...order, ...extra].map(jobId => ({
    jobId,
    cards: columnMap.get(jobId) ?? [],
  }))

  return { columns, unresolved }
}

export const RECENT_PREVIEW_LIMIT = 8

export interface OverviewModel {
  /** waiting_human/escalated across every scope, oldest-waiting first. */
  readonly urgent: readonly BoardCardModel[]
  readonly paused: readonly BoardCardModel[]
  /** done/abandoned, most-recently-updated first, capped for the compact
   *  preview strip — a prefix of `recentAll`. */
  readonly recent: readonly BoardCardModel[]
  /** The complete done/abandoned collection, most-recently-updated first.
   *  Entries beyond `RECENT_PREVIEW_LIMIT` are not lost — the "show all"
   *  expansion renders this collection in full. */
  readonly recentAll: readonly BoardCardModel[]
}

/** Cross-workflow triage strip: urgent attention, paused, recent history. */
export function deriveOverview(items: readonly FeatureListItem[], now: number): OverviewModel {
  const zones = groupIntoZones(items, now)
  const recentAll = [...zones.terminal].sort((a, b) => b.updatedAt - a.updatedAt)
  return { urgent: zones["needs-you"], paused: zones.paused, recent: recentAll.slice(0, RECENT_PREVIEW_LIMIT), recentAll }
}
