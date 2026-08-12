/**
 * `{{ ... }}` template rendering over the expression language.
 *
 * Replaces the earlier dotted-path-only renderer: every placeholder is a
 * full expression parsed by `expression.ts`, so templates and standalone
 * expressions share one grammar, one validator and one evaluator.
 *
 * Hard/soft semantics live in the evaluator: `inputs`/`steps`/`needs`
 * misses raise (reported here as errors — the engine must not dispatch a
 * step whose template failed), while `feedback` misses render as the empty
 * string by design (round 1 has no previous round).
 */

import { evaluate, parseExpression } from "./expression.ts"
import type { EvalContext, Value } from "./expression.ts"
import type { Feedback, FeatureState, JobRuntime, StepRuntime, WorkflowDef } from "./types.ts"

const TEMPLATE_PATTERN = /\{\{([\s\S]*?)\}\}/g

export interface RenderResult {
  readonly text: string
  /** Parse or evaluation failures. Non-empty means the text is incomplete
   *  and MUST NOT be dispatched: a hard reference failed to resolve. */
  readonly errors: readonly string[]
}

export function renderTemplate(template: string, context: EvalContext): RenderResult {
  const errors: string[] = []
  const text = template.replace(TEMPLATE_PATTERN, (_match, source: string) => {
    const parsed = parseExpression(source)
    if (!parsed.ok) {
      errors.push(`{{${source}}}: ${parsed.error}`)
      return ""
    }
    try {
      return stringify(evaluate(parsed.expr, context))
    } catch (error) {
      errors.push(`{{${source}}}: ${(error as Error).message}`)
      return ""
    }
  })
  return { text, errors }
}

/** The raw expression sources embedded in a template, for validation. */
export function extractExpressions(template: string): readonly string[] {
  const sources: string[] = []
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    sources.push(match[1]!)
  }
  return sources
}

function stringify(value: Value): string {
  if (value === null) return ""
  return typeof value === "string" ? value : String(value)
}

// ---------------------------------------------------------------------------
// Context assembly from persisted state
// ---------------------------------------------------------------------------

/**
 * The evaluation context for templates inside `jobId`: trigger inputs, the
 * job's own step outputs (live), the declared outputs of its dependencies
 * (live), and — during a rerun round — the pre-reset feedback snapshot.
 */
export function buildEvalContext(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  feedback?: Feedback,
): EvalContext {
  const job = workflow.jobs[jobId]
  const jobRuntime = state.jobs[jobId]

  const steps: Record<string, { outputs: Readonly<Record<string, string>> }> = {}
  for (const [stepId, stepRuntime] of Object.entries(jobRuntime?.steps ?? {})) {
    steps[stepId] = { outputs: stepRuntime.outputs }
  }

  const needs: Record<string, { outputs: Readonly<Record<string, string>> }> = {}
  for (const dependencyId of job?.needs ?? []) {
    needs[dependencyId] = { outputs: onlyStrings(state.jobs[dependencyId]?.outputs ?? {}) }
  }

  return {
    inputs: onlyValues(state.input),
    steps,
    needs,
    feature: {
      title: state.title,
      slug: state.slug,
      description: state.description ?? "",
      pr: state.pr,
    },
    ...(feedback ? { feedback } : {}),
  }
}

function onlyValues(record: Readonly<Record<string, unknown>>): Readonly<Record<string, Value>> {
  const result: Record<string, Value> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value
    }
  }
  return result
}

function onlyStrings(record: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") result[key] = value
  }
  return result
}

/**
 * Resolve `JobDef.outputs` once a job succeeds, against the job's step
 * outputs (live — this is the current round). Each declared output is a
 * template and renders to a string; a declared output that fails to
 * evaluate resolves to `null`, keeping the job's completion honest: it
 * still publishes its other outputs, and consumers see a nullish value
 * rather than a stale one. Static checks in validation guarantee declared
 * outputs resolve in practice.
 */
export function resolveJobOutputs(
  workflow: WorkflowDef,
  state: FeatureState,
  jobId: string,
  completedStepId: string,
  completedOutputs?: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const job = workflow.jobs[jobId]
  const runtime = state.jobs[jobId]
  const jobOutputs: Record<string, unknown> = {}
  if (!job) return jobOutputs

  const mergedSteps: Record<string, StepRuntime> = { ...(runtime?.steps ?? {}) }
  mergedSteps[completedStepId] = { status: "succeeded", outputs: completedOutputs ?? {} }

  const mergedRuntime: JobRuntime = {
    status: runtime?.status ?? "pending",
    currentStep: runtime?.currentStep ?? null,
    attempts: runtime?.attempts ?? {},
    reruns: runtime?.reruns ?? {},
    outputs: runtime?.outputs ?? {},
    steps: mergedSteps,
  }

  const mergedState: FeatureState = {
    ...state,
    jobs: { ...state.jobs, [jobId]: mergedRuntime },
  }
  const context = buildEvalContext(workflow, mergedState, jobId)

  for (const [name, expression] of Object.entries(job.outputs)) {
    const rendered = renderTemplate(expression, context)
    jobOutputs[name] = rendered.errors.length === 0 ? rendered.text : null
  }
  return jobOutputs
}
