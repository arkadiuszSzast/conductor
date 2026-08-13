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
import { resolveJobOutputs } from "./template.ts"
import type {
  Decision,
  FeatureState,
  FeatureStatus,
  Feedback,
  JobDef,
  JobPatch,
  JobStatus,
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
    case "step.completed":    return onCompleted(workflow, state, event.jobId, event.stepId, event.outcome ?? DEFAULT_OUTCOME, event.outputs)
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
  completedStepId?: string,
  completedOutputs?: Readonly<Record<string, string>>,
): Transition {
  if (stepId === null) return onJobComplete(workflow, state, jobId, completedStepId ?? "", completedOutputs)

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
  routingStepOutputs?: Readonly<Record<string, string>>,
): Transition {
  const routingRuntime = state.jobs[routingJobId]
  const rounds = (routingRuntime?.reruns[routingStepId] ?? 0) + 1

  if (rounds > rerun.maxRounds) {
    return buildTransition(
      [{ kind: "escalate", reason: `"${routingJobId}/${routingStepId}" exhausted ${rerun.maxRounds} rerun round(s)` }],
      { status: "escalated" },
    )
  }

  const feedback = buildFeedback(state, rerun, routingJobId, routingStepId, reason, routingStepOutputs)

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
  routingStepOutputs?: Readonly<Record<string, string>>,
): Feedback {
  const feedbackJobs: Record<string, Record<string, Readonly<Record<string, string>>>> = {}

  const collectFrom = (jobId: string, only?: readonly string[]): void => {
    const jobRuntime = state.jobs[jobId]
    if (!jobRuntime) return
    const stepOutputs: Record<string, Readonly<Record<string, string>>> = {}
    for (const [stepId, stepState] of Object.entries(jobRuntime.steps)) {
      if (only && !only.includes(stepId)) continue
      if (Object.keys(stepState.outputs).length > 0) stepOutputs[stepId] = stepState.outputs
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

  const routingOutputs = routingStepOutputs ?? state.jobs[routingJobId]?.steps[routingStepId]?.outputs
  if (routingOutputs !== undefined && Object.keys(routingOutputs).length > 0) {
    feedbackJobs[routingJobId] = { ...feedbackJobs[routingJobId], [routingStepId]: routingOutputs }
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

  const clearedSteps: Record<string, { status: "pending"; outputs: Record<string, never> }> = {}
  for (const stepId of stepIds) clearedSteps[stepId] = { status: "pending", outputs: {} }

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
  outputs?: Readonly<Record<string, string>>,
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
    jobs: { [jobId]: { steps: { [stepId]: { status: "succeeded", outputs: outputs ?? {} } } } },
  }

  const declaresOutcomes = Object.keys(step.outcomes).length > 0

  // No declared outcomes: any outcome simply advances along the step path.
  if (!declaresOutcomes) {
    return applyRoute(
      { kind: "next" }, workflow, state, job, step, `outcome "${outcome}"`, completedPatch, outputs,
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
    route, workflow, state, job, step, `outcome "${outcome}"`, completedPatch, outputs,
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
  outputs?: Readonly<Record<string, string>>,
): Transition {
  const jobId = jobIdOf(workflow, job)

  switch (route.kind) {
    case "next": {
      const entry = enterStep(workflow, state, jobId, nextStepId(job, step), step.id, outputs)
      return buildTransition(entry.decisions as Decision[], mergePatches(basePatch, entry.patch))
    }
    case "goto": {
      const entry = enterStep(workflow, state, jobId, route.stepId)
      return buildTransition(entry.decisions as Decision[], mergePatches(basePatch, entry.patch))
    }
    case "rerun": {
      const rerun = onRerun(workflow, state, jobId, step.id, route.target, reason, outputs)
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
      return onJobFailed(workflow, state, jobId, failedPatch, failureReason)
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

/**
 * A job could not finish: its step ran out of retries with no route. The job
 * becomes terminal (`failed`) so the DAG can react — independent branches keep
 * running, dependents skip, and `if: always()`/`failure()` jobs get their turn.
 *
 * The feature only escalates when the failure leaves nothing else to do: every
 * other job — including unrelated branches `propagate` never visits — must be
 * terminal. A human is needed exactly then, not while sibling branches are
 * still working or a gate is waiting.
 */
function onJobFailed(
  workflow: WorkflowDef,
  state: FeatureState,
  failedJobId: string,
  failedPatch: JobPatch,
  reason: string,
): Transition {
  const failurePatch: Patch = {
    jobs: { [failedJobId]: { ...failedPatch, status: "failed", currentStep: null } },
  }

  const cascade = propagate(workflow, state, failedJobId, "failed")
  const patch = mergePatches(failurePatch, { jobs: cascade.jobPatches })

  // `propagate` only walks the failed job's dependents, so unrelated jobs are
  // invisible to it. Mirror `onJobComplete`'s all-jobs check before deciding
  // the failure is the end of the road.
  const allTerminal = allJobsTerminal(workflow, state, cascade, failedJobId)

  // Nothing left to run anywhere: the failure is the end of the road. This
  // must hold even when the cascade still produced skip_job decisions — a
  // failure that skips every dependent (a parallel fan-out whose last branch
  // died, dependents gated on all branches) would otherwise leave the feature
  // hanging in "running" with every job terminal.
  if (allTerminal) {
    return buildTransition(
      [...cascade.decisions, { kind: "escalate", reason }],
      mergePatches(patch, { status: "escalated" }),
    )
  }

  if (cascade.decisions.length === 0) {
    return buildTransition(
      [{ kind: "noop", reason: `job "${failedJobId}" failed, other jobs still active` }],
      patch,
    )
  }

  return buildTransition(cascade.decisions, patch)
}

function onResumed(workflow: WorkflowDef, state: FeatureState): Transition {
  if (state.status !== "paused" && state.status !== "escalated") {
    return noopTransition("feature is not paused or escalated")
  }

  const decisions: Decision[] = []
  const jobPatches: Record<string, JobPatch> = {}

  for (const [jobId, jobRuntime] of Object.entries(state.jobs)) {
    // A job that failed at a step (`onJobFailed`: status "failed", currentStep
    // null) resumes by retrying that step with a fresh budget instead of
    // falling through to onStart and replaying the whole workflow.
    if (jobRuntime.status === "failed") {
      const failedStepId = Object.entries(jobRuntime.steps).find(
        ([, stepRuntime]) => stepRuntime.status === "failed",
      )?.[0]
      if (failedStepId === undefined) {
        decisions.push({
          kind: "escalate",
          reason: `job "${jobId}" failed but no failed step is recorded`,
        })
        continue
      }
      const job = findJob(workflow, jobId)
      const step = job && findStep(job, failedStepId)
      if (!job || !step) {
        decisions.push({
          kind: "escalate",
          reason: `failed step "${failedStepId}" in job "${jobId}" no longer exists`,
        })
        continue
      }
      decisions.push({ kind: "execute_step", jobId, stepId: failedStepId })
      jobPatches[jobId] = {
        status: "running",
        currentStep: failedStepId,
        attempts: { ...jobRuntime.attempts, [failedStepId]: 0 },
        reruns: { ...jobRuntime.reruns, [failedStepId]: 0 },
        steps: { [failedStepId]: { status: "running" } },
      }
      continue
    }

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

/**
 * A job reached a terminal status. Walk the DAG forward to a fixpoint: every
 * dependent whose `needs` are now all terminal either starts or is skipped,
 * and a freshly skipped job is itself terminal, so its own dependents are
 * evaluated in the same pass. Without the fixpoint a multi-hop chain
 * (A → B → C) would leave C pending forever, because no event ever fires for
 * a job that was skipped rather than executed.
 */
interface Cascade {
  readonly decisions: Decision[]
  readonly jobPatches: Record<string, JobPatch>
  readonly terminal: Record<string, JobStatus>
}

function allJobsTerminal(
  workflow: WorkflowDef,
  state: FeatureState,
  cascade: Cascade,
  originJobId: string,
): boolean {
  return Object.keys(workflow.jobs).every(jobId => {
    if (jobId === originJobId) return true
    const patched = cascade.jobPatches[jobId]?.status
    if (patched) return patched === "skipped" || patched === "succeeded"
    const current = state.jobs[jobId]?.status ?? "pending"
    return current === "succeeded" || current === "failed" || current === "skipped"
  })
}

function propagate(
  workflow: WorkflowDef,
  state: FeatureState,
  originJobId: string,
  originStatus: JobStatus,
): Cascade {
  const decisions: Decision[] = []
  const jobPatches: Record<string, JobPatch> = {}
  const terminal: Record<string, JobStatus> = { [originJobId]: originStatus }

  const statusOf = (jobId: string): JobStatus =>
    terminal[jobId] ?? state.jobs[jobId]?.status ?? "pending"

  const isTerminalStatus = (status: JobStatus): boolean =>
    status === "succeeded" || status === "failed" || status === "skipped"

  let changed = true
  while (changed) {
    changed = false

    for (const [dependentId, dependentJob] of Object.entries(workflow.jobs)) {
      if (jobPatches[dependentId]) continue
      if ((state.jobs[dependentId]?.status ?? "pending") !== "pending") continue
      if (dependentJob.needs.length === 0) continue

      const needStatuses = dependentJob.needs.map(statusOf)
      if (!needStatuses.every(isTerminalStatus)) continue

      const anyFailed = needStatuses.some(status => status === "failed" || status === "skipped")
      const condition = dependentJob.if

      const skip = (reason: string): void => {
        decisions.push({ kind: "skip_job", jobId: dependentId, reason })
        jobPatches[dependentId] = { status: "skipped", currentStep: null }
        terminal[dependentId] = "skipped"
        changed = true
      }

      if (anyFailed && condition !== "always()" && condition !== "failure()") {
        skip("a dependency failed or was skipped")
        continue
      }
      if (!anyFailed && condition === "failure()") {
        skip("if: failure() but every dependency succeeded")
        continue
      }

      const stepId = firstStepId(dependentJob)
      if (stepId === null) {
        jobPatches[dependentId] = { status: "succeeded", currentStep: null }
        terminal[dependentId] = "succeeded"
        changed = true
        continue
      }

      const step = findStep(dependentJob, stepId)!
      if (step.type === "human") {
        decisions.push({ kind: "wait_human", jobId: dependentId, stepId })
        jobPatches[dependentId] = {
          status: "running",
          currentStep: stepId,
          steps: { [stepId]: { status: "waiting_human" } },
        }
      } else {
        decisions.push({ kind: "execute_step", jobId: dependentId, stepId })
        jobPatches[dependentId] = {
          status: "running",
          currentStep: stepId,
          steps: { [stepId]: { status: "running" } },
        }
      }
      changed = true
    }
  }

  return { decisions, jobPatches, terminal }
}

function onJobComplete(
  workflow: WorkflowDef,
  state: FeatureState,
  completedJobId: string,
  completedStepId: string,
  completedOutputs?: Readonly<Record<string, string>>,
): Transition {
  const resolvedOutputs = resolveJobOutputs(workflow, state, completedJobId, completedStepId, completedOutputs)
  const completedPatch: Patch = {
    jobs: { [completedJobId]: { status: "succeeded", currentStep: null, outputs: resolvedOutputs } },
  }

  const cascade = propagate(workflow, state, completedJobId, "succeeded")
  const patch = mergePatches(completedPatch, { jobs: cascade.jobPatches })

  const allTerminal = allJobsTerminal(workflow, state, cascade, completedJobId)

  if (allTerminal) {
    const anyFailed = Object.values(cascade.terminal).some(status => status === "failed")
      || Object.values(state.jobs).some(jobRuntime => jobRuntime.status === "failed")
    return buildTransition(
      [...cascade.decisions, { kind: "finish" }],
      mergePatches(patch, { status: anyFailed ? "escalated" : "done" }),
    )
  }

  if (cascade.decisions.length === 0) {
    return buildTransition(
      [{ kind: "noop", reason: `job "${completedJobId}" completed, no dependents ready` }],
      patch,
    )
  }

  return buildTransition(cascade.decisions, patch)
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

/**
 * `??` treats `null` as nullish, which loses meaning for nullable fields:
 * an explicit `currentStep: null` on `extra` (every rerun sets that on the
 * closure jobs) would silently fall back to `base.currentStep` = `undefined`,
 * leaving a job in an inconsistent `pending` + old-currentStep state. Use
 * `in`-checks so an explicit `null` in `extra` overrides the base.
 */
function mergeJobPatches(base: JobPatch, extra: JobPatch): JobPatch {
  const pick = <K extends keyof JobPatch>(key: K): JobPatch[K] =>
    (key in extra ? extra[key] : base[key])

  return {
    status: pick("status"),
    currentStep: pick("currentStep"),
    attempts: pick("attempts"),
    reruns: pick("reruns"),
    outputs: pick("outputs"),
    steps: { ...base.steps, ...extra.steps },
  }
}
