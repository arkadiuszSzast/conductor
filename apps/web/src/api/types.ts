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

export interface FeatureDetail extends FeatureBase {
  readonly workflowRef: { readonly name: string; readonly stale: boolean } | null
  readonly feedback: Feedback | null
  readonly jobs: Readonly<Record<string, JobRuntimeProjection>>
}

export interface FeatureDetailResponse {
  readonly feature: FeatureDetail
  readonly activeRun: RunSummary | null
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
  readonly timeStarted: number
  readonly timeFinished: number | null
}

export interface WorkflowProjection {
  readonly name: string
  readonly stale: boolean
  readonly jobs: Readonly<
    Record<string, { readonly needs: readonly string[]; readonly steps: readonly { readonly id: string; readonly kind: StepKind }[] }>
  >
  readonly diagnostics: readonly string[]
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
  readonly projects: readonly { readonly projectDir: string; readonly state: string; readonly diagnostics: readonly unknown[] }[]
  readonly runner: "available" | "unavailable"
}

/** Invalidation frame carried by the SSE stream. */
export interface ChangeEvent {
  readonly kind: "feature" | "transition" | "run" | "finding" | "run_log"
  readonly featureId: string
}

export interface CommandResponse extends FeatureDetailResponse {
  readonly result: string
}
