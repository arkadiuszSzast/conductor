/**
 * Hand-rolled API client for the daemon's HTTP API v1.
 *
 * Wraps `fetch` with the shared conventions of `docs/http-api.md`:
 * a relative `/v1` base (same-origin in production, proxied in dev), the
 * bearer header injected on every request, and the error envelope
 * `{error: {code, message, requestId}}` mapped to a typed `ApiError`.
 * A `401` at any point fires the `onUnauthorized` callback so the auth
 * gate can take the app back to the token screen.
 */

import type {
  ChangeEvent,
  CommandResponse,
  DaemonHealth,
  FeatureDetailResponse,
  FeatureListItem,
  FindingView,
  RunLogPage,
  RunSummary,
  TransitionEntry,
  WorkflowProjection,
} from "./types.ts"

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export interface ApiClientInput {
  /** Current bearer token, or null when auth is not configured. */
  readonly token: () => string | null
  /** Fired on any 401 so the auth gate can reset the app. */
  readonly onUnauthorized?: () => void
  /** Transport for tests; defaults to globalThis.fetch. */
  readonly fetch?: FetchLike
  /** Clock for tests; defaults to Date.now. */
  readonly now?: () => number
}

/** Minimal fetch shape — keeps tests free of Bun's extended fetch type. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class ApiClient {
  private readonly token: () => string | null
  readonly onUnauthorized: (() => void) | undefined
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  /** Current bearer token (or null when auth is not configured). */
  getToken(): string | null {
    return this.token()
  }

  constructor(input: ApiClientInput) {
    this.token = input.token
    this.onUnauthorized = input.onUnauthorized
    this.fetchImpl = input.fetch ?? ((...args: Parameters<FetchLike>) => fetch(...args))
    this.now = input.now ?? (() => Date.now())
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.token()
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
      "x-request-id": `web-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    }
    if (token !== null) headers["authorization"] = `Bearer ${token}`
    const response = await this.fetchImpl(path, { ...init, headers })
    if (!response.ok) throw await toApiError(response)
    return (await response.json()) as T
  }

  async listFeatures(status?: readonly FeatureListItem["status"][]): Promise<FeatureListItem[]> {
    const query = status !== undefined && status.length > 0 ? `?status=${status.join(",")}` : ""
    const body = await this.request<{ features: FeatureListItem[] }>(`/v1/features${query}`)
    return body.features
  }

  async featureDetail(featureId: string): Promise<FeatureDetailResponse> {
    return this.request<FeatureDetailResponse>(`/v1/features/${encodeURIComponent(featureId)}`)
  }

  async runs(featureId: string): Promise<RunSummary[]> {
    const body = await this.request<{ runs: RunSummary[] }>(`/v1/features/${encodeURIComponent(featureId)}/runs`)
    return body.runs
  }

  async findings(featureId: string): Promise<FindingView[]> {
    const body = await this.request<{ findings: FindingView[] }>(`/v1/features/${encodeURIComponent(featureId)}/findings`)
    return body.findings
  }

  async timeline(featureId: string): Promise<TransitionEntry[]> {
    const body = await this.request<{ timeline: TransitionEntry[] }>(`/v1/features/${encodeURIComponent(featureId)}/timeline`)
    return body.timeline
  }

  async workflow(projectDir: string): Promise<WorkflowProjection> {
    return this.request<WorkflowProjection>(`/v1/projects/workflow?dir=${encodeURIComponent(projectDir)}`)
  }

  /** The workflow endpoint's 404/409 are NOT errors in the UI sense —
   *  they are "no workflow registered"/"workflow invalid" states with
   *  diagnostics. Returns them as a tagged result instead of throwing. */
  async workflowState(projectDir: string): Promise<
    { readonly ok: true; readonly workflow: WorkflowProjection } | { readonly ok: false; readonly state: "unregistered" | "invalid"; readonly message: string }
  > {
    try {
      const workflow = await this.workflow(projectDir)
      return { ok: true, workflow }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return { ok: false, state: "unregistered", message: err.message }
      }
      if (err instanceof ApiError && err.status === 409) {
        return { ok: false, state: "invalid", message: err.message }
      }
      throw err
    }
  }

  async fullRun(runId: string): Promise<RunSummary> {
    const body = await this.request<{ run: RunSummary }>(`/v1/runs/${encodeURIComponent(runId)}`)
    return body.run
  }

  async runLogs(runId: string, after = 0, limit = 500): Promise<RunLogPage> {
    return this.request<RunLogPage>(`/v1/runs/${encodeURIComponent(runId)}/logs?after=${after}&limit=${limit}`)
  }

  async health(): Promise<DaemonHealth> {
    return this.request<DaemonHealth>("/v1/health")
  }

  async approve(featureId: string, notes?: string): Promise<CommandResponse> {
    return this.request<CommandResponse>(`/v1/features/${encodeURIComponent(featureId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notes !== undefined ? { notes } : {}),
    })
  }

  async answerRun(runId: string, notes: string): Promise<CommandResponse> {
    return this.request<CommandResponse>(`/v1/runs/${encodeURIComponent(runId)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    })
  }

  async requestChanges(featureId: string, notes: string): Promise<CommandResponse> {
    return this.request<CommandResponse>(`/v1/features/${encodeURIComponent(featureId)}/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    })
  }

  async pause(featureId: string): Promise<FeatureDetailResponse> {
    return this.request<FeatureDetailResponse>(`/v1/features/${encodeURIComponent(featureId)}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  }

  async resume(featureId: string): Promise<FeatureDetailResponse> {
    return this.request<FeatureDetailResponse>(`/v1/features/${encodeURIComponent(featureId)}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  }

  async abandon(featureId: string): Promise<FeatureDetailResponse> {
    return this.request<FeatureDetailResponse>(`/v1/features/${encodeURIComponent(featureId)}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  }

  async recover(featureId: string, notes: string): Promise<CommandResponse> {
    return this.request<CommandResponse>(`/v1/features/${encodeURIComponent(featureId)}/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    })
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    body = undefined
  }
  const code = body?.error.code ?? "internal"
  const message = body?.error.message ?? `request failed with status ${response.status}`
  const requestId = body?.error.requestId ?? response.headers.get("x-request-id")
  return new ApiError(response.status, code, message, requestId)
}

/** The frames a fetch-based SSE reader surfaces. */
export type SseFrame = { readonly type: "hello"; readonly requestId: string } | { readonly type: "change"; readonly change: ChangeEvent }

/** Human-readable failure kinds from the stream transport. */
export type SseDropReason = "aborted" | "http-error" | "network-error" | "closed"

/**
 * Fetch-based SSE reader — the native `EventSource` cannot attach an
 * `Authorization` header, so this reads the stream manually and parses
 * the `event:`/`data:`/`retry:` frames. Honors `retry:` as the reconnect
 * delay. The returned stop function closes the stream; the stream ends by
 * resolving (clean close) or rejecting (transport failure).
 */
export interface SseReaderInput {
  readonly url: string
  readonly token: () => string | null
  readonly fetch?: FetchLike
  readonly onFrame: (frame: SseFrame) => void
  readonly onRetryDelay?: (ms: number) => void
}

export async function readSseStream(input: SseReaderInput): Promise<void> {
  const { url, token, onFrame, onRetryDelay } = input
  const fetchImpl = input.fetch ?? globalThis.fetch
  const tokenValue = token()
  const headers: Record<string, string> = {}
  if (tokenValue !== null) headers["authorization"] = `Bearer ${tokenValue}`
  const response = await fetchImpl(url, { headers })
  if (response.status !== 200) throw new SseHttpError(response.status)
  if (response.body === null) throw new SseDropError("network-error", "no response body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  function dispatch(frames: string[]): void {
    for (const raw of frames) {
      if (raw.trim() === "") continue
      const eventLines: string[] = []
      let eventName = "message"
      let retryMs: number | null = null
      const dataLines: string[] = []
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue
        if (line.startsWith("event:")) eventName = line.slice(6).trim()
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
        else if (line.startsWith("retry:")) {
          const parsed = Number(line.slice(6).trim())
          if (Number.isFinite(parsed) && parsed >= 0) retryMs = parsed
        } else if (line.startsWith("id:")) eventLines.push(line.slice(3).trim())
        else if (line.trim() !== "") eventLines.push(line)
      }
      if (retryMs !== null) onRetryDelay?.(retryMs)
      const data = dataLines.join("\n")
      if (eventName === "change") {
        try {
          const change = JSON.parse(data) as ChangeEvent
          if (
            (change as { kind?: unknown }).kind !== undefined &&
            typeof (change as { featureId?: unknown }).featureId === "string"
          ) {
            onFrame({ type: "change", change })
          }
        } catch {
          // malformed invalidation frame — ignore, the stream carries no state
        }
      } else if (eventName === "hello") {
        let requestId = ""
        try {
          requestId = (JSON.parse(data) as { requestId?: unknown }).requestId as string
        } catch {
          requestId = ""
        }
        onFrame({ type: "hello", requestId })
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      const remainder = buffer.split("\n\n")
      dispatch(remainder.slice(0, -1))
      throw new SseDropError("closed", "stream closed by server")
    }
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""
    dispatch(frames)
  }
}

export class SseHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`SSE stream returned HTTP ${status}`)
    this.name = "SseHttpError"
    this.status = status
  }
}

export class SseDropError extends Error {
  readonly reason: SseDropReason
  constructor(reason: SseDropReason, message: string) {
    super(message)
    this.name = "SseDropError"
    this.reason = reason
  }
}
