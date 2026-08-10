/**
 * Small pure helpers around `@conductor/core`'s graph `FeatureState`:
 * building the initial state for a freshly created feature and applying
 * a `Patch`/`JobPatch`/`StepPatch` from an interpreter `Transition`.
 *
 * Deliberately pure (no I/O, no clock) — the store calls these inside a
 * transaction, but the functions themselves know nothing about SQLite.
 */

import type {
  FeatureState,
  FeatureStatus,
  JobPatch,
  JobRuntime,
  JobStatus,
  Patch,
  StepPatch,
  StepRuntime,
  TriggerEvent,
} from "@conductor/core"

export interface CreateFeatureInput {
  readonly title: string
  readonly slug: string
  readonly projectDir: string
  readonly workflow: string | null
  readonly description?: string | null
  readonly sessionId?: string | null
  readonly pr?: number | null
  readonly input?: Readonly<Record<string, unknown>>
  readonly trigger?: TriggerEvent | null
}

export interface InitialFeatureStateInput extends CreateFeatureInput {
  readonly id: string
}

export function initialFeatureState(input: InitialFeatureStateInput): FeatureState {
  return {
    id: input.id,
    title: input.title,
    slug: input.slug,
    projectDir: input.projectDir,
    workflow: input.workflow,
    description: input.description ?? null,
    status: "running",
    trigger: input.trigger ?? null,
    input: input.input ?? {},
    sessionId: input.sessionId ?? null,
    worktree: null,
    branch: null,
    pr: input.pr ?? null,
    jobs: {},
  }
}

const EMPTY_JOB: JobRuntime = { status: "pending", currentStep: null, attempts: {}, reruns: {}, outputs: {}, steps: {} }
const EMPTY_STEP: StepRuntime = { status: "pending", outputs: {} }

export function applyPatch(state: FeatureState, patch: Patch): FeatureState {
  const status: FeatureStatus = patch.status ?? state.status
  if (!patch.jobs) return status === state.status ? state : { ...state, status }

  const jobs: Record<string, JobRuntime> = { ...state.jobs }
  for (const [jobId, jobPatch] of Object.entries(patch.jobs)) {
    jobs[jobId] = applyJobPatch(jobs[jobId] ?? EMPTY_JOB, jobPatch)
  }
  return { ...state, status, jobs }
}

function applyJobPatch(job: JobRuntime, patch: JobPatch): JobRuntime {
  const status: JobStatus = patch.status ?? job.status
  const currentStep = "currentStep" in patch ? (patch.currentStep ?? null) : job.currentStep
  const attempts = patch.attempts ?? job.attempts
  const reruns = patch.reruns ?? job.reruns
  const outputs = patch.outputs ?? job.outputs

  let steps: Record<string, StepRuntime> = job.steps
  if (patch.steps) {
    steps = { ...job.steps }
    for (const [stepId, stepPatch] of Object.entries(patch.steps)) {
      steps[stepId] = applyStepPatch(steps[stepId] ?? EMPTY_STEP, stepPatch)
    }
  }

  return { status, currentStep, attempts, reruns, outputs, steps }
}

function applyStepPatch(step: StepRuntime, patch: StepPatch): StepRuntime {
  return {
    status: patch.status ?? step.status,
    outputs: patch.outputs ?? step.outputs,
  }
}
