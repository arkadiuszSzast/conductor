/**
 * Payload types for the daemon's HTTP API v1.
 *
 * Local, hand-rolled projection types — deliberately NOT imported from
 * `@conductor/core`/`@conductor/server`: the browser bundle only needs the
 * JSON contract documented in `docs/http-api.md`, and keeping these local
 * makes the contract explicit and freezes the bundle's coupling to the
 * wire shape.
 */

export type FeatureStatus = "running" | "paused" | "waiting_human" | "escalated" | "done" | "abandoned"
export type JobStatus = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped"
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "escalated" | "waiting_human"
export type StepKind = "agent" | "command" | "action" | "human"

export interface FindingCounts {
  readonly new: number
  readonly fixed: number
  readonly dismissed: number
  readonly reopened: number
}

/** Shape shared by list items and the detail — the list keeps a per-job
 *  summary, the detail replaces `jobs` with the full runtime. */
export interface FeatureBase {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly projectDir: string
  readonly workflow: string | null
  readonly description: string | null
  readonly status: FeatureStatus
  readonly sessionId: string | null
  readonly worktree: string | null
  readonly branch: string | null
  readonly pr: number | null
  readonly escalation: string | null
  readonly currentStep: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly findingCounts: FindingCounts
}

export interface FeatureListItem extends FeatureBase {
  readonly jobs: Readonly<Record<string, { readonly status: JobStatus; readonly currentStep: string | null }>>
}

export interface StepRuntimeProjection {
  readonly status: StepStatus
  readonly outputs: Readonly<Record<string, string>>
  readonly truncated?: boolean
  readonly runId?: string
  /** Rendered gate prompt, present while the step waits for a human. */
  readonly prompt?: string
}

export interface JobRuntimeProjection {
  readonly status: JobStatus
  readonly currentStep: string | null
  readonly attempts: Readonly<Record<string, number>>
  readonly reruns: Readonly<Record<string, number>>
  readonly outputs: Readonly<Record<string, unknown>>
  readonly steps: Readonly<Record<string, StepRuntimeProjection>>
}

export interface Feedback {
  readonly jobs: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>
  readonly message: string
}

export interface FeatureActivity {
  readonly state: "active" | "waiting_retry" | "blocked" | "waiting_human" | "paused" | "escalated" | "terminal"
  readonly activeCount: number
  readonly targets: readonly { readonly jobId: string; readonly stepId: string }[]
  readonly target: { readonly jobId: string; readonly stepId: string } | null
  readonly reason: string | null
  readonly diagnostic: string | null
  readonly nextAt: number | null
  readonly deadlineAt: number | null
  readonly message: string
}

export interface FeatureDetail extends FeatureBase {
  readonly workflowRef: { readonly name: string; readonly stale: boolean } | null
  readonly feedback: Feedback | null
  readonly jobs: Readonly<Record<string, JobRuntimeProjection>>
  readonly activity?: FeatureActivity
  /** Every currently recoverable job/step target — present only while
   *  `status` is `"escalated"`; the order `POST .../recover` would pick
   *  as its default (untargeted) choice. */
  readonly recoverableTargets?: readonly { readonly jobId: string; readonly stepId: string }[]
}

export interface FeatureDetailResponse {
  readonly feature: FeatureDetail
  readonly activeRun: RunSummary | null
  readonly activeRuns?: readonly RunSummary[]
}

/** Present only while a durably accepted answer has not yet been
 *  confirmed delivered — `"pending"` (not yet claimed for delivery, e.g.
 *  the feature is paused or a claim attempt is still in flight) or
 *  `"claimed"` (a delivery attempt currently holds the lease). Absent
 *  once delivered (the question is cleared then too), failed or
 *  cancelled (normal failure routing takes over) — harden-interactive-
 *  answer-delivery task 3.1: additive, so a client that only reads
 *  `pendingQuestion` sees no shape change. */
export interface RunAnswerDelivery {
  readonly status: "pending" | "claimed"
  readonly acceptedAt: number
}

export interface RunSummary {
  readonly id: string
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly stepType: "agent" | "command" | "action"
  readonly attempt: number
  readonly status: "running" | "succeeded" | "failed" | "reaped"
  readonly sessionId: string | null
  readonly outputs: Readonly<Record<string, string>>
  readonly reason: string | null
  readonly nudges: number
  readonly pendingQuestion?: string | null
  /** An accepted-but-undelivered answer for this run's question, if any —
   *  see `RunAnswerDelivery`. */
  readonly answerDelivery?: RunAnswerDelivery
  readonly timeStarted: number
  readonly timeFinished: number | null
}

export type InputType = "string" | "number" | "boolean"

/** An input is either required or has a default — never both, never
 *  neither (mirrors `@conductor/core`'s `InputDef`, kept local per this
 *  file's header note). */
export type InputDef =
  | { readonly type: InputType; readonly presence: "required" }
  | { readonly type: InputType; readonly presence: "optional"; readonly default: string | number | boolean }

export interface WorkflowProjection {
  readonly name: string
  readonly stale: boolean
  readonly jobs: Readonly<
    Record<string, { readonly needs: readonly string[]; readonly steps: readonly { readonly id: string; readonly kind: StepKind }[] }>
  >
  /** Safe, name-keyed input definitions for the served snapshot — the
   *  ONE exception to "structure only": defaults and required/optional
   *  presence are user-facing start-form values, not authoring secrets.
   *  Prompts, expressions, role/model bindings and retry policy never
   *  appear here. */
  readonly inputs: Readonly<Record<string, InputDef>>
  readonly diagnostics: readonly string[]
}

/** `POST /v1/features` body — `title` and `project` are required; every
 *  other field, including `inputs`, is optional (omitting `inputs` is
 *  equivalent to `{}`). */
export interface StartFeatureRequest {
  readonly title: string
  readonly project: string
  readonly description?: string
  readonly workflow?: string
  readonly pr?: number
  readonly inputs?: Readonly<Record<string, string | number | boolean>>
}

/** `diagnostics[].kind` on a 422 `invalid_input` response — `name` is
 *  absent only for `invalid_payload` (the payload itself, not one named
 *  input, is wrong). */
export interface WorkflowInputDiagnostic {
  readonly name?: string
  readonly kind: "invalid_payload" | "unknown_input" | "missing_required" | "wrong_type"
  readonly message: string
}

export interface FindingView {
  readonly id: string
  readonly stepId: string
  readonly path: string
  readonly line: number
  readonly severity: string
  readonly tags: readonly string[]
  readonly body: string
  readonly status: "new" | "fixed" | "dismissed" | "reopened"
  readonly resolution: string | null
  readonly threadId: string | null
  readonly synced: boolean
}

export interface TransitionEntry {
  readonly event: Readonly<Record<string, unknown>> & { readonly kind: string }
  readonly decisions: readonly unknown[]
  readonly time: number
}

export type RunLogSource = "process" | "action" | "agent" | "step"

export interface RunLogLine {
  readonly seq: number
  readonly time: number
  readonly source: RunLogSource
  readonly text: string
}

export interface RunLogPage {
  readonly lines: readonly RunLogLine[]
  /** Cursor for the next fetch: the highest seq the caller has seen. */
  readonly nextSeq: number
  /** True when more lines exist beyond this page. */
  readonly truncated: boolean
}

export interface DaemonHealth {
  readonly alive: boolean
  readonly ready: boolean
  readonly phase: string
  readonly database: {
    readonly path: string
    readonly migrated: boolean
    readonly appliedNow: readonly string[]
    readonly knownMigrations: number
  }
  readonly heartbeat: {
    readonly intervalMs: number
    readonly running: boolean
    readonly inFlight: boolean
    readonly lastStartedAt: number | null
    readonly lastCompletedAt: number | null
    readonly lastError: string | null
    readonly cycles: number
  }
  readonly projects: readonly DaemonProjectHealth[]
  readonly runner: "available" | "unavailable"
}

export type ProjectWorkflowState = "unregistered" | "valid" | "stale" | "invalid"

export interface HealthDiagnostic {
  readonly sourcePath: string
  /** May embed daemon-local absolute filesystem paths for action-
   *  resolution failures — never render this directly; use
   *  `safeMessage`, which is the same diagnostic with any such paths
   *  stripped. */
  readonly message: string
  /** Path-free rendering of `message`, safe to show in the browser.
   *  Optional only for wire compatibility with a daemon that predates
   *  this field — callers must fall back to `message` in that case. */
  readonly safeMessage?: string
}

export interface DaemonProjectHealth {
  readonly projectDir: string
  readonly state: ProjectWorkflowState
  readonly diagnostics: readonly HealthDiagnostic[]
}

/** Invalidation frame carried by the SSE stream. */
export interface ChangeEvent {
  readonly kind: "feature" | "transition" | "run" | "finding" | "run_log"
  readonly featureId: string
}

/** The plugin subsystem's own SSE invalidation — no feature to scope to;
 *  subscribers refetch `GET /v1/plugins` on it. */
export interface PluginsChangeEvent {
  readonly kind: "plugins"
}

export type PluginScope = "global" | "project"
export type PluginState = "running" | "stopped" | "disabled" | "error"

export interface PluginPanelMeta {
  readonly title: string
  readonly icon?: string
}

export interface PluginDiagnostic {
  readonly path: string
  readonly message: string
}

export interface PluginListingItem {
  readonly id: string
  readonly scope: PluginScope
  /** Present only for `scope: "project"`. */
  readonly project?: string
  readonly panel: PluginPanelMeta
  readonly state: PluginState
  readonly diagnostics: readonly PluginDiagnostic[]
}

export interface PluginListingResponse {
  readonly enabled: boolean
  readonly plugins: readonly PluginListingItem[]
  /** Load-level diagnostics (broken manifests, conflicts) not tied to one plugin. */
  readonly diagnostics: readonly PluginDiagnostic[]
}

export interface CommandResponse extends FeatureDetailResponse {
  readonly result: string
}

/** `POST /v1/runs/:id/answer` — NOT a `CommandResponse`: the server
 *  returns the answered run alone, never a feature detail payload. */
export interface AnswerRunResponse {
  readonly result: string
  readonly run: RunSummary | null
}
