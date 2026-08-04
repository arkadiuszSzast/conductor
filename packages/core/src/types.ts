/**
 * Workflow IR — the canonical data model for Conductor.
 *
 * Designed for DAG workflows (GitHub-Actions-style) while keeping
 * single-job linear pipelines the simple case.  No legacy shapes:
 * builtin actions are gone (use `action` with `uses`), flat step lists
 * are gone (steps live inside `jobs`), and daemon config does not
 * leak into the pure core.
 */

// ---------------------------------------------------------------------------
// Workflow definition (immutable, loaded from YAML by the server)
// ---------------------------------------------------------------------------

export interface WorkflowDef {
  readonly name: string
  readonly on?: readonly TriggerDef[]
  readonly inputs?: Readonly<Record<string, InputDef>>
  readonly jobs: Readonly<Record<string, JobDef>>
  readonly roles: Readonly<Record<string, RoleDef>>
}

export type TriggerDef =
  | { readonly kind: "manual" }
  | { readonly kind: "schedule"; readonly cron: string; readonly missedFire?: "skip" | "catch-up" }
  | { readonly kind: "event"; readonly event: string }

export interface InputDef {
  readonly type: "string" | "number" | "boolean"
  readonly required?: boolean
  readonly default?: string | number | boolean
}

export interface JobDef {
  readonly needs?: readonly string[]
  readonly if?: string
  readonly steps: readonly StepDef[]
  readonly outputs?: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Steps — exactly four kinds
// ---------------------------------------------------------------------------

export type StepDef = AgentStep | ActionStep | CommandStep | HumanStep

interface StepBase {
  readonly id: string
  readonly if?: string
  readonly then?: string
  /** Routes keyed by the step's declared outcome. A step that completes its
   *  work reports an outcome (default `"done"`); the interpreter routes on it.
   *  This is one mechanism for every "the step worked, here is its result"
   *  case: review verdicts, consensus checks, classifiers, gate results. */
  readonly outcomes?: Outcomes
  /** Route taken when the step could NOT complete its work (crash, non-zero
   *  exit, timeout, transport error) after its retry budget is exhausted.
   *  Distinct from an outcome: a failure means "re-running may help". */
  readonly onFail?: Route
  readonly retry?: RetryPolicy
  readonly onReject?: Route
}

/** Outcome name → route. Outcome names are workflow-defined strings; the
 *  interpreter attaches no meaning to any particular name. */
export interface Outcomes {
  readonly [outcome: string]: Route
}

/** A route: exactly one of `goto`, `next`, `rerun`. Validation rejects a
 *  mixture. `rerun` re-executes earlier steps/jobs as a bounded loop. */
export interface Route {
  readonly goto?: string
  readonly next?: boolean
  readonly rerun?: RerunTarget
}

/** Re-execute earlier work as a bounded loop. `stepIds` re-runs steps within
 *  the routing job (review/fix loops); `jobIds` re-runs upstream jobs and
 *  their downstream closure (parallel-agent consensus). At least one is
 *  required. */
export interface RerunTarget {
  readonly stepIds?: readonly string[]
  readonly jobIds?: readonly string[]
  /** Total iterations including the first run. Must be ≥ 1 — every loop is
   *  bounded by construction. */
  readonly maxRounds: number
}

/** An agent step performs LLM work. The `prompt` is always required —
 *  the IR must be self-describing; the engine may prepend role-level
 *  context, but the step itself carries the template. */
export interface AgentStep extends StepBase {
  readonly type: "agent"
  readonly role: string
  readonly prompt: string
}

export interface ActionStep extends StepBase {
  readonly type: "action"
  readonly uses: string
  readonly with?: Readonly<Record<string, unknown>>
}

export interface CommandStep extends StepBase {
  readonly type: "command"
  readonly run: readonly string[]
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface HumanStep extends StepBase {
  readonly type: "human"
}

// ---------------------------------------------------------------------------
// Retry — sealed policies, each variant is self-contained (no all-null config)
// ---------------------------------------------------------------------------

/** How to re-attempt a step that failed. Absent `retry` on a step behaves
 *  like `{ strategy: "none" }`. */
export type RetryPolicy =
  | { readonly strategy: "none" }
  | {
      readonly strategy: "backoff"
      /** Total attempts including the first. Must be ≥ 1. */
      readonly maxAttempts: number
      /** ISO-8601 duration (e.g. "PT10M") capping total elapsed time. */
      readonly maxElapsed?: string
      /** Backoff strategy — always required for a "backoff" policy. */
      readonly backoff: BackoffDef
    }

/** Sealed: the discriminant lets the engine match-and-add strategies without
 *  opening a general eval surface. */
export type BackoffDef =
  | { readonly strategy: "constant"; readonly delay: number }
  | {
      readonly strategy: "exponential"
      /** First delay in ms. Must be ≥ 0. */
      readonly initial: number
      /** Delay multiplier per attempt. Must be ≥ 1. */
      readonly multiplier: number
      /** Delay cap in ms. Must be ≥ 0. */
      readonly max: number
      /** Jitter mode. Default: "full". */
      readonly jitter?: "none" | "full" | "equal"
    }

// ---------------------------------------------------------------------------
// Roles (pure metadata — the engine resolves agent/model/variant)
// ---------------------------------------------------------------------------

export interface RoleDef {
  readonly agent: string
  readonly model?: string
  readonly variant?: string
}

// ---------------------------------------------------------------------------
// Runtime state (persisted in SQLite, mirrored here as plain types)
// ---------------------------------------------------------------------------

export type FeatureStatus =
  | "running"
  | "paused"
  | "waiting_human"
  | "escalated"
  | "done"
  | "abandoned"

export type JobStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "escalated"
  | "waiting_human"

export interface TriggerEvent {
  readonly kind: string
  readonly deliveryId: string
  readonly inputs?: Readonly<Record<string, unknown>>
}

export interface FeatureState {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly projectDir: string
  readonly workflow: string | null
  readonly description: string | null
  readonly status: FeatureStatus
  readonly trigger: TriggerEvent | null
  readonly input: Readonly<Record<string, unknown>>
  readonly sessionId: string | null
  readonly worktree: string | null
  readonly branch: string | null
  readonly pr: number | null
  readonly jobs: Readonly<Record<string, JobRuntime>>
}

export interface JobRuntime {
  readonly status: JobStatus
  readonly currentStep: string | null
  readonly attempts: Readonly<Record<string, number>>
  readonly rounds: Readonly<Record<string, number>>
  /** Per-routing-step rerun loop counter (survives closure reset). */
  readonly reruns: Readonly<Record<string, number>>
  readonly outputs: Readonly<Record<string, unknown>>
  readonly steps: Readonly<Record<string, StepRuntime>>
}

export interface StepRuntime {
  readonly status: StepStatus
  readonly output: string | null
}

// ---------------------------------------------------------------------------
// Events — everything that can advance a feature
// ---------------------------------------------------------------------------

export type PipelineEvent =
  | { readonly kind: "feature.start" }
  /** The step completed its work. `outcome` selects the route from the step's
   *  `outcomes` map (default `"done"` when the step declares none); `output`
   *  is the step's payload, available to later steps and to feedback. */
  | {
      readonly kind: "step.completed"
      readonly jobId: string
      readonly stepId: string
      readonly outcome?: string
      readonly output?: string
    }
  /** The step could NOT complete its work (crash, non-zero exit, timeout).
   *  Subject to the retry budget, then `onFail`. */
  | { readonly kind: "step.failed"; readonly jobId: string; readonly stepId: string; readonly reason: string }
  | { readonly kind: "human.approved"; readonly jobId: string; readonly stepId: string }
  | { readonly kind: "human.rejected"; readonly jobId: string; readonly stepId: string; readonly notes?: string }
  | { readonly kind: "human.paused" }
  | { readonly kind: "human.resumed" }
  | { readonly kind: "human.abandoned" }

/** The outcome assumed when a step reports completion without naming one. */
export const DEFAULT_OUTCOME = "done"

// ---------------------------------------------------------------------------
// Decisions — the interpreter's output (can be multiple for DAG fan-out)
// ---------------------------------------------------------------------------

export type Decision =
  | { readonly kind: "execute_step"; readonly jobId: string; readonly stepId: string }
  | { readonly kind: "wait_human"; readonly jobId: string; readonly stepId: string }
  | { readonly kind: "skip_job"; readonly jobId: string; readonly reason: string }
  | { readonly kind: "escalate"; readonly reason: string }
  | { readonly kind: "finish" }
  | { readonly kind: "pause" }
  | { readonly kind: "abandon" }
  | { readonly kind: "noop"; readonly reason: string }

export interface Transition {
  readonly decisions: readonly Decision[]
  readonly patch: Patch
  /** Feedback snapshot attached to a `rerun` transition: the pre-reset round's
   *  step outputs plus the route reason. The engine merges `feedback` into the
   *  template context of re-run steps (`{{ feedback.jobs.<jobId>.<stepId> }}`,
   *  `{{ feedback.message }}`). */
  readonly feedback?: Feedback
}

export interface Feedback {
  readonly jobs: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly message?: string
}

export interface Patch {
  readonly status?: FeatureStatus
  readonly jobs?: Readonly<Record<string, JobPatch>>
}

export interface JobPatch {
  readonly status?: JobStatus
  readonly currentStep?: string | null
  readonly attempts?: Readonly<Record<string, number>>
  readonly rounds?: Readonly<Record<string, number>>
  readonly reruns?: Readonly<Record<string, number>>
  readonly outputs?: Readonly<Record<string, unknown>>
  readonly steps?: Readonly<Record<string, StepPatch>>
}

export interface StepPatch {
  readonly status?: StepStatus
  readonly output?: string | null
}
