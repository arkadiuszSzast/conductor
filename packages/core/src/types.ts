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
  readonly onFail?: RerunRoute
  readonly retry?: RetryPolicy
  readonly onReject?: RerunRoute
}

/** A failure/rejection/verdict route: exactly one of `goto`, `next`, `rerun`.
 *  Validation rejects a mixture. `rerun` re-triggers upstream jobs as a
 *  bounded loop (see `cross-job-loops`). */
export interface RerunRoute {
  readonly goto?: string
  readonly next?: boolean
  readonly rerun?: RerunTarget
}

export interface RerunTarget {
  readonly jobIds: readonly string[]
  /** Total iterations including the first run. Must be ≥ 1 — every cross-job
   *  cycle is bounded by construction. */
  readonly maxRounds: number
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
// Verdict routing (review loops)
// ---------------------------------------------------------------------------

/** `verdict` is the structured outcome of an agent's review/evaluation step
 *  (e.g. "approved", "changes_requested"). It is NOT GitHub-specific — any
 *  review process produces a verdict. `onVerdict` maps verdict strings to
 *  routing targets. */
export interface OnVerdict {
  readonly [verdict: string]: RerunRoute
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
  | { readonly kind: "step.succeeded"; readonly jobId: string; readonly stepId: string; readonly output?: string }
  | { readonly kind: "step.failed"; readonly jobId: string; readonly stepId: string; readonly reason: string }
  | { readonly kind: "step.verdict"; readonly jobId: string; readonly stepId: string; readonly verdict: string; readonly output?: string }
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
