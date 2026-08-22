/**
 * Typed HTTP client for the daemon's API v1.
 *
 * The client is a thin wire wrapper: one method per REST operation,
 * no pipeline logic, no retries, no state. Every non-2xx response is
 * raised as an `ApiError` carrying the machine-readable error code,
 * HTTP status and `x-request-id` from the daemon's error envelope
 * (`{error: {code, message, requestId}}`), so callers (the CLI, tests,
 * future tooling) can branch on codes instead of parsing prose.
 *
 * The transport is an injectable `(Request) => Promise<Response>` — the
 * same shape as the API's socketless handler — so tests exercise the
 * full client against `createApi().handle` without opening a socket.
 */

import type { FeatureState } from "@conductor/server"

export type FetchLike = (request: Request) => Promise<Response>

export interface ApiConnection {
  /** Base URL of the daemon API, e.g. `http://127.0.0.1:4400`. Explicit — never defaulted. */
  readonly url: string
  /** Bearer token when the daemon runs `auth.mode: "bearer"`. */
  readonly token?: string
}

/**
 * The API's feature projection: the graph `FeatureState` fields plus a
 * compact `currentStep` (the single running/waiting step across every
 * job, or null when zero or several are active — a DAG feature can have
 * more than one), a per-job status summary and the escalation reason
 * (kept outside the core state shape).
 */
export interface FeatureView extends Omit<FeatureState, "jobs"> {
  readonly currentStep: string | null
  readonly escalation: string | null
  /** The list projection carries `{status, currentStep}` per job; the
   *  detail projection adds full step runtimes (with the rendered gate
   *  `prompt` while a step waits for a human). */
  readonly jobs: Readonly<Record<string, {
    readonly status: string
    readonly currentStep: string | null
    readonly steps?: Readonly<Record<string, { readonly status?: string; readonly prompt?: string }>>
  }>>
}

export class ApiError extends Error {
  constructor(
    /** HTTP status; 0 when the daemon was unreachable. */
    readonly status: number,
    /** Machine-readable code from the error envelope (`unauthorized`, `run_already_concluded`, …). */
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export interface ActiveRun {
  readonly id: string
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly stepType: "agent" | "command"
  readonly attempt: number
  readonly status: "running" | "succeeded" | "failed" | "reaped"
  readonly sessionId: string | null
  readonly outputs: Readonly<Record<string, string>>
  readonly reason: string | null
  readonly nudges: number
  readonly timeStarted: number
  readonly timeFinished: number | null
}

export interface FeaturePayload {
  readonly feature: FeatureView
  readonly activeRun: ActiveRun | null
}

export type RunSummary = ActiveRun
export type RunDetail = ActiveRun

export interface RunLogLine {
  readonly seq: number
  readonly time: number
  readonly source: string
  readonly text: string
}

export interface RunLogPage {
  readonly lines: readonly RunLogLine[]
  readonly nextSeq: number
  readonly truncated: boolean
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

export interface TransitionView {
  readonly event: { readonly kind: string; readonly [key: string]: unknown }
  readonly decisions: readonly { readonly kind: string; readonly [key: string]: unknown }[]
  readonly time: number
}

export interface StartFeatureInput {
  readonly title: string
  readonly project: string
  readonly description?: string
  readonly workflow?: string
  readonly pr?: number
  /** Adopt an existing runner session as the feature's parent session (the seed's "one feature, one session"). */
  readonly sessionId?: string
  /** Values for the selected workflow's declared inputs — resolved and
   *  validated server-side. No `conductor start` flag surfaces this yet;
   *  the wire contract exists so other clients (or a future flag) can. */
  readonly inputs?: Readonly<Record<string, string | number | boolean>>
}

export interface ReportInput {
  readonly outcome?: "succeeded" | "failed"
  readonly verdict?: string
  readonly notes?: string
  readonly ask?: string
}

export interface CommandResult extends FeaturePayload {
  readonly result?: string
}

export interface ReportResult {
  readonly result: string
  readonly run: RunDetail
}

export class ApiClient {
  private readonly base: string

  constructor(
    private readonly connection: ApiConnection,
    private readonly fetchImpl: FetchLike = request => fetch(request),
  ) {
    this.base = connection.url.replace(/\/+$/, "")
  }

  listFeatures(filter?: { project?: string; active?: boolean }): Promise<{ features: FeatureView[] }> {
    const params = new URLSearchParams()
    if (filter?.project !== undefined) params.set("project", filter.project)
    if (filter?.active) params.set("active", "true")
    const query = params.size > 0 ? `?${params.toString()}` : ""
    return this.request("GET", `/v1/features${query}`)
  }

  startFeature(input: StartFeatureInput): Promise<FeaturePayload> {
    return this.request("POST", "/v1/features", input)
  }

  getFeature(featureId: string): Promise<FeaturePayload> {
    return this.request("GET", `/v1/features/${encodeURIComponent(featureId)}`)
  }

  listRuns(featureId: string): Promise<{ runs: RunSummary[] }> {
    return this.request("GET", `/v1/features/${encodeURIComponent(featureId)}/runs`)
  }

  listFindings(featureId: string): Promise<{ findings: FindingView[] }> {
    return this.request("GET", `/v1/features/${encodeURIComponent(featureId)}/findings`)
  }

  timeline(featureId: string): Promise<{ timeline: TransitionView[] }> {
    return this.request("GET", `/v1/features/${encodeURIComponent(featureId)}/timeline`)
  }

  approve(featureId: string, notes?: string): Promise<CommandResult> {
    return this.request("POST", `/v1/features/${encodeURIComponent(featureId)}/approve`, notes !== undefined ? { notes } : {})
  }

  requestChanges(featureId: string, notes: string): Promise<CommandResult> {
    return this.request("POST", `/v1/features/${encodeURIComponent(featureId)}/request-changes`, { notes })
  }

  pause(featureId: string): Promise<FeaturePayload> {
    return this.request("POST", `/v1/features/${encodeURIComponent(featureId)}/pause`, {})
  }

  resume(featureId: string): Promise<FeaturePayload> {
    return this.request("POST", `/v1/features/${encodeURIComponent(featureId)}/resume`, {})
  }

  abandon(featureId: string): Promise<FeaturePayload> {
    return this.request("POST", `/v1/features/${encodeURIComponent(featureId)}/abandon`, {})
  }

  recover(featureId: string, notes: string, options?: { readonly expectedVersion?: number; readonly idempotencyKey?: string }): Promise<CommandResult> {
    return this.request("POST", `/v1/features/${encodeURIComponent(featureId)}/recover`, {
      notes,
      ...(options?.expectedVersion !== undefined ? { expectedVersion: options.expectedVersion } : {}),
      ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    })
  }

  getRun(runId: string): Promise<{ run: RunDetail }> {
    return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}`)
  }

  report(runId: string, input: ReportInput): Promise<ReportResult> {
    return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/report`, input)
  }

  answer(runId: string, notes: string): Promise<ReportResult> {
    return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/answer`, { notes })
  }

  /** Cursor-incremental run-log read. `limit` defaults server-side (500). */
  getRunLogs(runId: string, options: { after?: number; limit?: number } = {}): Promise<RunLogPage> {
    const query = new URLSearchParams()
    if (options.after !== undefined) query.set("after", String(options.after))
    if (options.limit !== undefined) query.set("limit", String(options.limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ""
    return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}/logs${suffix}`)
  }

  appendRunLogs(runId: string, lines: readonly { text: string; source?: "step" | "agent" }[]): Promise<{ appended: number }> {
    return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/logs`, { lines })
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/health")
  }

  registerProject(dir: string): Promise<{ project: string; workflow: string }> {
    return this.request("POST", "/v1/projects", { dir })
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (this.connection.token !== undefined) headers["authorization"] = `Bearer ${this.connection.token}`
    const request = new Request(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let response: Response
    try {
      response = await this.fetchImpl(request)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new ApiError(0, "unreachable", `cannot reach conductor daemon at ${this.base}: ${reason}`, null)
    }
    const requestId = response.headers.get("x-request-id")
    const text = await response.text()
    let parsed: unknown = null
    if (text !== "") {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    if (!response.ok) {
      const envelope =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? (parsed as { error: { code?: unknown; message?: unknown } }).error
          : null
      const code = typeof envelope?.code === "string" ? envelope.code : `http_${response.status}`
      const message = typeof envelope?.message === "string" ? envelope.message : `request failed with status ${response.status}`
      throw new ApiError(response.status, code, message, requestId)
    }
    return parsed as T
  }
}
