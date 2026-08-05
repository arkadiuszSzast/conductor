/**
 * Test builders — they stand in for the YAML parser, which is what normally
 * produces the IR's normalised form. Tests describe workflows the way an
 * author would; these fill in the empty collections and defaults.
 */

import type {
  ActionStep,
  AgentStep,
  CommandStep,
  FeatureState,
  HumanStep,
  JobDef,
  JobRuntime,
  Outcomes,
  RetryPolicy,
  Route,
  StepDef,
  WorkflowDef,
} from "./src/types.ts"

interface StepOptions {
  readonly outcomes?: Outcomes
  readonly onFail?: Route
  readonly retry?: RetryPolicy
}

const stepBase = (id: string, options: StepOptions = {}) => ({
  id,
  outcomes: options.outcomes ?? {},
  retry: options.retry ?? ({ strategy: "none" } as const),
  ...(options.onFail ? { onFail: options.onFail } : {}),
})

export function agentStep(id: string, role: string, prompt: string, options?: StepOptions): AgentStep {
  return { ...stepBase(id, options), type: "agent", role, prompt }
}

export function commandStep(id: string, run: readonly string[], options?: StepOptions): CommandStep {
  return { ...stepBase(id, options), type: "command", run }
}

export function actionStep(id: string, uses: string, options?: StepOptions): ActionStep {
  return { ...stepBase(id, options), type: "action", uses, with: {} }
}

export function humanStep(id: string, options?: StepOptions): HumanStep {
  return { ...stepBase(id, options), type: "human" }
}

export function job(
  steps: readonly StepDef[],
  needs: readonly string[] = [],
  jobIf?: string,
  outputs?: Readonly<Record<string, string>>,
): JobDef {
  return {
    needs,
    steps,
    outputs: outputs ?? {},
    ...(jobIf ? { if: jobIf } : {}),
  }
}

export function workflow(
  jobs: Readonly<Record<string, JobDef>>,
  roles: WorkflowDef["roles"],
  name = "test",
  inputs: WorkflowDef["inputs"] = {},
): WorkflowDef {
  return { name, on: [], inputs, jobs, roles }
}

export const next: Route = { kind: "next" }
export const goto = (stepId: string): Route => ({ kind: "goto", stepId })
export const rerunSteps = (stepIds: readonly string[], maxRounds: number): Route =>
  ({ kind: "rerun", target: { scope: "steps", stepIds, maxRounds } })
export const rerunJobs = (jobIds: readonly string[], maxRounds: number): Route =>
  ({ kind: "rerun", target: { scope: "jobs", jobIds, maxRounds } })

export const backoff = (maxAttempts: number, delay = 100): RetryPolicy => ({
  strategy: "backoff",
  maxAttempts,
  backoff: { strategy: "constant", delay },
})

export function jobRuntime(overrides: Partial<JobRuntime> = {}): JobRuntime {
  return {
    status: "pending",
    currentStep: null,
    attempts: {},
    reruns: {},
    outputs: {},
    steps: {},
    ...overrides,
  }
}

export function featureState(
  jobs: Record<string, JobRuntime>,
  overrides: Partial<FeatureState> = {},
): FeatureState {
  return {
    id: "f1",
    title: "test feature",
    slug: "test-feature",
    projectDir: "/tmp/project",
    workflow: "test",
    description: null,
    status: "running",
    trigger: null,
    input: {},
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    jobs,
    ...overrides,
  }
}
