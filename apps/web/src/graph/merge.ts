/**
 * Join workflow structure (`/v1/projects/workflow`) with live runtime
 * (feature detail) into a graph model — pure, DOM-free, unit-tested.
 *
 * Status→glyph semantics live here: ✓ done · ● running · ◐ waiting/gate ·
 * ○ pending · ⤼ skipped (variant-a legend). The "current" node reads from
 * color alone — a job whose status is `running`/`ready` gets the amber
 * treatment (a waiting_human gate leaves its job `running`, so the gate
 * node is amber while the feature waits).
 *
 * Loop-edge predicate (feedback lifecycle, `docs/http-api.md`): the
 * feedback snapshot means "a rerun has happened at least once", never
 * "a loop is active now". The edge is drawn only while the rerun target
 * job is the active one. The routing job is identified as the owner of a
 * non-zero `reruns` counter (the engine records rounds on the routing
 * step's job); the active target is a job named in the feedback snapshot
 * that is currently `running`/`ready`.
 */

import type { FeatureDetail, JobRuntimeProjection, JobStatus, StepKind, StepStatus, WorkflowProjection } from "../api/types.ts"

export interface GraphStep {
  readonly id: string
  readonly kind: StepKind
  readonly status: StepStatus
  readonly attempts: number
  readonly reruns: number
  readonly truncated: boolean
  readonly runId: string | null
}

export interface GraphJob {
  readonly id: string
  readonly status: JobStatus
  readonly currentStep: string | null
  readonly steps: readonly GraphStep[]
  /** Highest per-step rerun count — the "⟲ round N" chip number. */
  readonly round: number
  readonly isCurrent: boolean
}

export interface LoopEdge {
  readonly from: string
  readonly to: string
  readonly message: string
}

export interface GraphModel {
  readonly name: string
  readonly stale: boolean
  readonly diagnostics: readonly string[]
  readonly jobs: readonly GraphJob[]
  readonly loopEdge: LoopEdge | null
}

export interface MergeInput {
  readonly workflow: WorkflowProjection
  readonly detail: FeatureDetail
}

function isActive(status: JobStatus | undefined): boolean {
  return status === "running" || status === "ready"
}

function highestRerun(runtime: JobRuntimeProjection | undefined): number {
  if (runtime === undefined) return 0
  let max = 0
  for (const rounds of Object.values(runtime.reruns)) max = Math.max(max, rounds)
  return max
}

export function mergeGraph(input: MergeInput): GraphModel {
  const { workflow, detail } = input

  const jobs: GraphJob[] = []
  for (const [jobId, jobDef] of Object.entries(workflow.jobs)) {
    const runtime = detail.jobs[jobId]
    const steps: GraphStep[] = jobDef.steps.map(step => {
      const stepRuntime = runtime?.steps[step.id]
      return {
        id: step.id,
        kind: step.kind,
        status: stepRuntime?.status ?? "pending",
        attempts: runtime?.attempts[step.id] ?? 0,
        reruns: runtime?.reruns[step.id] ?? 0,
        truncated: stepRuntime?.truncated ?? false,
        runId: stepRuntime?.runId ?? null,
      }
    })
    jobs.push({
      id: jobId,
      status: runtime?.status ?? "pending",
      currentStep: runtime?.currentStep ?? null,
      steps,
      round: highestRerun(runtime),
      isCurrent: isActive(runtime?.status),
    })
  }

  return {
    name: workflow.name,
    stale: workflow.stale || (detail.workflowRef?.stale ?? false),
    diagnostics: workflow.diagnostics,
    jobs,
    loopEdge: loopEdgeOf(detail, new Set(jobs.map(job => job.id))),
  }
}

/** The loop-edge predicate described in the module doc. */
export function loopEdgeOf(
  detail: FeatureDetail,
  knownJobIds: ReadonlySet<string>,
): LoopEdge | null {
  const feedback = detail.feedback
  if (feedback === null) return null

  let routingJobId: string | null = null
  for (const [jobId, runtime] of Object.entries(detail.jobs)) {
    for (const rounds of Object.values(runtime.reruns)) {
      if (rounds > 0) {
        routingJobId = jobId
        break
      }
    }
    if (routingJobId !== null) break
  }
  if (routingJobId === null || !knownJobIds.has(routingJobId)) return null

  const target = Object.keys(feedback.jobs).find(
    jobId =>
      jobId !== routingJobId &&
      knownJobIds.has(jobId) &&
      isActive(detail.jobs[jobId]?.status),
  )
  if (target !== undefined) {
    return { from: routingJobId, to: target, message: feedback.message }
  }

  // Steps-scope rerun: the snapshot names only the routing job (the
  // engine collects feedback from the routing job alone for steps scope),
  // and that job is re-running its own steps. A jobs-scope snapshot whose
  // targets have completed draws nothing — the loop is history.
  const namedJobs = Object.keys(feedback.jobs)
  const stepsScope = namedJobs.every(jobId => jobId === routingJobId)
  if (stepsScope && isActive(detail.jobs[routingJobId]?.status)) {
    return { from: routingJobId, to: routingJobId, message: feedback.message }
  }

  return null
}

/** Short, content-safe project name for card labels. */
export function projectBasename(projectDir: string): string {
  const trimmed = projectDir.replace(/\/+$/, "")
  const parts = trimmed.split("/")
  return parts[parts.length - 1] ?? trimmed
}

/** The single step of the active job that names the current position. */
export function currentStepLabel(detail: FeatureDetail): string | null {
  return detail.currentStep
}

/** Step status → glyph, per variant-a legend. */
export function stepGlyph(status: StepStatus): string {
  switch (status) {
    case "succeeded":
      return "✓"
    case "running":
      return "●"
    case "waiting_human":
    case "escalated":
      return "◐"
    case "failed":
      return "✖"
    case "skipped":
      return "⤼"
    case "pending":
      return "○"
  }
}
