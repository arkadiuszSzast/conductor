/**
 * The workflow interpreter — a pure function.
 *
 *   (workflow definition, feature state, event) → transition
 *
 * No I/O, no clock, no randomness. The engine (reconciler/executor) owns
 * all side effects; this module owns ALL routing decisions. Keeping it
 * pure makes every workflow shape unit-testable without a database, a
 * git repo, or an LLM.
 *
 * DAG-aware: a single event can produce multiple decisions (fan-out when
 * a completed job unblocks several dependents). The common case — one job,
 * linear steps — produces exactly one decision.
 */

import { DEFAULT_OUTCOME } from "./types.ts"
import type {
  Decision,
  FeatureState,
  FeatureStatus,
  Feedback,
  JobDef,
  JobPatch,
  Patch,
  PipelineEvent,
  RerunTarget,
  Route,
  StepDef,
  Transition,
  WorkflowDef,
} from "./types.ts"

const DEFAULT_MAX_ATTEMPTS = 1

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function interpret(
  workflow: WorkflowDef,
  state: FeatureState,
  event: PipelineEvent,
): Transition {
  switch (event.kind) {
    case "feature.start":     return onStart(workflow)
    case "step.completed":    return onCompleted(workflow, state, event.jobId, event.stepId, event.outcome ?? DEFAULT_OUTCOME, event.output)
    case "step.failed":       return onFailed(workflow, state, event.jobId, event.stepId, event.reason)
    case "human.paused":      return buildTransition([{ kind: "pause" }], { status: "paused" })
    case "human.resumed":     return onResumed(workflow, state)
    case "human.abandoned":   return buildTransition([{ kind: "abandon" }], { status: "abandoned" })
  }
}

export function isTerminal(decision: Decision): boolean {
  return decision.kind === "finish" || decision.kind === "abandon" || decision.kind === "escalate"
}

// ---------------------------------------------------------------------------
// Transition builder
// ---------------------------------------------------------------------------

function buildTransition(decisions: readonly Decision[], patch: Patch): Transition {
  return { decisions, patch }
}

function noopTransition(reason: string): Transition {
  return buildTransition([{ kind: "noop", reason }], {})
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function findJob(workflow: WorkflowDef, jobId: string): JobDef | undefined {
  return workflow.jobs[jobId]
}

function findStep(job: JobDef, stepId: string): StepDef | undefined {
  return job.steps.find(step => step.id === stepId)
}

function stepIndex(job: JobDef, stepId: string): number {
  return job.steps.findIndex(step => step.id === stepId)
}

function firstStepId(job: JobDef): string | null {
  return job.steps[0]?.id ?? null
}

/** The next step along the job's path: the next step in declaration order.
 *  Any other destination is an explicit `goto`/`rerun` route. */
function nextStepId(job: JobDef, currentStep: StepDef): string | null {
  const index = stepIndex(job, currentStep.id)
  return job.steps[index + 1]?.id ?? null
}

// ---------------------------------------------------------------------------
// Step entry: dispatch to execute or wait_human
// ---------------------------------------------------------------------------

function enterStep(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  stepId: string | null,
): Transition {
  if (stepId === null) return onJobComplete(workflow, state, jobId)

  const job = findJob(workflow, jobId)
  if (!job) {
    return buildTransition(
      [{ kind: "escalate", reason: `unknown job "${jobId}"` }],
      { status: "escalated" },
    )
  }

  const step = findStep(job, stepId)
  if (!step) {
    return buildTransition(
      [{ kind: "escalate", reason: `unknown step "${stepId}" in job "${jobId}"` }],
      { status: "escalated" },
    )
  }

  const jobPatch: JobPatch = { status: "running", currentStep: stepId }

  if (step.type === "human") {
    return buildTransition(
      [{ kind: "wait_human", jobId, stepId }],
      {
        status: "waiting_human",
        jobs: {
          [jobId]: {
            ...jobPatch,
            steps: { [stepId]: { status: "waiting_human" } },
          },
        },
      },
    )
  }

  return buildTransition(
    [{ kind: "execute_step", jobId, stepId }],
    { jobs: { [jobId]: { ...jobPatch, steps: { [stepId]: { status: "running" } } } } },
  )
}

// ---------------------------------------------------------------------------
// Rerun (cross-job feedback loop)
// ---------------------------------------------------------------------------

/** Transitive downstream closure: the rerun targets plus every job that
 *  transitively depends on them through `needs`. */
function computeRerunClosure(rerunJobIds: readonly string[], workflow: WorkflowDef): Set<string> {
  const closure = new Set(rerunJobIds)
  let changed = true
  while (changed) {
    changed = false
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      if (closure.has(jobId)) continue
      if (job.needs?.some(need => closure.has(need))) {
        closure.add(jobId)
        changed = true
      }
    }
  }
  return closure
}

function onRerun(
  workflow: WorkflowDef,
  state: FeatureState,
  routingJobId: string,
  routingStepId: string,
  rerun: RerunTarget,
  reason: string,
  routingStepOutput?: string,
): Transition {
  const routingRuntime = state.jobs[routingJobId]
  const rounds = (routingRuntime?.reruns[routingStepId] ?? 0) + 1

  if (rounds > rerun.maxRounds) {
    return buildTransition(
      [{ kind: "escalate", reason: `"${routingJobId}/${routingStepId}" exhausted ${rerun.maxRounds} rerun round(s)` }],
      { status: "escalated" },
    )
  }

  const feedback = buildFeedback(state, rerun, routingJobId, routingStepId, reason, routingStepOutput)

  // Step scope: loop back inside the routing job — the job keeps running and
  // only the named steps are re-executed. Job scope: reset the targets and
  // their downstream closure so fan-in re-triggers the routing job.
  return rerun.scope === "steps"
    ? rerunSteps(workflow, routingJobId, routingStepId, rerun.stepIds, rounds, routingRuntime, feedback)
    : rerunJobs(workflow, state, routingJobId, routingStepId, rerun.jobIds, rounds, routingRuntime, feedback)
}

function buildFeedback(
  state: FeatureState,
  rerun: RerunTarget,
  routingJobId: string,
  routingStepId: string,
  reason: string,
  routingStepOutput?: string,
): Feedback {
  const feedbackJobs: Record<string, Record<string, string>> = {}

  const collectFrom = (jobId: string, only?: readonly string[]): void => {
    const jobRuntime = state.jobs[jobId]
    if (!jobRuntime) return
    const stepOutputs: Record<string, string> = {}
    for (const [stepId, stepState] of Object.entries(jobRuntime.steps)) {
      if (only && !only.includes(stepId)) continue
      if (stepState.output !== null) stepOutputs[stepId] = stepState.output
    }
    if (Object.keys(stepOutputs).length > 0) {
      feedbackJobs[jobId] = { ...feedbackJobs[jobId], ...stepOutputs }
    }
  }

  if (rerun.scope === "steps") {
    collectFrom(routingJobId)
  } else {
    for (const jobId of rerun.jobIds) collectFrom(jobId)
  }

  const routingOutput = routingStepOutput ?? state.jobs[routingJobId]?.steps[routingStepId]?.output
  if (routingOutput !== null && routingOutput !== undefined) {
    feedbackJobs[routingJobId] = { ...feedbackJobs[routingJobId], [routingStepId]: routingOutput }
  }

  return { jobs: feedbackJobs, message: reason }
}

function rerunSteps(
  workflow: WorkflowDef,
  routingJobId: string,
  routingStepId: string,
  stepIds: readonly string[],
  rounds: number,
  routingRuntime: FeatureState["jobs"][string] | undefined,
  feedback: Feedback,
): Transition {
  const job = findJob(workflow, routingJobId)
  const entryStepId = stepIds[0]
  const step = job && entryStepId !== undefined ? findStep(job, entryStepId) : undefined

  if (!job || entryStepId === undefined || !step) {
    return buildTransition(
      [{ kind: "escalate", reason: `rerun step "${entryStepId ?? "<none>"}" does not exist in job "${routingJobId}"` }],
      { status: "escalated" },
    )
  }

  const clearedSteps: Record<string, { status: "pending"; output: null }> = {}
  for (const stepId of stepIds) clearedSteps[stepId] = { status: "pending", output: null }

  const jobPatch: JobPatch = {
    status: "running",
    currentStep: entryStepId,
    reruns: { ...routingRuntime?.reruns, [routingStepId]: rounds },
    steps: {
      ...clearedSteps,
      [entryStepId]: step.type === "human" ? { status: "waiting_human" } : { status: "running" },
    },
  }

  const decision: Decision = step.type === "human"
    ? { kind: "wait_human", jobId: routingJobId, stepId: entryStepId }
    : { kind: "execute_step", jobId: routingJobId, stepId: entryStepId }

  return {
    decisions: [decision],
    patch: {
      status: step.type === "human" ? "waiting_human" : "running",
      jobs: { [routingJobId]: jobPatch },
    },
    feedback,
  }
}

function rerunJobs(
  workflow: WorkflowDef,
  state: FeatureState,
  routingJobId: string,
  routingStepId: string,
  jobIds: readonly string[],
  rounds: number,
  routingRuntime: FeatureState["jobs"][string] | undefined,
  feedback: Feedback,
): Transition {
  const closure = computeRerunClosure(jobIds, workflow)
  const jobPatches: Record<string, JobPatch> = {}

  for (const closureJobId of closure) {
    jobPatches[closureJobId] = {
      status: "pending",
      currentStep: null,
      attempts: {},
      reruns: closureJobId === routingJobId
        ? { ...routingRuntime?.reruns, [routingStepId]: rounds }
        : {},
      outputs: {},
      steps: {},
    }
  }

  if (!closure.has(routingJobId)) {
    jobPatches[routingJobId] = {
      status: "pending",
      currentStep: null,
      attempts: {},
      reruns: { ...routingRuntime?.reruns, [routingStepId]: rounds },
      outputs: {},
      steps: {},
    }
  }

  const decisions: Decision[] = []

  for (const rerunJobId of jobIds) {
    const rerunJob = findJob(workflow, rerunJobId)
    if (!rerunJob) {
      decisions.push({ kind: "skip_job", jobId: rerunJobId, reason: "job no longer exists" })
      continue
    }
    const stepId = firstStepId(rerunJob)
    if (!stepId) {
      jobPatches[rerunJobId] = { ...jobPatches[rerunJobId], status: "succeeded", currentStep: null }
      continue
    }
    const step = findStep(rerunJob, stepId)!
    if (step.type === "human") {
      decisions.push({ kind: "wait_human", jobId: rerunJobId, stepId })
      jobPatches[rerunJobId] = {
        ...jobPatches[rerunJobId],
        status: "running",
        currentStep: stepId,
        steps: { [stepId]: { status: "waiting_human" } },
      }
    } else {
      decisions.push({ kind: "execute_step", jobId: rerunJobId, stepId })
      jobPatches[rerunJobId] = {
        ...jobPatches[rerunJobId],
        status: "running",
        currentStep: stepId,
        steps: { [stepId]: { status: "running" } },
      }
    }
  }

  return { decisions, patch: { status: "running", jobs: jobPatches }, feedback }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onStart(workflow: WorkflowDef): Transition {
  const readyJobs: string[] = []
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!job.needs || job.needs.length === 0) readyJobs.push(jobId)
  }

  if (readyJobs.length === 0) {
    return buildTransition([{ kind: "finish" }], { status: "done" })
  }

  const decisions: Decision[] = []
  const jobPatches: Record<string, JobPatch> = {}

  for (const jobId of readyJobs) {
    const job = findJob(workflow, jobId)!
    const stepId = firstStepId(job)
    if (stepId === null) {
      jobPatches[jobId] = { status: "succeeded", currentStep: null }
      continue
    }
    const step = findStep(job, stepId)!
    if (step.type === "human") {
      decisions.push({ kind: "wait_human", jobId, stepId })
      jobPatches[jobId] = {
        status: "running",
        currentStep: stepId,
        steps: { [stepId]: { status: "waiting_human" } },
      }
    } else {
      decisions.push({ kind: "execute_step", jobId, stepId })
      jobPatches[jobId] = {
        status: "running",
        currentStep: stepId,
        steps: { [stepId]: { status: "running" } },
      }
    }
  }

  return buildTransition(decisions, { status: "running", jobs: jobPatches })
}

/**
 * A step finished its work and reported an outcome. One mechanism covers
 * every "it worked, here is the result" case: plain completion, review
 * verdicts, consensus checks, classifiers. `step.failed` is the separate
 * "it could not do its work" path with its own retry budget.
 */
function onCompleted(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  stepId: string,
  outcome: string,
  output?: string,
): Transition {
  const jobRuntime = state.jobs[jobId]
  if (!jobRuntime || jobRuntime.currentStep !== stepId) {
    return noopTransition(`stale completion for "${jobId}/${stepId}"`)
  }

  const job = findJob(workflow, jobId)
  const step = job && findStep(job, stepId)
  if (!job || !step) {
    return buildTransition(
      [{ kind: "escalate", reason: `unknown step "${stepId}"` }],
      { status: "escalated" },
    )
  }

  const completedPatch: Patch = {
    jobs: { [jobId]: { steps: { [stepId]: { status: "succeeded", output: output ?? null } } } },
  }

  const declaresOutcomes = Object.keys(step.outcomes).length > 0

  // No declared outcomes: any outcome simply advances along the step path.
  if (!declaresOutcomes) {
    return applyRoute(
      { kind: "next" }, workflow, state, job, step, `outcome "${outcome}"`, completedPatch, output,
    )
  }

  const route = step.outcomes[outcome]
  if (!route) {
    return buildTransition(
      [{ kind: "escalate", reason: `unmapped outcome "${outcome}" at "${jobId}/${stepId}"` }],
      mergePatches(completedPatch, { status: "escalated" }),
    )
  }

  return applyRoute(
    route, workflow, state, job, step, `outcome "${outcome}"`, completedPatch, output,
  )
}

/**
 * Follow a route. The single place that knows how each route variant moves
 * the workflow, so outcomes and failures cannot drift apart.
 */
function applyRoute(
  route: Route,
  workflow: WorkflowDef,
  state: FeatureState,
  job: JobDef,
  step: StepDef,
  reason: string,
  basePatch: Patch,
  output?: string,
): Transition {
  const jobId = jobIdOf(workflow, job)

  switch (route.kind) {
    case "next": {
      const entry = enterStep(workflow, state, jobId, nextStepId(job, step))
      return buildTransition(entry.decisions as Decision[], mergePatches(basePatch, entry.patch))
    }
    case "goto": {
      const entry = enterStep(workflow, state, jobId, route.stepId)
      return buildTransition(entry.decisions as Decision[], mergePatches(basePatch, entry.patch))
    }
    case "rerun": {
      const rerun = onRerun(workflow, state, jobId, step.id, route.target, reason, output)
      return {
        decisions: rerun.decisions,
        patch: mergePatches(basePatch, rerun.patch),
        feedback: rerun.feedback,
      }
    }
  }
  return noopTransition(`unreachable route on "${step.id}"`)
}

function jobIdOf(workflow: WorkflowDef, job: JobDef): string {
  for (const [jobId, candidate] of Object.entries(workflow.jobs)) {
    if (candidate === job) return jobId
  }
  return ""
}

function onFailed(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  stepId: string,
  reason: string,
): Transition {
  const jobRuntime = state.jobs[jobId]
  if (!jobRuntime || jobRuntime.currentStep !== stepId) {
    return noopTransition(`stale failure for "${jobId}/${stepId}"`)
  }

  const job = findJob(workflow, jobId)
  const step = job && findStep(job, stepId)
  if (!job || !step) {
    return buildTransition(
      [{ kind: "escalate", reason: `unknown step "${stepId}"` }],
      { status: "escalated" },
    )
  }

  const attempts = (jobRuntime.attempts[stepId] ?? 0) + 1
  const failedPatch: JobPatch = {
    attempts: { ...jobRuntime.attempts, [stepId]: attempts },
    steps: { [stepId]: { status: "failed" } },
  }

  const retryMaxAttempts = step.retry.strategy === "backoff"
    ? step.retry.maxAttempts
    : DEFAULT_MAX_ATTEMPTS

  if (attempts >= retryMaxAttempts) {
    const failureReason = `"${jobId}/${stepId}" exhausted ${retryMaxAttempts} attempt(s): ${reason}`
    if (step.onFail === undefined) {
      return buildTransition(
        [{ kind: "escalate", reason: failureReason }],
        { status: "escalated", jobs: { [jobId]: failedPatch } },
      )
    }
    return applyRoute(
      step.onFail, workflow, state, job, step, failureReason,
      { jobs: { [jobId]: failedPatch } },
    )
  }

  return buildTransition(
    [{ kind: "execute_step", jobId, stepId }],
    {
      status: "running",
      jobs: {
        [jobId]: {
          ...failedPatch,
          status: "running",
          currentStep: stepId,
          steps: { [stepId]: { status: "running" } },
        },
      },
    },
  )
}

function onResumed(workflow: WorkflowDef, state: FeatureState): Transition {
  if (state.status !== "paused" && state.status !== "escalated") {
    return noopTransition("feature is not paused or escalated")
  }

  const decisions: Decision[] = []
  const jobPatches: Record<string, JobPatch> = {}

  for (const [jobId, jobRuntime] of Object.entries(state.jobs)) {
    if (jobRuntime.status !== "running" || jobRuntime.currentStep === null) continue

    const job = findJob(workflow, jobId)
    if (!job) {
      decisions.push({ kind: "escalate", reason: `job "${jobId}" no longer exists` })
      continue
    }

    const step = findStep(job, jobRuntime.currentStep)
    if (!step) {
      decisions.push({ kind: "escalate", reason: `step "${jobRuntime.currentStep}" no longer exists` })
      continue
    }

    const budgetReset: JobPatch = state.status === "escalated"
      ? {
          attempts: { ...jobRuntime.attempts, [jobRuntime.currentStep]: 0 },
          reruns: { ...jobRuntime.reruns, [jobRuntime.currentStep]: 0 },
        }
      : {}

    if (step.type === "human") {
      decisions.push({ kind: "wait_human", jobId, stepId: step.id })
      jobPatches[jobId] = { ...budgetReset, steps: { [step.id]: { status: "waiting_human" } } }
    } else {
      decisions.push({ kind: "execute_step", jobId, stepId: step.id })
      jobPatches[jobId] = { ...budgetReset, steps: { [step.id]: { status: "running" } } }
    }
  }

  if (decisions.length === 0) return onStart(workflow)
  return buildTransition(decisions, { status: "running", jobs: jobPatches })
}

// ---------------------------------------------------------------------------
// DAG: job completion and dependent evaluation
// ---------------------------------------------------------------------------

function onJobComplete(
  workflow: WorkflowDef,
  state: FeatureState,
  completedJobId: string,
): Transition {
  const completedPatch: Patch = {
    jobs: { [completedJobId]: { status: "succeeded", currentStep: null } },
  }

  const decisions: Decision[] = []
  const dependentPatches: Record<string, JobPatch> = {}

  for (const [dependentId, dependentJob] of Object.entries(workflow.jobs)) {
    if (state.jobs[dependentId]?.status !== "pending") continue
    if (!dependentJob.needs?.includes(completedJobId)) continue

    const needStatuses = (dependentJob.needs ?? []).map(needId =>
      needId === completedJobId
        ? "satisfied" as const
        : (state.jobs[needId]?.status ?? "pending"),
    )
    const allReady = needStatuses.every(status =>
      status === "satisfied" || status === "succeeded" || status === "failed" || status === "skipped",
    )
    if (!allReady) continue

    const anyFailed = needStatuses.some(status => status === "failed" || status === "skipped")

    if (anyFailed && dependentJob.if !== "always()" && dependentJob.if !== "failure()") {
      decisions.push({ kind: "skip_job", jobId: dependentId, reason: "dependency failed" })
      dependentPatches[dependentId] = { status: "skipped", currentStep: null }
      continue
    }

    const stepId = firstStepId(dependentJob)
    if (stepId === null) {
      dependentPatches[dependentId] = { status: "succeeded", currentStep: null }
      continue
    }

    const step = findStep(dependentJob, stepId)!
    if (step.type === "human") {
      decisions.push({ kind: "wait_human", jobId: dependentId, stepId })
      dependentPatches[dependentId] = {
        status: "running",
        currentStep: stepId,
        steps: { [stepId]: { status: "waiting_human" } },
      }
    } else {
      decisions.push({ kind: "execute_step", jobId: dependentId, stepId })
      dependentPatches[dependentId] = {
        status: "running",
        currentStep: stepId,
        steps: { [stepId]: { status: "running" } },
      }
    }
  }

  const allTerminal = Object.keys(workflow.jobs).every(jobId =>
    jobId === completedJobId
      || dependentPatches[jobId]?.status === "skipped"
      || ["succeeded", "failed", "skipped"].includes(state.jobs[jobId]?.status ?? "pending"),
  )

  if (allTerminal) {
    return buildTransition(
      [{ kind: "finish" }],
      mergePatches(completedPatch, mergePatches({ jobs: dependentPatches }, { status: "done" })),
    )
  }

  if (decisions.length === 0) {
    return buildTransition(
      [{ kind: "noop", reason: `job "${completedJobId}" completed, no dependents ready` }],
      mergePatches(completedPatch, { jobs: dependentPatches }),
    )
  }

  return buildTransition(decisions, mergePatches(completedPatch, { jobs: dependentPatches }))
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

function mergePatches(base: Patch, extra: Patch): Patch {
  const result: { status?: FeatureStatus; jobs?: Record<string, JobPatch> } = {}
  if (base.status) result.status = base.status
  if (extra.status) result.status = extra.status
  if (base.jobs || extra.jobs) {
    const merged: Record<string, JobPatch> = {}
    for (const [jobId, jobPatch] of Object.entries(base.jobs ?? {})) {
      merged[jobId] = jobPatch
    }
    for (const [jobId, jobPatch] of Object.entries(extra.jobs ?? {})) {
      merged[jobId] = merged[jobId] ? mergeJobPatches(merged[jobId]!, jobPatch) : jobPatch
    }
    result.jobs = merged
  }
  return result
}

function mergeJobPatches(base: JobPatch, extra: JobPatch): JobPatch {
  return {
    status: extra.status ?? base.status,
    currentStep: extra.currentStep ?? base.currentStep,
    attempts: extra.attempts ?? base.attempts,
    reruns: extra.reruns ?? base.reruns,
    outputs: extra.outputs ?? base.outputs,
    steps: { ...base.steps, ...extra.steps },
  }
}
