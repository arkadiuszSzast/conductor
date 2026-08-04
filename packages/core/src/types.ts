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
  readonly on_fail?: OnFail
  readonly on_reject?: { readonly goto: string }
}

export interface AgentStep extends StepBase {
  readonly type: "agent"
  readonly role: string
  readonly prompt?: string
  readonly on_verdict?: OnVerdict
  readonly rounds_with?: string
  readonly max_rounds?: number
  readonly publish?: PublishDef
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
  readonly timeout_ms?: number
}

export interface HumanStep extends StepBase {
  readonly type: "human"
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface OnFail {
  readonly goto?: string
  readonly max_attempts?: number
  readonly escalate?: boolean
  readonly retry?: RetryPolicy
}

export interface RetryPolicy {
  readonly max_attempts?: number
  readonly max_elapsed?: string
  readonly backoff?: BackoffDef
}

export interface BackoffDef {
  readonly initial: number
  readonly multiplier: number
  readonly max: number
  readonly jitter: "none" | "full" | "equal"
}

export interface OnVerdict {
  readonly [verdict: string]: { readonly goto?: string; readonly next?: boolean }
}

// ---------------------------------------------------------------------------
// Roles and publishing
// ---------------------------------------------------------------------------

export interface RoleDef {
  readonly agent: string
  readonly model?: string
  readonly variant?: string
  readonly session?: "fresh" | "feature"
}

export interface PublishDef {
  readonly mode: "github-review" | "comment-only" | "none"
  readonly tokenCommand?: string
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
