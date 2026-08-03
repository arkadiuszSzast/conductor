/**
 * Structural validation of a pipeline definition.
 *
 * The engine validates ONLY what it needs to execute safely:
 *  - step ids are unique and non-empty
 *  - every goto / then / rounds_with target exists
 *  - every agent step's role exists in `roles`
 *  - every loop edge (on_fail.goto, rounds_with) carries a bounded counter
 *
 * Opinions (e.g. "reviewer and fixer should use different models") are NOT
 * errors. They may surface as warnings; project owners decide their own
 * process. Presets encode our recommendations instead.
 */

import type { AgentStep, PipelineDef, StepDef } from "./types"

export interface ValidationResult {
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export function validatePipeline(def: PipelineDef): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const steps = def.pipeline ?? []

  if (steps.length === 0) {
    return { errors: ["pipeline is empty — define at least one step"], warnings }
  }

  // Unique, non-empty ids
  const ids = new Set<string>()
  for (const step of steps) {
    if (!step.id || step.id.trim() === "") {
      errors.push("a step has an empty id")
      continue
    }
    if (ids.has(step.id)) errors.push(`duplicate step id: "${step.id}"`)
    ids.add(step.id)
  }

  const exists = (id: string) => ids.has(id)

  for (const step of steps) {
    const where = `step "${step.id}"`

    if (step.then !== undefined && !exists(step.then)) {
      errors.push(`${where}: then → "${step.then}" does not exist`)
    }
    if (step.on_fail?.goto !== undefined && !exists(step.on_fail.goto)) {
      errors.push(`${where}: on_fail.goto → "${step.on_fail.goto}" does not exist`)
    }
    if (step.on_reject !== undefined) {
      if (!exists(step.on_reject.goto)) {
        errors.push(`${where}: on_reject.goto → "${step.on_reject.goto}" does not exist`)
      }
      if (step.requires_human !== true) {
        warnings.push(`${where}: on_reject without requires_human — rejection can never occur`)
      }
    }

    if (step.type === "agent") {
      validateAgentStep(step, def, exists, errors, warnings)
    }
    if (step.type === "command" && step.run.length === 0) {
      errors.push(`${where}: command step has an empty run list`)
    }
  }

  // Loop boundedness: any backward edge must carry a counter.
  // on_fail.goto without max_attempts defaults to 1 (bounded) — fine.
  // rounds_with without max_rounds defaults to 3 (bounded) — fine.
  // An explicit `then` that jumps backwards with no counter on the cycle
  // is the dangerous shape: a free loop the engine can never exit.
  for (const cycle of findUncountedCycles(steps)) {
    errors.push(
      `unbounded loop with no attempt/round counter: ${cycle.join(" → ")} — ` +
        `add on_fail.max_attempts or use rounds_with/max_rounds on one of its steps`,
    )
  }

  return { errors, warnings }
}

function validateAgentStep(
  step: AgentStep,
  def: PipelineDef,
  exists: (id: string) => boolean,
  errors: string[],
  warnings: string[],
): void {
  const where = `step "${step.id}"`
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

/**
 * Detect cycles reachable through `then`/`on_verdict.goto` edges where NO
 * step on the cycle carries a counter (on_fail.max_attempts, max_rounds,
 * or participates in a rounds_with pair). Those cycles can spin forever.
 *
 * on_fail.goto edges are excluded from cycle detection: attempts on the
 * failing step are always bounded (default max_attempts = 1).
 */
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
