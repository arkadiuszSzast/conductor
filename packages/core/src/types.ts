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
  readonly onFail?: { readonly goto?: string }
  readonly retry?: RetryPolicy
  readonly onReject?: { readonly goto: string }
}

/** An agent step performs LLM work. The `prompt` is always required —
 *  the IR must be self-describing; the engine may prepend role-level
 *  context, but the step itself carries the template. */
export interface AgentStep extends StepBase {
  readonly type: "agent"
  readonly role: string
  readonly prompt: string
  readonly onVerdict?: OnVerdict
  readonly roundsWith?: string
  readonly maxRounds?: number | "unlimited"
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
// Retry — a sealed policy with a discriminated backoff strategy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Total attempts including the first. Default: 1 (no retry). */
  readonly maxAttempts?: number
  /** ISO-8601 duration (e.g. "10m"). Default: "10m". */
  readonly maxElapsed?: string
  /** Backoff strategy. Default: exp-backoff with sane defaults. */
  readonly backoff?: BackoffDef
}

/** Sealed: only "exp-backoff" for now; the discriminant lets the engine
 *  match-and-add strategies without opening a general eval surface. */
export type BackoffDef = {
  readonly strategy: "exp-backoff"
  /** Initial delay in ms. Default: 1000. */
  readonly initial?: number
  /** Multiplier per attempt. Default: 2. */
  readonly multiplier?: number
  /** Max delay cap in ms. Default: 60000. */
  readonly max?: number
  /** Jitter mode. Default: "full". */
  readonly jitter?: "none" | "full" | "equal"
}

// ---------------------------------------------------------------------------
// Verdict routing (review loops)
// ---------------------------------------------------------------------------

/** `verdict` is the structured outcome of an agent's review/evaluation step
 *  (e.g. "approved", "changes_requested"). It is NOT GitHub-specific — any
 *  review process produces a verdict. `onVerdict` maps verdict strings to
 *  routing targets. */
export interface OnVerdict {
  readonly [verdict: string]: { readonly goto?: string; readonly next?: boolean }
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
  | { readonly kind: "step.succeeded"; readonly jobId: string; readonly stepId: string; readonly output?: string }
  | { readonly kind: "step.failed"; readonly jobId: string; readonly stepId: string; readonly reason: string }
  | { readonly kind: "step.verdict"; readonly jobId: string; readonly stepId: string; readonly verdict: string }
  | { readonly kind: "human.approved"; readonly jobId: string; readonly stepId: string }
  | { readonly kind: "human.rejected"; readonly jobId: string; readonly stepId: string; readonly notes?: string }
  | { readonly kind: "human.paused" }
  | { readonly kind: "human.resumed" }
  | { readonly kind: "human.abandoned" }

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
  readonly steps?: Readonly<Record<string, StepPatch>>
}

export interface StepPatch {
  readonly status?: StepStatus
  readonly output?: string | null
}
