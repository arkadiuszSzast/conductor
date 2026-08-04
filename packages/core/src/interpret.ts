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

import type {
  AgentStep,
  Decision,
  FeatureState,
  FeatureStatus,
  Feedback,
  JobDef,
  JobPatch,
  Patch,
  PipelineEvent,
  RerunTarget,
  StepDef,
  Transition,
  WorkflowDef,
} from "./types.ts"

const DEFAULT_MAX_ATTEMPTS = 1
const DEFAULT_MAX_ROUNDS = 3

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
    case "step.succeeded":    return onSucceeded(workflow, state, event.jobId, event.stepId, event.output)
    case "step.failed":       return onFailed(workflow, state, event.jobId, event.stepId, event.reason)
    case "step.verdict":      return onVerdict(workflow, state, event.jobId, event.stepId, event.verdict, event.output)
    case "human.approved":    return onHumanApproved(workflow, state, event.jobId, event.stepId)
    case "human.rejected":    return onHumanRejected(workflow, state, event.jobId, event.stepId)
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

function nextStepId(job: JobDef, currentStep: StepDef): string | null {
  if (currentStep.then !== undefined) return currentStep.then
  const reviewPartner = currentStep.type === "agent" ? (currentStep as AgentStep).roundsWith : undefined
  const index = stepIndex(job, currentStep.id)
  for (let candidate = index + 1; candidate < job.steps.length; candidate++) {
    const step = job.steps[candidate]
    if (step && step.id !== reviewPartner) return step.id
  }
  return null
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

  const closure = computeRerunClosure(rerun.jobIds, workflow)

  const feedbackJobs: Record<string, Record<string, string>> = {}

  for (const jobId of rerun.jobIds) {
    const jobRuntime = state.jobs[jobId]
    if (!jobRuntime) continue
    const stepOutputs: Record<string, string> = {}
    for (const [sid, stepState] of Object.entries(jobRuntime.steps)) {
      if (stepState.output !== null) stepOutputs[sid] = stepState.output
    }
    if (Object.keys(stepOutputs).length > 0) feedbackJobs[jobId] = stepOutputs
  }

  const routingOutput = routingStepOutput ?? routingRuntime?.steps[routingStepId]?.output
  if (routingOutput !== null && routingOutput !== undefined) {
    if (!feedbackJobs[routingJobId]) feedbackJobs[routingJobId] = {}
    feedbackJobs[routingJobId][routingStepId] = routingOutput
  }

  const feedback: Feedback = { jobs: feedbackJobs, message: reason }

  const jobPatches: Record<string, JobPatch> = {}

  for (const closureJobId of closure) {
    jobPatches[closureJobId] = {
      status: "pending",
      currentStep: null,
      attempts: {},
      rounds: {},
      reruns: closureJobId === routingJobId
        ? { ...routingRuntime?.reruns, [routingStepId]: rounds }
        : {},
      outputs: {},
      steps: {},
    }
  }

  const decisions: Decision[] = []

  for (const rerunJobId of rerun.jobIds) {
    const rerunJob = findJob(workflow, rerunJobId)
    if (!rerunJob) {
      decisions.push({ kind: "skip_job", jobId: rerunJobId, reason: "job no longer exists" })
      continue
    }
    const stepId = firstStepId(rerunJob)
    if (!stepId) {
      jobPatches[rerunJobId] = {
        ...jobPatches[rerunJobId],
        status: "succeeded",
        currentStep: null,
      }
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

function onSucceeded(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  stepId: string,
  output?: string,
): Transition {
  const jobRuntime = state.jobs[jobId]
  if (!jobRuntime || jobRuntime.currentStep !== stepId) {
    return noopTransition(`stale success for "${jobId}/${stepId}"`)
  }

  const job = findJob(workflow, jobId)
  const step = job && findStep(job, stepId)
  if (!job || !step) {
    return buildTransition(
      [{ kind: "escalate", reason: `unknown step "${stepId}"` }],
      { status: "escalated" },
    )
  }

  const entry = enterStep(workflow, state, jobId, nextStepId(job, step))
  return buildTransition(
    entry.decisions as Decision[],
    mergePatches(
      { jobs: { [jobId]: { steps: { [stepId]: { status: "succeeded", output: output ?? null } } } } },
      entry.patch,
    ),
  )
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

  const retryMaxAttempts = step.retry?.strategy === "backoff"
    ? step.retry.maxAttempts
    : DEFAULT_MAX_ATTEMPTS

  if (attempts >= retryMaxAttempts) {
    const failureReason = `"${jobId}/${stepId}" exhausted ${retryMaxAttempts} attempt(s)`
    if (step.onFail?.rerun) {
      const rerunTransition = onRerun(workflow, state, jobId, stepId, step.onFail.rerun, failureReason)
      return {
        decisions: rerunTransition.decisions,
        patch: mergePatches({ jobs: { [jobId]: failedPatch } }, rerunTransition.patch),
        feedback: rerunTransition.feedback,
      }
    }
    if (step.onFail?.goto) {
      const entry = enterStep(workflow, state, jobId, step.onFail.goto)
      return buildTransition(
        entry.decisions as Decision[],
        mergePatches({ jobs: { [jobId]: failedPatch } }, entry.patch),
      )
    }
    return buildTransition(
      [{ kind: "escalate", reason: failureReason }],
      { status: "escalated", jobs: { [jobId]: failedPatch } },
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

function onVerdict(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  stepId: string,
  verdict: string,
  output?: string,
): Transition {
  const jobRuntime = state.jobs[jobId]
  const job = findJob(workflow, jobId)
  const step = job && findStep(job, stepId)

  if (!job || !jobRuntime || !step || step.type !== "agent") {
    return noopTransition(`verdict for invalid step "${jobId}/${stepId}"`)
  }
  if (jobRuntime.currentStep !== stepId) {
    return noopTransition(`stale verdict for "${jobId}/${stepId}"`)
  }

  const agentStep = step as AgentStep
  let rounds = jobRuntime.rounds

  if (agentStep.roundsWith !== undefined) {
    const completedRounds = (jobRuntime.rounds[stepId] ?? 0) + 1
    rounds = { ...jobRuntime.rounds, [stepId]: completedRounds }
    const maxRounds = agentStep.maxRounds === "unlimited"
      ? Number.POSITIVE_INFINITY
      : (agentStep.maxRounds ?? DEFAULT_MAX_ROUNDS)
    const route = agentStep.onVerdict?.[verdict]
    const loopsBack = route?.goto !== undefined && route.goto === agentStep.roundsWith
    if (loopsBack && completedRounds >= maxRounds) {
      return buildTransition(
        [{ kind: "escalate", reason: `"${jobId}/${stepId}" reached ${maxRounds} round(s)` }],
        { status: "escalated", jobs: { [jobId]: { rounds } } },
      )
    }
  }

  const route = agentStep.onVerdict?.[verdict]
  if (!route) {
    return buildTransition(
      [{ kind: "escalate", reason: `unmapped verdict "${verdict}"` }],
      { status: "escalated", jobs: { [jobId]: { rounds } } },
    )
  }

  if (route.rerun) {
    const rerunTransition = onRerun(workflow, state, jobId, stepId, route.rerun, `verdict "${verdict}"`, output)
    return {
      decisions: rerunTransition.decisions,
      patch: mergePatches({ jobs: { [jobId]: { rounds } } }, rerunTransition.patch),
      feedback: rerunTransition.feedback,
    }
  }

  const target = route.goto ?? nextStepId(job, agentStep) ?? null
  const entry = enterStep(workflow, state, jobId, target)
  return buildTransition(
    entry.decisions as Decision[],
    mergePatches({ jobs: { [jobId]: { rounds } } }, entry.patch),
  )
}

function onHumanApproved(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  stepId: string,
): Transition {
  const jobRuntime = state.jobs[jobId]
  if (!jobRuntime || jobRuntime.currentStep !== stepId) {
    return noopTransition(`no pending approval for "${jobId}/${stepId}"`)
  }

  const job = findJob(workflow, jobId)
  const step = job && findStep(job, stepId)
  if (!job || !step || step.type !== "human") {
    return noopTransition(`"${jobId}/${stepId}" is not a human gate`)
  }

  const entry = enterStep(workflow, state, jobId, nextStepId(job, step))
  return buildTransition(
    entry.decisions as Decision[],
    mergePatches(
      { status: "running", jobs: { [jobId]: { steps: { [stepId]: { status: "succeeded" } } } } },
      entry.patch,
    ),
  )
}

function onHumanRejected(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  stepId: string,
): Transition {
  const jobRuntime = state.jobs[jobId]
  if (!jobRuntime || jobRuntime.currentStep !== stepId) {
    return noopTransition(`no pending rejection for "${jobId}/${stepId}"`)
  }

  const job = findJob(workflow, jobId)
  const step = job && findStep(job, stepId)
  if (!job || !step) {
    return buildTransition(
      [{ kind: "escalate", reason: `unknown step "${jobId}/${stepId}"` }],
      { status: "escalated" },
    )
  }

  if (step.onReject?.rerun) {
    const rerunTransition = onRerun(workflow, state, jobId, stepId, step.onReject.rerun, `human rejected at "${jobId}/${stepId}"`)
    return {
      decisions: rerunTransition.decisions,
      patch: mergePatches(
        { status: "running", jobs: { [jobId]: { steps: { [stepId]: { status: "failed" } } } } },
        rerunTransition.patch,
      ),
      feedback: rerunTransition.feedback,
    }
  }

  if (step.onReject?.goto !== undefined) {
    const entry = enterStep(workflow, state, jobId, step.onReject.goto)
    return buildTransition(
      entry.decisions as Decision[],
      mergePatches(
        { status: "running", jobs: { [jobId]: { steps: { [stepId]: { status: "failed" } } } } },
        entry.patch,
      ),
    )
  }

  return buildTransition(
    [{ kind: "escalate", reason: `human rejected at "${jobId}/${stepId}" (no onReject route)` }],
    { status: "escalated" },
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
          rounds: { ...jobRuntime.rounds, [jobRuntime.currentStep]: 0 },
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
    rounds: extra.rounds ?? base.rounds,
    reruns: extra.reruns ?? base.reruns,
    outputs: extra.outputs ?? base.outputs,
    steps: { ...base.steps, ...extra.steps },
  }
}
