/**
 * Structural validation of a workflow definition.
 *
 * The interpreter validates ONLY what it needs to execute safely:
 *  - job `needs` form a DAG (no cycles)
 *  - every `needs` reference resolves
 *  - step ids are unique and non-empty within a job
 *  - every goto / rerun target exists within the same job
 *  - every agent step's role exists in `roles`
 *  - every loop edge carries a bounded counter
 *
 * Opinions (e.g. "reviewer and fixer should use different models") are NOT
 * errors. They may surface as warnings; project owners decide their own
 * process. Presets encode our recommendations instead.
 */

import type { AgentStep, BackoffDef, JobDef, RerunTarget, RetryPolicy, Route, StepDef, WorkflowDef } from "./types.ts"

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

    for (const [outcome, route] of Object.entries(step.outcomes)) {
      validateRoute(route, `outcomes["${outcome}"]`, def, jobId, stepExists, stepWhere, errors)
    }
    if (step.onFail) {
      validateRoute(step.onFail, "onFail", def, jobId, stepExists, stepWhere, errors)
    }
    validateRetry(step.retry, stepWhere, errors)

    if (step.type === "agent") {
      validateAgentStep(step as AgentStep, def, stepWhere, errors)
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
        `add a retry budget or route the loop through rerun with maxRounds`,
    )
  }
}

function validateRetry(retry: RetryPolicy, where: string, errors: string[]): void {
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

// ---------------------------------------------------------------------------
// Route validation (next, goto, rerun) shared by outcomes and onFail
// ---------------------------------------------------------------------------

function validateRoute(
  route: Route,
  label: string,
  def: WorkflowDef,
  routingJobId: string,
  stepExists: (stepId: string) => boolean,
  stepWhere: string,
  errors: string[],
): void {
  const where = `${stepWhere}: ${label}`
  switch (route.kind) {
    case "next":
      return
    case "goto":
      if (!stepExists(route.stepId)) {
        errors.push(`${where}: goto → "${route.stepId}" does not exist`)
      }
      return
    case "rerun":
      validateRerunTarget(route.target, label, def, routingJobId, stepExists, stepWhere, errors)
      return
  }
}

function validateRerunTarget(
  rerun: RerunTarget,
  label: string,
  def: WorkflowDef,
  routingJobId: string,
  stepExists: (stepId: string) => boolean,
  stepWhere: string,
  errors: string[],
): void {
  const where = `${stepWhere}: ${label}`
  if (rerun.maxRounds < 1) {
    errors.push(`${where}: rerun.maxRounds must be ≥ 1`)
  }

  if (rerun.scope === "steps") {
    if (rerun.stepIds.length === 0) {
      errors.push(`${where}: rerun names no steps`)
    }
    for (const stepId of rerun.stepIds) {
      if (!stepExists(stepId)) {
        errors.push(`${where}: rerun step "${stepId}" does not exist in this job`)
      }
    }
    return
  }

  if (rerun.jobIds.length === 0) {
    errors.push(`${where}: rerun names no jobs`)
  }

  const seen = new Set<string>()
  for (const jobId of rerun.jobIds) {
    if (seen.has(jobId)) {
      errors.push(`${where}: rerun job "${jobId}" appears more than once`)
      continue
    }
    seen.add(jobId)
    if (!def.jobs[jobId]) {
      errors.push(`${where}: rerun job "${jobId}" does not exist`)
      continue
    }
    if (jobId === routingJobId) {
      errors.push(`${where}: rerun job "${jobId}" must not be the routing job itself`)
      continue
    }
    // A rerun must go backward through the DAG. "Not downstream" is not
    // enough — a sibling in an unrelated branch is neither downstream nor
    // an ancestor, but rerunning it never resets the routing job (the
    // forward-walk closure would not reach it), leaving the routing job
    // stuck. Require a true ancestor: routing must transitively `needs` target.
    if (!isDownstreamOf(jobId, routingJobId, def)) {
      errors.push(`${where}: rerun job "${jobId}" is not an ancestor of the routing job "${routingJobId}" (the routing job must transitively depend on it via needs)`)
    }
  }
}

/** True if `target` is downstream of `ancestor` (i.e. `target` transitively
 *  depends on `ancestor` through the needs graph). */
function isDownstreamOf(ancestor: string, target: string, def: WorkflowDef): boolean {
  const queue = [ancestor]
  const visited = new Set(queue)
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const [jobId, job] of Object.entries(def.jobs)) {
      if (visited.has(jobId)) continue
      if (job.needs.includes(current)) {
        if (jobId === target) return true
        visited.add(jobId)
        queue.push(jobId)
      }
    }
  }
  return false
}

function validateAgentStep(
  step: AgentStep,
  def: WorkflowDef,
  where: string,
  errors: string[],
): void {
  if (!def.roles || !(step.role in def.roles)) {
    errors.push(`${where}: role "${step.role}" is not defined in roles`)
  }
}

// ---------------------------------------------------------------------------
// Uncounted cycle detection (within a job's step list)
// ---------------------------------------------------------------------------

function findUncountedCycles(steps: readonly StepDef[]): string[][] {
  const stepsById = new Map(steps.map(step => [step.id, step]))
  const counted = new Set<string>()
  const countLoop = (step: StepDef, route: Route): void => {
    if (route.kind !== "rerun") return
    counted.add(step.id)
    if (route.target.scope === "steps") {
      for (const rerunStepId of route.target.stepIds) counted.add(rerunStepId)
    }
  }

  for (const step of steps) {
    if (step.retry.strategy === "backoff") counted.add(step.id)
    for (const route of Object.values(step.outcomes)) countLoop(step, route)
    if (step.onFail) countLoop(step, step.onFail)
  }

  const edges = (step: StepDef): string[] => {
    const targets: string[] = []
    for (const route of Object.values(step.outcomes)) {
      if (route.kind === "goto") targets.push(route.stepId)
    }
    if (step.onFail?.kind === "goto") targets.push(step.onFail.stepId)
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
