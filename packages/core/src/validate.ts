/**
 * Structural validation of a workflow definition.
 *
 * The interpreter validates ONLY what it needs to execute safely:
 *  - job `needs` form a DAG (no cycles)
 *  - every `needs` reference resolves
 *  - step ids are unique and non-empty within a job
 *  - every goto / then / roundsWith target exists within the same job
 *  - every agent step's role exists in `roles`
 *  - every loop edge carries a bounded counter
 *
 * Opinions (e.g. "reviewer and fixer should use different models") are NOT
 * errors. They may surface as warnings; project owners decide their own
 * process. Presets encode our recommendations instead.
 */

import type { AgentStep, BackoffDef, JobDef, StepDef, WorkflowDef } from "./types.ts"

export interface ValidationResult {
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export function validateWorkflow(def: WorkflowDef): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const jobIds = new Set(Object.keys(def.jobs))

  if (jobIds.size === 0) {
    return { errors: ["workflow has no jobs — define at least one"], warnings }
  }

  validateJobDag(def, jobIds, errors)

  for (const [jobId, job] of Object.entries(def.jobs)) {
    validateJob(jobId, job, def, errors, warnings)
  }

  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// DAG validation
// ---------------------------------------------------------------------------

function validateJobDag(def: WorkflowDef, jobIds: Set<string>, errors: string[]): void {
  for (const [jobId, job] of Object.entries(def.jobs)) {
    for (const need of job.needs ?? []) {
      if (!jobIds.has(need)) {
        errors.push(`job "${jobId}": needs → "${need}" does not exist`)
      }
      if (need === jobId) {
        errors.push(`job "${jobId}": needs itself`)
      }
    }
  }

  const visited = new Set<string>()
  const onStack = new Set<string>()

  for (const start of jobIds) {
    if (visited.has(start)) continue
    const stack: string[] = []
    const depthFirstSearch = (jobId: string): void => {
      if (onStack.has(jobId)) {
        const cycle = stack.slice(stack.indexOf(jobId))
        errors.push(`job dependency cycle: ${[...cycle, jobId].join(" → ")}`)
        return
      }
      if (visited.has(jobId)) return
      visited.add(jobId)
      stack.push(jobId)
      onStack.add(jobId)
      const job = def.jobs[jobId]
      if (job) {
        for (const need of job.needs ?? []) {
          if (jobIds.has(need)) depthFirstSearch(need)
        }
      }
      stack.pop()
      onStack.delete(jobId)
    }
    depthFirstSearch(start)
  }
}

// ---------------------------------------------------------------------------
// Per-job validation
// ---------------------------------------------------------------------------

function validateJob(
  jobId: string,
  job: JobDef,
  def: WorkflowDef,
  errors: string[],
  warnings: string[],
): void {
  const steps = job.steps
  const where = `job "${jobId}"`

  if (steps.length === 0) {
    errors.push(`${where}: no steps — define at least one`)
    return
  }

  const stepIds = new Set<string>()
  for (const step of steps) {
    if (!step.id || step.id.trim() === "") {
      errors.push(`${where}: a step has an empty id`)
      continue
    }
    if (stepIds.has(step.id)) errors.push(`${where}: duplicate step id "${step.id}"`)
    stepIds.add(step.id)
  }

  const stepExists = (stepId: string) => stepIds.has(stepId)

  for (const step of steps) {
    const stepWhere = `${where} step "${step.id}"`

    if (step.then !== undefined && !stepExists(step.then)) {
      errors.push(`${stepWhere}: then → "${step.then}" does not exist`)
    }
    if (step.onFail?.goto !== undefined && !stepExists(step.onFail.goto)) {
      errors.push(`${stepWhere}: onFail.goto → "${step.onFail.goto}" does not exist`)
    }
    if (step.onReject !== undefined) {
      if (!stepExists(step.onReject.goto)) {
        errors.push(`${stepWhere}: onReject.goto → "${step.onReject.goto}" does not exist`)
      }
      if (step.type !== "human") {
        warnings.push(`${stepWhere}: onReject on a non-human step — rejection can never occur`)
      }
    }
    if (step.retry !== undefined) {
      validateRetry(step.retry, stepWhere, errors)
    }

    if (step.type === "agent") {
      validateAgentStep(step as AgentStep, def, stepExists, stepWhere, errors, warnings)
    }
    if (step.type === "command" && step.run.length === 0) {
      errors.push(`${stepWhere}: command step has an empty run list`)
    }
    if (step.type === "action" && (!step.uses || step.uses.trim() === "")) {
      errors.push(`${stepWhere}: action step has an empty uses field`)
    }
  }

  for (const cycle of findUncountedCycles(steps)) {
    errors.push(
      `unbounded loop in ${where} with no attempt/round counter: ${cycle.join(" → ")} — ` +
        `add retry.maxAttempts or use roundsWith/maxRounds on one of its steps`,
    )
  }
}

function validateRetry(retry: NonNullable<StepDef["retry"]>, where: string, errors: string[]): void {
  if (retry.strategy === "none") return
  if (retry.maxAttempts < 1) {
    errors.push(`${where}: retry.maxAttempts must be ≥ 1`)
  }
  if (retry.maxElapsed !== undefined && !/^P(?:\d+[YMWD])?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(retry.maxElapsed)) {
    errors.push(`${where}: retry.maxElapsed must be an ISO-8601 duration (e.g. "PT10M")`)
  }
  validateBackoff(retry.backoff, where, errors)
}

function validateBackoff(backoff: BackoffDef, where: string, errors: string[]): void {
  if (backoff.strategy === "constant") {
    if (backoff.delay < 0) {
      errors.push(`${where}: backoff.delay must be ≥ 0`)
    }
    return
  }
  if (backoff.initial < 0) {
    errors.push(`${where}: backoff.initial must be ≥ 0`)
  }
  if (backoff.multiplier < 1) {
    errors.push(`${where}: backoff.multiplier must be ≥ 1`)
  }
  if (backoff.max < 0) {
    errors.push(`${where}: backoff.max must be ≥ 0`)
  }
}

function validateAgentStep(
  step: AgentStep,
  def: WorkflowDef,
  stepExists: (stepId: string) => boolean,
  where: string,
  errors: string[],
  warnings: string[],
): void {
  if (!def.roles || !(step.role in def.roles)) {
    errors.push(`${where}: role "${step.role}" is not defined in roles`)
  }
  if (step.roundsWith !== undefined && !stepExists(step.roundsWith)) {
    errors.push(`${where}: roundsWith → "${step.roundsWith}" does not exist`)
  }
  if (step.maxRounds !== undefined && step.maxRounds !== "unlimited" && step.maxRounds < 1) {
    errors.push(`${where}: maxRounds must be ≥ 1 or "unlimited"`)
  }
  if (step.onVerdict) {
    for (const [verdict, route] of Object.entries(step.onVerdict)) {
      if (route.goto !== undefined && !stepExists(route.goto)) {
        errors.push(`${where}: onVerdict["${verdict}"].goto → "${route.goto}" does not exist`)
      }
      if (route.goto === undefined && route.next !== true) {
        warnings.push(`${where}: onVerdict["${verdict}"] routes nowhere (no goto, next != true)`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Uncounted cycle detection (within a job's step list)
// ---------------------------------------------------------------------------

function findUncountedCycles(steps: readonly StepDef[]): string[][] {
  const stepsById = new Map(steps.map(step => [step.id, step]))
  const counted = new Set<string>()
  for (const step of steps) {
    if (step.type === "agent" && (step.roundsWith !== undefined || step.maxRounds !== undefined)) {
      counted.add(step.id)
      if (step.roundsWith !== undefined) counted.add(step.roundsWith)
    }
    if (step.retry?.strategy === "backoff") {
      counted.add(step.id)
    }
  }

  const edges = (step: StepDef): string[] => {
    const targets: string[] = []
    if (step.then !== undefined) targets.push(step.then)
    if (step.type === "agent" && step.onVerdict) {
      for (const route of Object.values(step.onVerdict)) {
        if (route.goto !== undefined) targets.push(route.goto)
      }
    }
    return targets.filter(stepId => stepsById.has(stepId))
  }

  const cycles: string[][] = []
  const seenCycles = new Set<string>()

  for (const startStep of steps) {
    const stack: string[] = []
    const onStack = new Set<string>()
    const visited = new Set<string>()

    const depthFirstSearch = (stepId: string): void => {
      if (onStack.has(stepId)) {
        const cycle = stack.slice(stack.indexOf(stepId))
        if (cycle.some(stepInCycle => counted.has(stepInCycle))) return
        const key = [...cycle].sort().join("|")
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          cycles.push([...cycle, stepId])
        }
        return
      }
      if (visited.has(stepId)) return
      visited.add(stepId)
      stack.push(stepId)
      onStack.add(stepId)
      const step = stepsById.get(stepId)
      if (step) for (const next of edges(step)) depthFirstSearch(next)
      stack.pop()
      onStack.delete(stepId)
    }

    depthFirstSearch(startStep.id)
  }

  return cycles
}
