/**
 * Workflow-scoped board derivation — pure, DOM-free.
 *
 * The board is organised by pipeline *stage*: every job at the same
 * dependency layer (longest path through `needs`, the same `assignLayers`
 * the graph canvas uses) shares one stage. A wide fan-out — eight
 * parallel reviewers — is one stage, not eight mostly-empty columns.
 *
 * A feature's cards sit at its active job *frontier*: every currently
 * running job, or every ready job when none is running, or (for an
 * escalated feature with no running/ready job) every failed job as a
 * fallback so the escalation still lands somewhere concrete. One card
 * per stage the frontier touches, listing the jobs and current steps
 * inside it. A feature that resolves to no frontier job stays out of the
 * lanes entirely and surfaces in an explicit diagnostic tray instead.
 *
 * Paused and terminal (done/abandoned) features never occupy a stage:
 * they belong to the compact cross-workflow overview/recent sections
 * (`deriveOverview`) so the lanes stay focused on work in flight.
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

/** One project the daemon currently has registered — `workflowName` is
 *  `null` when the project's workflow is unregistered/invalid (mirrors
 *  `item.workflow`'s "no name yet" case), which yields the same
 *  `"default"` sentinel `scopeKey` uses for a feature with no workflow. */
export interface RegisteredProject {
  readonly projectDir: string
  readonly workflowName: string | null
}

/**
 * Group features into project+workflow scopes, busiest first — plus a
 * zero-count base scope for every registered project (D1: "scopes =
 * registry ⋈ workflow, features decorate"), so a scope exists even for a
 * project with no features yet. Feature-derived entries merge onto a
 * matching base scope's counts; a feature whose workflow name differs
 * from its project's currently registered one still gets its own scope
 * (unchanged from the feature-only behaviour this supersedes).
 */
export function deriveWorkflowScopes(
  items: readonly FeatureListItem[],
  registeredProjects: readonly RegisteredProject[] = [],
): readonly WorkflowScopeSummary[] {
  const map = new Map<string, { projectDir: string; workflow: string; featureCount: number; activeCount: number }>()
  for (const project of registeredProjects) {
    const workflow = project.workflowName ?? "default"
    const key = scopeKey(project.projectDir, workflow)
    if (!map.has(key)) map.set(key, { projectDir: project.projectDir, workflow, featureCount: 0, activeCount: 0 })
  }
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

/** One pipeline stage: every job at the same dependency layer. Parallel
 *  fan-out jobs (e.g. eight reviewers) share a stage instead of each
 *  claiming an almost-always-empty column of its own. */
export interface StageDef {
  readonly index: number
  readonly label: string
  readonly jobIds: readonly string[]
}

export function deriveStages(workflow: WorkflowProjection): readonly StageDef[] {
  const jobs = Object.entries(workflow.jobs).map(([id, def]) => ({ id, needs: def.needs, stepCount: def.steps.length }))
  const layers = assignLayers(jobs)
  const byLayer = new Map<number, string[]>()
  for (const job of jobs) {
    const layer = layers.get(job.id) ?? 0
    const bucket = byLayer.get(layer)
    if (bucket === undefined) byLayer.set(layer, [job.id])
    else bucket.push(job.id)
  }
  return [...byLayer.keys()]
    .sort((a, b) => a - b)
    .map((layer, index) => {
      const jobIds = byLayer.get(layer)!
      return { index, label: stageLabel(jobIds), jobIds }
    })
}

/** `review_code_core`+`review_gpt` → "review ×2"; a single job keeps its
 *  own id; unrelated parallel jobs read "first +N". */
export function stageLabel(jobIds: readonly string[]): string {
  if (jobIds.length === 1) return jobIds[0]!
  let prefix = jobIds[0]!
  for (const id of jobIds.slice(1)) {
    let i = 0
    while (i < prefix.length && i < id.length && prefix[i] === id[i]) i++
    prefix = prefix.slice(0, i)
  }
  const cut = Math.max(prefix.lastIndexOf("_"), prefix.lastIndexOf("-"), prefix.lastIndexOf("."))
  const stem = cut > 0 ? prefix.slice(0, cut) : ""
  return stem !== "" ? `${stem} ×${jobIds.length}` : `${jobIds[0]} +${jobIds.length - 1}`
}

/** One active job of a feature inside a stage, with the step it is on. */
export interface ActiveJobRef {
  readonly jobId: string
  readonly status: JobStatus
  readonly stepId: string | null
}

export interface FrontierCardModel extends BoardCardModel {
  /** `${featureId}::${stageIndex}` — card identity when one feature spans stages. */
  readonly cardId: string
  readonly stageIndex: number
  /** The feature's frontier jobs inside this stage. */
  readonly activeJobs: readonly ActiveJobRef[]
  readonly frontierKind: FrontierKind
  /** Count of frontier jobs across the whole workflow; >1 marks it parallel. */
  readonly parallelCount: number
}

export interface StageColumnModel extends StageDef {
  readonly cards: readonly FrontierCardModel[]
}

export interface WorkflowBoardModel {
  /** Every stage in pipeline order, occupied or not — the rail. */
  readonly stages: readonly StageColumnModel[]
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

export function isAttentionStatus(status: FeatureListItem["status"]): boolean {
  return status === "waiting_human" || status === "escalated"
}

export interface ScopeIdentity {
  readonly projectDir: string
  readonly workflow: string
}

/** Build the stage lanes for one project+workflow scope. */
export function deriveWorkflowBoard(
  items: readonly FeatureListItem[],
  workflow: WorkflowProjection,
  scope: ScopeIdentity,
  now: number,
): WorkflowBoardModel {
  const stageDefs = deriveStages(workflow)
  const stageOfJob = new Map<string, number>()
  for (const stage of stageDefs) for (const jobId of stage.jobIds) stageOfJob.set(jobId, stage.index)
  const extraStages: StageDef[] = []
  const buckets = new Map<number, FrontierCardModel[]>()
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
    const byStage = new Map<number, ActiveJobRef[]>()
    for (const jobId of frontier.jobIds) {
      let stageIndex = stageOfJob.get(jobId)
      if (stageIndex === undefined) {
        // A job only present in runtime state (stale projection) gets a
        // trailing stage of its own rather than vanishing.
        stageIndex = stageDefs.length + extraStages.length
        extraStages.push({ index: stageIndex, label: jobId, jobIds: [jobId] })
        stageOfJob.set(jobId, stageIndex)
      }
      const job = item.jobs[jobId]
      const ref: ActiveJobRef = { jobId, status: job?.status ?? "pending", stepId: job?.currentStep ?? null }
      const list = byStage.get(stageIndex)
      if (list === undefined) byStage.set(stageIndex, [ref])
      else list.push(ref)
    }
    for (const [stageIndex, activeJobs] of byStage) {
      const card: FrontierCardModel = {
        ...base,
        cardId: `${item.id}::${stageIndex}`,
        stageIndex,
        activeJobs,
        frontierKind: frontier.kind,
        parallelCount: frontier.jobIds.length,
      }
      const bucket = buckets.get(stageIndex)
      if (bucket === undefined) buckets.set(stageIndex, [card])
      else bucket.push(card)
    }
  }

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status] || a.updatedAt - b.updatedAt)
  }
  unresolved.sort((a, b) => a.updatedAt - b.updatedAt)

  const stages: StageColumnModel[] = [...stageDefs, ...extraStages].map(stage => ({
    ...stage,
    cards: buckets.get(stage.index) ?? [],
  }))
  return { stages, unresolved }
}

/** The stage to bring into view first: earliest one needing a human,
 *  else the earliest occupied one. */
export function focusStageIndex(board: WorkflowBoardModel): number | null {
  const attention = board.stages.find(stage => stage.cards.some(card => isAttentionStatus(card.status)))
  if (attention !== undefined) return attention.index
  return board.stages.find(stage => stage.cards.length > 0)?.index ?? null
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
