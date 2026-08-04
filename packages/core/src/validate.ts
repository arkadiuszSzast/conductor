/**
 * Structural validation of a workflow definition.
 *
 * The interpreter validates ONLY what it needs to execute safely:
 *  - job `needs` form a DAG (no cycles)
 *  - every `needs` reference resolves
 *  - step ids are unique and non-empty within a job
 *  - every goto / then / rounds_with target exists within the same job
 *  - every agent step's role exists in `roles`
 *  - every loop edge carries a bounded counter
 *
 * Opinions (e.g. "reviewer and fixer should use different models") are NOT
 * errors. They may surface as warnings; project owners decide their own
 * process. Presets encode our recommendations instead.
 */

import type { AgentStep, JobDef, StepDef, WorkflowDef } from "./types.ts"

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
  for (const [id, job] of Object.entries(def.jobs)) {
    for (const need of job.needs ?? []) {
      if (!jobIds.has(need)) {
        errors.push(`job "${id}": needs → "${need}" does not exist`)
      }
      if (need === id) {
        errors.push(`job "${id}": needs itself`)
      }
    }
  }

  const visited = new Set<string>()
  const onStack = new Set<string>()

  for (const start of jobIds) {
    if (visited.has(start)) continue
    const stack: string[] = []
    const dfs = (id: string): void => {
      if (onStack.has(id)) {
        const cycle = stack.slice(stack.indexOf(id))
        errors.push(`job dependency cycle: ${[...cycle, id].join(" → ")}`)
        return
      }
      if (visited.has(id)) return
      visited.add(id)
      stack.push(id)
      onStack.add(id)
      const job = def.jobs[id]
      if (job) {
        for (const need of job.needs ?? []) {
          if (jobIds.has(need)) dfs(need)
        }
      }
      stack.pop()
      onStack.delete(id)
    }
    dfs(start)
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

  const ids = new Set<string>()
  for (const step of steps) {
    if (!step.id || step.id.trim() === "") {
      errors.push(`${where}: a step has an empty id`)
      continue
    }
    if (ids.has(step.id)) errors.push(`${where}: duplicate step id "${step.id}"`)
    ids.add(step.id)
  }

  const exists = (id: string) => ids.has(id)

  for (const step of steps) {
    const sw = `${where} step "${step.id}"`

    if (step.then !== undefined && !exists(step.then)) {
      errors.push(`${sw}: then → "${step.then}" does not exist`)
    }
    if (step.on_fail?.goto !== undefined && !exists(step.on_fail.goto)) {
      errors.push(`${sw}: on_fail.goto → "${step.on_fail.goto}" does not exist`)
    }
    if (step.on_reject !== undefined) {
      if (!exists(step.on_reject.goto)) {
        errors.push(`${sw}: on_reject.goto → "${step.on_reject.goto}" does not exist`)
      }
      if (step.type !== "human") {
        warnings.push(`${sw}: on_reject on a non-human step — rejection can never occur`)
      }
    }

    if (step.type === "agent") {
      validateAgentStep(step as AgentStep, def, exists, sw, errors, warnings)
    }
    if (step.type === "command" && step.run.length === 0) {
      errors.push(`${sw}: command step has an empty run list`)
    }
    if (step.type === "action" && (!step.uses || step.uses.trim() === "")) {
      errors.push(`${sw}: action step has an empty uses field`)
    }
  }

  for (const cycle of findUncountedCycles(steps)) {
    errors.push(
      `unbounded loop in ${where} with no attempt/round counter: ${cycle.join(" → ")} — ` +
        `add on_fail.max_attempts or use rounds_with/max_rounds on one of its steps`,
    )
  }
}

function validateAgentStep(
  step: AgentStep,
  def: WorkflowDef,
  exists: (id: string) => boolean,
  where: string,
  errors: string[],
  warnings: string[],
): void {
  if (!def.roles || !(step.role in def.roles)) {
    errors.push(`${where}: role "${step.role}" is not defined in roles`)
  }
  if (step.rounds_with !== undefined && !exists(step.rounds_with)) {
    errors.push(`${where}: rounds_with → "${step.rounds_with}" does not exist`)
  }
  if (step.on_verdict) {
    for (const [verdict, route] of Object.entries(step.on_verdict)) {
      if (route.goto !== undefined && !exists(route.goto)) {
        errors.push(`${where}: on_verdict["${verdict}"].goto → "${route.goto}" does not exist`)
      }
      if (route.goto === undefined && route.next !== true) {
        warnings.push(`${where}: on_verdict["${verdict}"] routes nowhere (no goto, next != true)`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Uncounted cycle detection (within a job's step list)
// ---------------------------------------------------------------------------

function findUncountedCycles(steps: readonly StepDef[]): string[][] {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const counted = new Set<string>()
  for (const s of steps) {
    if (s.type === "agent" && (s.rounds_with !== undefined || s.max_rounds !== undefined)) {
      counted.add(s.id)
      if (s.rounds_with !== undefined) counted.add(s.rounds_with)
    }
  }

  const edges = (s: StepDef): string[] => {
    const out: string[] = []
    if (s.then !== undefined) out.push(s.then)
    if (s.type === "agent" && s.on_verdict) {
      for (const route of Object.values(s.on_verdict)) {
        if (route.goto !== undefined) out.push(route.goto)
      }
    }
    return out.filter((id) => byId.has(id))
  }

  const cycles: string[][] = []
  const seenCycles = new Set<string>()

  for (const start of steps) {
    const stack: string[] = []
    const onStack = new Set<string>()
    const visited = new Set<string>()

    const dfs = (id: string): void => {
      if (onStack.has(id)) {
        const cycle = stack.slice(stack.indexOf(id))
        if (cycle.some((c) => counted.has(c))) return
        const key = [...cycle].sort().join("|")
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          cycles.push([...cycle, id])
        }
        return
      }
      if (visited.has(id)) return
      visited.add(id)
      stack.push(id)
      onStack.add(id)
      const step = byId.get(id)
      if (step) for (const next of edges(step)) dfs(next)
      stack.pop()
      onStack.delete(id)
    }

    dfs(start.id)
  }

  return cycles
}
