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

import { collectPaths, formatPath, parseExpression, typecheckExpression } from "./expression.ts"
import type { ExprType } from "./expression.ts"
import { extractExpressions } from "./template.ts"
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

  validateExpressions(def, errors, warnings)

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

// ---------------------------------------------------------------------------
// Expression validation
// ---------------------------------------------------------------------------

interface ValidatedRefs {
  readonly stepOutputs: Readonly<Record<string, Readonly<Record<string, StepOutputModel>>>>
  readonly jobOutputs: Readonly<Record<string, Readonly<Record<string, ExprType>>>>
}

/** Static output contract of one step: `agent` publishes exactly `report`,
 *  `human` exactly `notes`; `command`/`action` publish whatever the runner
 *  or action manifest decides, so any output name is possible and untyped. */
type StepOutputModel =
  | { readonly kind: "fixed"; readonly outputs: Readonly<Record<string, ExprType>> }
  | { readonly kind: "dynamic" }

function stepOutputType(model: StepOutputModel, name: string): ExprType | undefined {
  if (model.kind === "dynamic") return "unknown"
  return model.outputs[name]
}

/** Expression context: the declared outputs every job/step published. */
function collectRefs(def: WorkflowDef): ValidatedRefs {
  const stepOutputs: Record<string, Record<string, StepOutputModel>> = {}
  const jobOutputs: Record<string, Record<string, ExprType>> = {}

  for (const [jobId, job] of Object.entries(def.jobs)) {
    stepOutputs[jobId] = {}
    for (const step of job.steps) {
      stepOutputs[jobId]![step.id] = step.type === "agent"
        ? { kind: "fixed", outputs: step.reviewHead !== undefined ? { report: "string", work_order: "string" } : { report: "string" } }
        : step.type === "human"
          ? { kind: "fixed", outputs: { notes: "string" } }
          : { kind: "dynamic" }
    }
    jobOutputs[jobId] = {}
    for (const [name] of Object.entries(job.outputs)) {
      // Job outputs are templates that render to strings; consumers read
      // them through `needs.<job>.outputs.<name>` as strings.
      jobOutputs[jobId]![name] = "string"
    }
  }

  return { stepOutputs, jobOutputs }
}

interface RerunRoute {
  readonly routingJob: string
  readonly routingStep: string
  readonly target: RerunTarget
}

/** Every rerun route in the workflow, with where it is declared. */
function collectRerunRoutes(def: WorkflowDef): readonly RerunRoute[] {
  const routes: RerunRoute[] = []
  for (const [jobId, job] of Object.entries(def.jobs)) {
    for (const step of job.steps) {
      for (const route of Object.values(step.outcomes)) {
        if (route.kind === "rerun") routes.push({ routingJob: jobId, routingStep: step.id, target: route.target })
      }
      if (step.onFail?.kind === "rerun") {
        routes.push({ routingJob: jobId, routingStep: step.id, target: step.onFail.target })
      }
    }
  }
  return routes
}

function validateExpressions(def: WorkflowDef, errors: string[], warnings: string[]): void {
  const refs = collectRefs(def)
  const rerunRoutes = collectRerunRoutes(def)

  for (const [jobId, job] of Object.entries(def.jobs)) {
    if (job.if !== undefined) {
      validateExpression(job.if, {
        where: `job "${jobId}": if`,
        typeOfPath: path => typeOfJobIfPath(path, jobId, job, def, refs),
        allowedRoots: new Set(["inputs", "needs", "feedback", "feature"]),
        feedbackRoot: jobId,
        rerunRoutes,
        def,
        errors,
      })
      // The interpreter's skip cascade only consults the literal conditions
      // `always()`/`failure()`; a general boolean is validated but not yet
      // evaluated at readiness time, so warn instead of silently ignoring it.
      if (job.if !== "always()" && job.if !== "failure()") {
        warnings.push(
          `job "${jobId}": if — only "always()" and "failure()" affect job readiness today; ` +
            `this condition is validated but not evaluated`,
        )
      }
    }

    for (const [name, expression] of Object.entries(job.outputs)) {
      const where = `job "${jobId}" outputs["${name}"]`
      const sources = extractExpressions(expression)
      if (sources.length === 0) continue
      for (const source of sources) {
        // Job outputs render post-success against the job's own steps and the
        // trigger inputs; `resolveJobOutputs` never receives a feedback
        // snapshot, so a feedback read here would silently resolve empty.
        validateExpression(source, {
          where,
          typeOfPath: path => typeOfJobPath(path, jobId, job, def, refs),
          allowedRoots: new Set(["inputs", "steps", "feature"]),
          feedbackRoot: jobId,
          rerunRoutes,
          def,
          errors,
        })
      }
    }

    for (const [index, step] of job.steps.entries()) {
      const where = `job "${jobId}" step "${step.id}"`

      if (step.if !== undefined) {
        validateExpression(step.if, {
          where: `${where}: if`,
          typeOfPath: path => typeOfStepPath(path, index, jobId, job, def, refs),
          allowedRoots: new Set(["inputs", "steps", "needs", "feedback", "feature"]),
          feedbackRoot: jobId,
          rerunRoutes,
          def,
          errors,
        })
      }

      if (step.type === "agent") {
        if ((step.fixFrom !== undefined || step.qualityFrom !== undefined) !== (step.fixPrompt !== undefined)) {
          errors.push(`${where}: fixPrompt requires fixFrom or qualityFrom and vice versa`)
        }
        if (step.reviewHead !== undefined && (!step.outcomes.approved || !step.outcomes.changes_requested)) {
          errors.push(`${where}: reviewHead requires approved and changes_requested outcomes`)
        }
        for (const key of ["fixFrom", "qualityFrom"] as const) {
          const ref = step[key]
          if (ref === undefined) continue
          const parts = ref.split("/")
          const source = parts.length === 2 ? def.jobs[parts[0]!]?.steps.find(candidate => candidate.id === parts[1]) : undefined
          if (!source || (key === "fixFrom" ? source.type !== "agent" || source.reviewHead === undefined : source.type !== "command")) {
            errors.push(`${where}: ${key} must reference a ${key === "fixFrom" ? "structured review" : "command"} job/step`)
          } else {
            validateExpression(`feedback.jobs[${JSON.stringify(parts[0])}][${JSON.stringify(parts[1])}][${JSON.stringify(key === "fixFrom" ? "work_order" : "diagnostic")}]`, {
              where: `${where}: ${key}`,
              typeOfPath: path => typeOfStepPath(path, index, jobId, job, def, refs),
              allowedRoots: new Set(["feedback"]), feedbackRoot: jobId, rerunRoutes, def, errors,
            })
          }
        }
        if (step.fixPrompt !== undefined && extractExpressions(step.fixPrompt).some(expression => /\bfeedback\b/.test(expression))) {
          errors.push(`${where}: fixPrompt must not interpolate feedback; scoped fix evidence is supplied by the engine`)
        }
      }
      if (step.type === "agent" || (step.type === "human" && step.prompt !== undefined)) {
        const templates = step.type === "agent" ? [step.prompt, step.fixPrompt, step.reviewHead] : [step.prompt]
        for (const expression of templates.flatMap(template => template === undefined ? [] : extractExpressions(template))) {
          validateExpression(expression, {
            where: `${where}: prompt`,
            typeOfPath: path => typeOfStepPath(path, index, jobId, job, def, refs),
            allowedRoots: new Set(["inputs", "steps", "needs", "feedback", "feature"]),
            feedbackRoot: jobId,
            rerunRoutes,
            def,
            errors,
          })
        }
      }

      if (step.type === "command") {
        for (const [lineIndex, line] of step.run.entries()) {
          for (const expression of extractExpressions(line)) {
            validateExpression(expression, {
              where: `${where}: run[${lineIndex}]`,
              typeOfPath: path => typeOfStepPath(path, index, jobId, job, def, refs),
              allowedRoots: new Set(["inputs", "steps", "needs", "feedback", "feature"]),
              feedbackRoot: jobId,
              rerunRoutes,
              def,
              errors,
            })
          }
        }
      }

      if (step.type === "action") {
        for (const [key, value] of Object.entries(step.with)) {
          if (typeof value !== "string") continue
          for (const expression of extractExpressions(value)) {
            validateExpression(expression, {
              where: `${where}: with["${key}"]`,
              typeOfPath: path => typeOfStepPath(path, index, jobId, job, def, refs),
              allowedRoots: new Set(["inputs", "steps", "needs", "feedback", "feature"]),
              feedbackRoot: jobId,
              rerunRoutes,
              def,
              errors,
            })
          }
        }
      }
    }
  }
}

interface ExpressionCheck {
  readonly where: string
  readonly typeOfPath: (segments: readonly string[]) => ExprType | undefined
  readonly allowedRoots: Set<string>
  readonly feedbackRoot: string
  readonly rerunRoutes: readonly RerunRoute[]
  readonly def: WorkflowDef
  readonly errors: string[]
}

function validateExpression(expression: string, check: ExpressionCheck): void {
  const parsed = parseExpression(expression)
  if (!parsed.ok) {
    check.errors.push(`${check.where}: ${parsed.error}`)
    return
  }

  const { where, errors } = check

  for (const segments of collectPaths(parsed.expr)) {
    const root = segments[0]
    if (root === undefined) continue
    if (!check.allowedRoots.has(root)) {
      errors.push(`${where}: unknown context "${root}" — available: ${[...check.allowedRoots].sort().join(", ")}`)
      continue
    }
    if (root === "feedback") {
      validateFeedbackPath(segments, check)
      continue
    }
    const known = check.typeOfPath(segments)
    if (known === undefined) {
      if (root === "feature") {
        errors.push(
          `${where}: "${formatPath(segments)}" is not a feature field — available: ${Object.keys(FEATURE_FIELD_TYPES).sort().join(", ")}`,
        )
      } else {
        errors.push(`${where}: "${formatPath(segments)}" is not a known value`)
      }
    }
  }

  const typecheck = typecheckExpression(parsed.expr, check.typeOfPath)
  for (const typeError of typecheck.errors) {
    errors.push(`${where}: ${typeError}`)
  }
}

/** Static types for a path read inside job `jobId` at step position
 *  `stepIndex`. Only earlier steps are readable — declaration order is the
 *  existence guarantee. */
/** The fixed, statically-typed field set of the `feature` context root. */
const FEATURE_FIELD_TYPES: Readonly<Record<string, ExprType>> = {
  title: "string",
  slug: "string",
  description: "string",
  pr: "number",
}

function typeOfFeaturePath(segments: readonly string[]): ExprType | undefined {
  if (segments.length !== 2) return undefined
  return FEATURE_FIELD_TYPES[segments[1]!]
}

function typeOfStepPath(
  segments: readonly string[],
  stepIndex: number,
  jobId: string,
  job: JobDef,
  def: WorkflowDef,
  refs: ValidatedRefs,
): ExprType | undefined {
  if (segments[0] === "feature") return typeOfFeaturePath(segments)
  if (segments[0] === "inputs") {
    const name = segments[1]
    return name !== undefined ? def.inputs[name]?.type : undefined
  }
  if (segments[0] === "steps") {
    const stepId = segments[1]
    const name = segments[3]
    if (stepId === undefined || segments[2] !== "outputs" || name === undefined) return undefined
    const referencedIndex = job.steps.findIndex(step => step.id === stepId)
    if (referencedIndex === -1 || referencedIndex >= stepIndex) return undefined
    const model = refs.stepOutputs[jobId]?.[stepId]
    return model === undefined ? undefined : stepOutputType(model, name)
  }
  if (segments[0] === "needs") {
    const dependencyId = segments[1]
    const name = segments[3]
    if (dependencyId === undefined || segments[2] !== "outputs" || name === undefined) return undefined
    if (!job.needs.includes(dependencyId)) return undefined
    return refs.jobOutputs[dependencyId]?.[name]
  }
  return undefined
}

/** Static types for a path read in a job's own `if` condition: no `steps`
 *  (the job has not run yet), but dependency outputs are readable. */
function typeOfJobIfPath(
  segments: readonly string[],
  jobId: string,
  job: JobDef,
  def: WorkflowDef,
  refs: ValidatedRefs,
): ExprType | undefined {
  return typeOfStepPath(segments, 0, jobId, job, def, refs)
}

/** Static types for a path read inside job `jobId`'s own `outputs` block. */
function typeOfJobPath(
  segments: readonly string[],
  jobId: string,
  job: JobDef,
  def: WorkflowDef,
  refs: ValidatedRefs,
): ExprType | undefined {
  if (segments[0] === "feature") return typeOfFeaturePath(segments)
  if (segments[0] === "inputs") {
    const name = segments[1]
    return name !== undefined ? def.inputs[name]?.type : undefined
  }
  if (segments[0] === "steps") {
    const stepId = segments[1]
    const name = segments[3]
    if (stepId === undefined || segments[2] !== "outputs" || name === undefined) return undefined
    if (!job.steps.some(step => step.id === stepId)) return undefined
    const model = refs.stepOutputs[jobId]?.[stepId]
    return model === undefined ? undefined : stepOutputType(model, name)
  }
  return undefined
}

/**
 * `feedback.jobs[J][S]` in job X is legal iff some rerun route targets X
 *  (job-scope: J is one of the rerun's targets or its routing job; step-scope:
 *  J is the routing job itself) and S is a step the rerun snapshots. The
 *  reference resolves at runtime from the rerun's pre-reset snapshot — the
 *  DAG edge is the rerun route itself, never `needs`.
 */
function validateFeedbackPath(segments: readonly string[], check: ExpressionCheck): void {
  const { where, errors } = check
  if (segments.length === 1) {
    errors.push(`${where}: "feedback" alone is not a value — read "feedback.message" or feedback.jobs["<job>"]["<step>"]["<output>"]`)
    return
  }
  if (segments[1] === "message") {
    if (segments.length > 2) errors.push(`${where}: feedback.message has no further fields`)
    return
  }
  if (segments[1] !== "jobs") {
    errors.push(`${where}: feedback has no field "${segments[1]}"`)
    return
  }
  const jobId = segments[2]
  const stepId = segments[3]
  const name = segments[4]
  if (jobId === undefined || stepId === undefined || name === undefined) {
    errors.push(`${where}: feedback.jobs needs the form feedback.jobs["<job>"]["<step>"]["<output>"]`)
    return
  }
  if (segments.length > 5) {
    errors.push(`${where}: feedback.jobs goes too deep — feedback.jobs["<job>"]["<step>"]["<output>"] is the full path`)
    return
  }

  const relevant = check.rerunRoutes.filter(route =>
    route.target.scope === "jobs"
      ? route.target.jobIds.includes(check.feedbackRoot)
      : route.routingJob === check.feedbackRoot,
  )
  if (relevant.length === 0) {
    errors.push(
      `${where}: feedback.jobs["${jobId}"] is not readable here — feedback requires a rerun that targets job "${check.feedbackRoot}"`,
    )
    return
  }

  const stepExistsIn = (job: string, step: string): boolean =>
    check.def.jobs[job]?.steps.some(candidate => candidate.id === step) ?? false

  const legal = relevant.some(route => {
    if (route.target.scope === "jobs") {
      if (jobId === route.routingJob) return stepId === route.routingStep
      if (route.target.jobIds.includes(jobId)) return stepExistsIn(jobId, stepId)
      return false
    }
    return jobId === route.routingJob && stepExistsIn(jobId, stepId)
  })

  if (!legal) {
    errors.push(
      `${where}: feedback.jobs["${jobId}"]["${stepId}"] is not readable here — ` +
        `this job's rerun snapshots: ${describeFeedbackRefs(relevant)}`,
    )
  }
}

function describeFeedbackRefs(routes: readonly RerunRoute[]): string {
  const refs = new Set<string>()
  for (const route of routes) {
    if (route.target.scope === "jobs") {
      for (const jobId of route.target.jobIds) refs.add(`"${jobId}"`)
      refs.add(`"${route.routingJob}" at "${route.routingStep}"`)
    } else {
      refs.add(`"${route.routingJob}"`)
    }
  }
  return [...refs].join(", ")
}

