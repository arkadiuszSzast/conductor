/**
 * Workflow IR — the canonical data model for Conductor.
 *
 * Designed for DAG workflows (GitHub-Actions-style) while keeping
 * single-job linear pipelines the simple case.  No legacy shapes:
 * builtin actions are gone (use `action` with `uses`), flat step lists
 * are gone (steps live inside `jobs`), and daemon config does not
 * leak into the pure core.
 *
 * This is the NORMALISED form: the product of parsing, not the authoring
 * surface. YAML may omit `needs`, `outputs`, `on` and friends; the parser
 * fills the empty collection. So a field is optional here only when its
 * absence means something an empty value cannot express, and choices are
 * modelled as discriminated unions rather than bags of optional fields.
 */

// ---------------------------------------------------------------------------
// Workflow definition (immutable, produced by the parser)
// ---------------------------------------------------------------------------

export interface WorkflowDef {
  readonly name: string
  /** Empty means the workflow can only be started explicitly. */
  readonly on: readonly TriggerDef[]
  readonly inputs: Readonly<Record<string, InputDef>>
  readonly jobs: Readonly<Record<string, JobDef>>
  readonly roles: Readonly<Record<string, RoleDef>>
}

export type TriggerDef =
  | { readonly kind: "manual" }
  | { readonly kind: "schedule"; readonly cron: string; readonly missedFire: "skip" | "catch-up" }
  | { readonly kind: "event"; readonly event: string }

/** An input is either required or has a default — never both, never neither. */
export type InputDef =
  | { readonly type: InputType; readonly presence: "required" }
  | { readonly type: InputType; readonly presence: "optional"; readonly default: string | number | boolean }

export type InputType = "string" | "number" | "boolean"

export interface JobDef {
  /** Empty means the job is ready from the start. */
  readonly needs: readonly string[]
  /** Absent means "run when dependencies succeeded"; a condition overrides it
   *  (e.g. `always()`), so absence and "empty condition" differ. */
  readonly if?: string
  readonly steps: readonly StepDef[]
  /** Named outputs published to dependent jobs, as expressions over step
   *  outputs. Empty means the job publishes nothing.
   *
   *  Resolved when the job succeeds (`resolveJobOutputs` in `template.ts`);
   *  a declared output that fails to evaluate resolves to `null`. Values are
   *  live — after a `rerun` the consumer re-reads the new round's values. */
  readonly outputs: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Steps — exactly four kinds
// ---------------------------------------------------------------------------

export type StepDef = AgentStep | ActionStep | CommandStep | HumanStep

interface StepBase {
  readonly id: string
  readonly if?: string
  /** Routes keyed by the step's declared outcome. A step that completes its
   *  work reports an outcome (default `"done"`); the interpreter routes on it.
   *  One mechanism for every "the step worked, here is its result" case:
   *  review verdicts, consensus checks, classifiers, human gate decisions.
   *  Empty means "always advance along the path". */
  readonly outcomes: Outcomes
  /** Where to go when the step could NOT complete its work (crash, non-zero
   *  exit, timeout) after its retry budget is exhausted. Absent means escalate
   *  — distinct from any route, so it cannot be an empty value. */
  readonly onFail?: Route
  readonly retry: RetryPolicy
}

/** Outcome name → route. Outcome names are workflow-defined strings; the
 *  interpreter attaches no meaning to any particular name. */
export interface Outcomes {
  readonly [outcome: string]: Route
}

/** Where a route goes. Exactly one shape — no bag of optional targets. */
export type Route =
  /** Continue along the job's step path. */
  | { readonly kind: "next" }
  /** Jump to another step in the same job. */
  | { readonly kind: "goto"; readonly stepId: string }
  /** Re-execute earlier work as a bounded loop. */
  | { readonly kind: "rerun"; readonly target: RerunTarget }

/** What a rerun re-executes. Exactly one scope — steps within the routing
 *  job (review/fix loops) or upstream jobs and their downstream closure
 *  (parallel-agent consensus). `maxRounds` (≥ 1) bounds every loop by
 *  construction. */
export type RerunTarget =
  | { readonly scope: "steps"; readonly stepIds: readonly string[]; readonly maxRounds: number }
  | { readonly scope: "jobs"; readonly jobIds: readonly string[]; readonly maxRounds: number }

/** An agent step performs LLM work. The `prompt` is always required —
 *  the IR must be self-describing; the engine may prepend role-level
 *  context, but the step itself carries the template. */
export interface AgentStep extends StepBase {
  readonly type: "agent"
  readonly role: string
  readonly prompt: string
  /** Only an interactive step may pause mid-run to ask the human a
   *  question (the ask/answer protocol). Absent means autonomous: the
   *  engine refuses asks and the agent must decide and report. */
  readonly interactive?: boolean
  /** Silence budget for THIS step's runs, in milliseconds — overrides
   *  the engine-wide TTL. Absent means the engine default governs. */
  readonly ttlMs?: number
}

export interface ActionStep extends StepBase {
  readonly type: "action"
  readonly uses: string
  /** Empty means the action takes no inputs. */
  readonly with: Readonly<Record<string, unknown>>
}

export interface CommandStep extends StepBase {
  readonly type: "command"
  readonly run: readonly string[]
  /** Absent means the job's working directory — distinct from any path. */
  readonly cwd?: string
  /** Absent means no timeout; 0 would mean "expire immediately". */
  readonly timeoutMs?: number
}

export interface HumanStep extends StepBase {
  readonly type: "human"
  /** Template shown to the approver when the gate arms. Same expression
   *  contexts as agent prompts. Rendered once at arm time and persisted
   *  under the step's reserved `prompt` output. */
  readonly prompt?: string
}

// ---------------------------------------------------------------------------
// Retry — sealed policies, each variant is self-contained (no all-null config)
// ---------------------------------------------------------------------------

/** How to re-attempt a step that could not complete its work. */
export type RetryPolicy =
  | { readonly strategy: "none" }
  | {
      readonly strategy: "backoff"
      /** Total attempts including the first. Must be ≥ 1. */
      readonly maxAttempts: number
      /** ISO-8601 duration (e.g. "PT10M") capping total elapsed time.
       *  Absent means only the attempt count bounds the retry. */
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
  readonly inputs: Readonly<Record<string, unknown>>
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
  /** Null when the job has not started or has finished. */
  readonly currentStep: string | null
  readonly attempts: Readonly<Record<string, number>>
  /** Per-routing-step rerun loop counter (survives closure reset). */
  readonly reruns: Readonly<Record<string, number>>
  /** Resolved values of `JobDef.outputs`, computed when the job succeeds;
   *  empty until then. Step results live in `steps[].outputs`. */
  readonly outputs: Readonly<Record<string, unknown>>
  readonly steps: Readonly<Record<string, StepRuntime>>
}

export interface StepRuntime {
  readonly status: StepStatus
  /** Named outputs reported on completion (GHA-style `name=value` pairs).
   *  Empty means the step published nothing. The runner decides the names:
   *  command steps write `$CONDUCTOR_OUTPUT`, agent steps report under
   *  `report`, human gates under `notes`, actions per their manifest. */
  readonly outputs: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Events — everything that can advance a feature
// ---------------------------------------------------------------------------

export type PipelineEvent =
  | { readonly kind: "feature.start" }
  /** A step finished its work. `outcome` selects the route from the step's
   *  `outcomes` map (default `"done"`); `outputs` are the step's named
   *  payloads, available to later steps and to feedback.
   *
   *  A human gate uses the same event: approving is an outcome (`"approved"`
   *  by default), rejecting is an outcome too (`"rejected"`), with the note
   *  carried in `outputs` (e.g. `{ notes }`). The interpreter needs no
   *  separate human vocabulary — a gate that wants to loop back on rejection
   *  just maps that outcome to a rerun, exactly like a review step. */
  | {
      readonly kind: "step.completed"
      readonly jobId: string
      readonly stepId: string
      readonly outcome?: string
      readonly outputs?: Readonly<Record<string, string>>
    }
  /** The step could NOT complete its work (crash, non-zero exit, timeout).
   *  Subject to the retry budget, then `onFail`. */
  | { readonly kind: "step.failed"; readonly jobId: string; readonly stepId: string; readonly reason: string }
  /** The engine already scheduled (or was about to dispatch) a retry for
   *  this step's last recorded failure, but the classified retry budget's
   *  elapsed deadline (or, defensively, its attempt count) was exceeded
   *  before the attempt could start — retry-budget spec: "the workflow
   *  reaches its configured terminal route at the deadline without one
   *  extra attempt". Routes exactly like an exhausted `step.failed`
   *  (`onFail` if declared, else job failure) WITHOUT incrementing the
   *  attempt counter again — the failed attempt this exhausts was already
   *  recorded by the `step.failed` that scheduled it. */
  | { readonly kind: "step.budget_exhausted"; readonly jobId: string; readonly stepId: string; readonly reason: string }
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
   *  template context of re-run steps
   *  (`{{ feedback.jobs.<jobId>.<stepId>.<name> }}`, `{{ feedback.message }}`). */
  readonly feedback?: Feedback
}

/** Job → step → named outputs, snapshotted before the rerun reset. */
export interface Feedback {
  readonly jobs: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>
  readonly message: string
}

/**
 * A sparse update to `FeatureState`. Here optionality is meaningful: an
 * absent field means "leave it alone", which no empty value can express.
 */
export interface Patch {
  readonly status?: FeatureStatus
  readonly jobs?: Readonly<Record<string, JobPatch>>
}

export interface JobPatch {
  readonly status?: JobStatus
  readonly currentStep?: string | null
  readonly attempts?: Readonly<Record<string, number>>
  readonly reruns?: Readonly<Record<string, number>>
  readonly outputs?: Readonly<Record<string, unknown>>
  readonly steps?: Readonly<Record<string, StepPatch>>
}

export interface StepPatch {
  readonly status?: StepStatus
  readonly outputs?: Readonly<Record<string, string>>
}
