/**
 * HTTP API v1 — the daemon's primary control surface (REST + SSE).
 *
 * The API is a thin projection over the extracted `Store`/`Engine`/
 * `Daemon`: every command operation routes through the SAME engine
 * methods (`startFeature`/`report`/`approve`/`requestChanges`/
 * `pause`/`resume`/`abandon`) the CLI, UI and runners use — there is no
 * privileged in-process path and no workflow logic duplicated here.
 * State reads come straight from the store; SSE (`/v1/events`) is an
 * INVALIDATION stream: subscribers get `{kind, featureId}` notifications
 * after a transition/run/finding is durable and refetch authoritative
 * state over REST — the event itself never carries state.
 *
 * Explicit configuration, even for localhost: `bind` (host+port) and
 * `auth` are required fields with no universal defaults. `auth.mode:
 * "none"` is a deliberate choice the operator writes down, not an
 * absence; bearer-token auth guards every route except the liveness/
 * readiness probes.
 *
 * The request handler is a plain `(Request) => Promise<Response>`
 * function so contract tests exercise routing, codes and bodies without
 * a socket; `startApiServer` binds it with `Bun.serve` on the explicit
 * host/port and owns graceful shutdown: `stop()` ends every SSE stream,
 * then closes the listener.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { resolve } from "node:path"
import type { FeatureState, FeatureStatus, InputDef, StepRuntime, WorkflowInputDiagnostic } from "@conductor/core"
import type { RunLogEntryInput, RunSummary, Store, StoreChange } from "./store.ts"
import type { DaemonHealth, DaemonLogger } from "./daemon.ts"
import type { LoadResult, WorkflowResolver, WorkflowStatus } from "./workflow-registry.ts"
import type { RunnerRegistry } from "./runner-registry.ts"
import { proxyPluginRequest } from "./plugin-proxy.ts"
import type { PluginControl } from "./plugin-proxy.ts"
import { pickStaticFile, serveStaticFile } from "./static-files.ts"

// ------------------------------------------------------------ configuration

export type ApiAuth = { readonly mode: "none" } | { readonly mode: "bearer"; readonly token: string }

export interface ApiBind {
  /** Explicit listen host. Never defaulted — loopback is a written-down decision. */
  readonly host: string
  /** Explicit listen port. 0 = ephemeral (tests). */
  readonly port: number
}

export interface ApiConfig {
  readonly bind: ApiBind
  /** Authentication shape — explicit even for localhost. */
  readonly auth: ApiAuth
  /**
   * Opt-in static SPA serving. Absent → the API behaves exactly as
   * without the capability. `staticDir` is always an explicit operator
   * decision — never defaulted from the package location or a home
   * directory. Serving is same-origin by construction, so the API never
   * emits CORS headers.
   */
  readonly ui?: {
    readonly staticDir: string
  }
}

// ------------------------------------------------------------------- deps

/**
 * The engine surface the API commands route through — the same methods
 * every other client uses. `Engine` satisfies this structurally.
 */
export interface EngineControl {
  startFeature(
    projectDir: string,
    input: { title: string; description?: string; workflow?: string; pr?: number; sessionId?: string; inputs?: unknown },
  ): Promise<
    | { readonly ok: true; readonly feature: FeatureState }
    | { readonly ok: false; readonly code: "project_not_configured" | "unknown_workflow"; readonly message: string }
    | {
        readonly ok: false
        readonly code: "invalid_input"
        readonly message: string
        readonly diagnostics: readonly WorkflowInputDiagnostic[]
      }
  >
  report(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string; ask?: string }): Promise<string>
  answer(runId: string, notes: string): Promise<
    | { readonly ok: true; readonly message: string }
    | { readonly ok: false; readonly code: "unknown_run" | "no_pending_question" | "session_lost"; readonly message: string }
  >
  approve(featureId: string, notes?: string): Promise<string>
  requestChanges(featureId: string, notes: string): Promise<string>
  pause(featureId: string): Promise<void>
  resume(featureId: string): Promise<void>
  abandon(featureId: string): Promise<void>
  recover(
    featureId: string,
    input: {
      readonly notes?: string
      readonly expectedVersion?: number
      readonly idempotencyKey?: string
      readonly target?: { readonly jobId: string; readonly stepId: string }
      readonly targets?: readonly { readonly jobId: string; readonly stepId: string }[]
      readonly all?: boolean
    },
  ): Promise<{
    ok: boolean
    message: string
    readonly stale?: boolean
    readonly duplicate?: boolean
    readonly ambiguous?: boolean
    readonly staleTarget?: boolean
    readonly allowAll?: boolean
    readonly targets?: readonly { readonly jobId: string; readonly stepId: string }[]
    readonly recovered?: readonly { readonly jobId: string; readonly stepId: string }[]
  }>
  /** Every currently recoverable job/step target for an escalated
   *  feature, in default-choice order; null when not escalated/no
   *  resolvable workflow. Optional so a caller supplying a partial
   *  structural `EngineControl` (tests) need not implement it — the
   *  projection just omits `recoverableTargets` in that case. */
  recoverableTargets?(featureId: string): readonly { readonly jobId: string; readonly stepId: string }[] | null
}

export interface ApiDeps {
  readonly store: Store
  readonly engine: EngineControl
  readonly health: () => DaemonHealth
  /** Per-project workflow lookup — used to validate feature-start requests. */
  readonly resolveWorkflow: WorkflowResolver
  /**
   * Per-project workflow status (valid/stale/invalid/unregistered plus
   * diagnostics) — backs `/v1/projects/workflow` and the feature detail's
   * `workflowRef` hint. Absent → those projections report null/404.
   */
  readonly workflowStatus?: (projectDir: string) => WorkflowStatus
  /**
   * Runtime project registration (`POST /v1/projects`) — wired to the
   * workflow registry's `register`. Absent → the route 404s.
   */
  readonly registerProject?: (projectDir: string) => LoadResult
  /** Runner endpoint registration (`/v1/runners`). Absent → those routes 404. */
  readonly runners?: RunnerRegistry
  /** Plugin listing + proxy resolution (`/v1/plugins`). Absent → those routes 404. */
  readonly plugins?: PluginControl
  readonly logger?: DaemonLogger
}

// ------------------------------------------------------------------ errors

export type ApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid_json"
  | "invalid_request"
  | "project_not_configured"
  | "unknown_workflow"
  | "invalid_input"
  | "conflict"
  | "stale_version"
  | "run_already_concluded"
  | "no_pending_question"
  | "session_lost"
  | "unavailable"
  | "internal"

interface ErrorBody {
  readonly error: { readonly code: ApiErrorCode; readonly message: string; readonly requestId: string }
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_json: 400,
  invalid_request: 400,
  project_not_configured: 422,
  unknown_workflow: 422,
  invalid_input: 422,
  conflict: 409,
  stale_version: 409,
  run_already_concluded: 409,
  no_pending_question: 409,
  session_lost: 409,
  unavailable: 503,
  internal: 500,
}

// -------------------------------------------------------------------- SSE

interface SseClient {
  readonly id: string
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

// ---------------------------------------------------------------- handler

export type ApiHandler = (request: Request) => Promise<Response>

export interface ConductorApi {
  /** The fetch-style handler — contract-testable without a socket. */
  readonly handle: ApiHandler
  /** Ends every open SSE stream and detaches the store listener. Idempotent. */
  close(): void
  /**
   * Resolves once every handler invocation accepted so far has settled.
   * SSE responses do not count — their handler returns as soon as the
   * stream Response is constructed; `close()` is what ends the streams.
   */
  drain(): Promise<void>
  /** Open SSE subscriber count (observability + shutdown tests). */
  readonly sseClientCount: number
}

const encoder = new TextEncoder()

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

/** currentStep: the single running/waiting step across every job, or null if zero or several are active. */
function currentStepOf(feature: FeatureState): string | null {
  const active: string[] = []
  for (const jobRuntime of Object.values(feature.jobs)) {
    if (jobRuntime.currentStep !== null && (jobRuntime.status === "running")) active.push(jobRuntime.currentStep)
  }
  return active.length === 1 ? active[0]! : null
}

function jobsSummary(feature: FeatureState): Readonly<Record<string, { status: string; currentStep: string | null }>> {
  const summary: Record<string, { status: string; currentStep: string | null }> = {}
  for (const [jobId, jobRuntime] of Object.entries(feature.jobs)) {
    summary[jobId] = { status: jobRuntime.status, currentStep: jobRuntime.currentStep }
  }
  return summary
}

/** Detail-payload bound per step-output value; full output stays one GET /v1/runs/:id away. */
const STEP_OUTPUT_LIMIT = 500

/** Max characters per POSTed log line — well under the store's 2 MB per-run cap. */
const RUN_LOG_LINE_LIMIT = 64 * 1024

/** Name/path of the plugin-namespace session cookie (design D5, plugin-
 *  runtime spec "Cookie unlocks the iframe under bearer auth"): scoped by
 *  `Path` to `/v1/plugins` so it is never sent on any other route. */
const PLUGIN_SESSION_COOKIE = "conductor_plugin_session"
const PLUGIN_SESSION_COOKIE_PATH = "/v1/plugins"
/** Sessions are disposable, like everything else in the plugin runtime —
 *  kept in memory only, never persisted, so a daemon restart invalidates
 *  every issued cookie and the SPA simply re-exchanges. */
const PLUGIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

interface StepDetailProjection {
  readonly status: StepRuntime["status"]
  readonly outputs: Readonly<Record<string, string>>
  readonly truncated?: boolean
  readonly runId?: string
  /** Rendered gate prompt, present untruncated while the step waits for a
   *  human — the approver must see the whole question. */
  readonly prompt?: string
}

/**
 * Full per-job runtime for the DETAIL payload: everything `JobRuntime`
 * carries, with step outputs cut at `STEP_OUTPUT_LIMIT`. A truncated
 * step is marked and points at its newest run so the client can fetch
 * the full output from the runs API.
 */
function jobsDetail(
  feature: FeatureState,
  newestRunByStep: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const detail: Record<string, unknown> = {}
  for (const [jobId, jobRuntime] of Object.entries(feature.jobs)) {
    const steps: Record<string, StepDetailProjection> = {}
    for (const [stepId, stepRuntime] of Object.entries(jobRuntime.steps)) {
      let truncated = false
      const outputs: Record<string, string> = {}
      for (const [name, value] of Object.entries(stepRuntime.outputs)) {
        if (value.length > STEP_OUTPUT_LIMIT) {
          outputs[name] = value.slice(0, STEP_OUTPUT_LIMIT)
          truncated = true
        } else {
          outputs[name] = value
        }
      }
      const runId = newestRunByStep.get(`${jobId}\u0000${stepId}`)
      const gatePrompt = stepRuntime.status === "waiting_human" ? stepRuntime.outputs["prompt"] : undefined
      steps[stepId] = {
        status: stepRuntime.status,
        outputs,
        ...(truncated ? { truncated: true } : {}),
        ...(truncated && runId !== undefined ? { runId } : {}),
        ...(gatePrompt !== undefined ? { prompt: gatePrompt } : {}),
      }
    }
    detail[jobId] = {
      status: jobRuntime.status,
      currentStep: jobRuntime.currentStep,
      attempts: jobRuntime.attempts,
      reruns: jobRuntime.reruns,
      outputs: jobRuntime.outputs,
      steps,
    }
  }
  return detail
}

const FEATURE_STATUSES: readonly FeatureStatus[] = [
  "running",
  "paused",
  "waiting_human",
  "escalated",
  "done",
  "abandoned",
]

function parseStatusFilter(raw: string): FeatureStatus[] | null {
  const statuses: FeatureStatus[] = []
  for (const token of raw.split(",").map(entry => entry.trim()).filter(entry => entry !== "")) {
    if (!(FEATURE_STATUSES as readonly string[]).includes(token)) return null
    statuses.push(token as FeatureStatus)
  }
  return statuses
}

/** Everything the SSE `change` event can carry: store-originated changes
 *  (always feature-scoped) plus the plugin subsystem's own invalidation,
 *  which has no feature to scope to — subscribers refetch the plugin
 *  listing on it exactly as they refetch feature state on a `StoreChange`. */
type SseChangeFrame = StoreChange | { readonly kind: "plugins" }

export function createApi(config: ApiConfig, deps: ApiDeps): ConductorApi {
  const { store, engine, health, resolveWorkflow, workflowStatus, registerProject, runners, plugins, logger } = deps
  const staticRoot = config.ui !== undefined ? resolve(config.ui.staticDir) : null
  const sseClients = new Set<SseClient>()
  const inFlight = new Set<Promise<void>>()
  let closed = false
  /** value → expiry (ms epoch). In-memory only — see `PLUGIN_SESSION_TTL_MS` doc. */
  const pluginSessions = new Map<string, number>()

  const broadcast = (change: SseChangeFrame): void => {
    const frame = encoder.encode(`event: change\ndata: ${JSON.stringify(change)}\n\n`)
    for (const client of [...sseClients]) {
      try {
        client.controller.enqueue(frame)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  const unsubscribe = store.onChange(broadcast)
  const unsubscribePlugins = plugins?.subscribe(() => broadcast({ kind: "plugins" }))

  const error = (requestId: string, code: ApiErrorCode, message: string): Response =>
    json(ERROR_STATUS[code], { error: { code, message, requestId } } satisfies ErrorBody, requestId)

  const json = (status: number, body: unknown, requestId: string): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    })

  const bearerAuthorized = (request: Request): boolean => {
    if (config.auth.mode === "none") return true
    const header = request.headers.get("authorization")
    if (header === null || !header.startsWith("Bearer ")) return false
    const presented = Buffer.from(header.slice("Bearer ".length))
    const expected = Buffer.from(config.auth.token)
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }

  function pruneExpiredPluginSessions(): void {
    const now = Date.now()
    for (const [value, expiresAt] of pluginSessions) {
      if (expiresAt <= now) pluginSessions.delete(value)
    }
  }

  function pluginSessionCookieAuthorized(request: Request): boolean {
    const header = request.headers.get("cookie")
    if (header === null) return false
    for (const part of header.split(";")) {
      const eq = part.indexOf("=")
      if (eq === -1) continue
      if (part.slice(0, eq).trim() !== PLUGIN_SESSION_COOKIE) continue
      const value = part.slice(eq + 1).trim()
      const expiresAt = pluginSessions.get(value)
      if (expiresAt !== undefined && expiresAt > Date.now()) return true
    }
    return false
  }

  /** `/v1/plugins…` requests accept EITHER the bearer header or a valid
   *  plugin-session cookie (plugin-runtime spec: "Cookie unlocks the
   *  iframe under bearer auth") — nothing else on the API does.
   *
   *  `POST /v1/plugins/session` (the exchange itself) is the one
   *  exception: it must NOT accept the cookie it mints, or a client
   *  holding a live cookie could exchange it for a fresh one forever,
   *  defeating `PLUGIN_SESSION_TTL_MS`. It always requires the bearer
   *  header (or `auth.mode: "none"`, where nothing on the API requires
   *  one). Matched by exact path, not prefix, so this carve-out can
   *  never accidentally swallow a real plugin route. */
  const authorized = (request: Request, path: string): boolean => {
    if (config.auth.mode === "none") return true
    if (bearerAuthorized(request)) return true
    if (path === PLUGIN_SESSION_COOKIE_PATH + "/session") return false
    return (path === "/v1/plugins" || path.startsWith("/v1/plugins/")) && pluginSessionCookieAuthorized(request)
  }

  async function readJsonBody(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
    const text = await request.text()
    if (text.trim() === "") return { ok: true, body: {} }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false }
      return { ok: true, body: parsed as Record<string, unknown> }
    } catch {
      return { ok: false }
    }
  }

  function workflowRefOf(projectDir: string): { name: string; stale: boolean } | null {
    const status = workflowStatus?.(projectDir)
    if (status === undefined) return null
    if (status.state !== "valid" && status.state !== "stale") return null
    return { name: status.snapshot.workflow.name, stale: status.state === "stale" }
  }

  function featurePayload(featureId: string): unknown {
    const record = store.getFeatureRecord(featureId)
    if (!record) return null
    const feature = record.state
    const activeRuns = store.listActiveRuns(featureId)
    const openWait = store.listResourceWaits(featureId).find(wait => wait.status !== "closed")
    const openRetry = store.listRetryEpisodes(featureId).find(episode => episode.status !== "closed")
    const activity = openWait
      ? {
          state: "blocked",
          activeCount: activeRuns.length,
          targets: activeRuns.map(run => ({ jobId: run.jobId, stepId: run.stepId })),
          target: { jobId: openWait.jobId, stepId: openWait.stepId },
          reason: openWait.reason,
          diagnostic: openWait.diagnostic,
          nextAt: openWait.nextObservationAt,
          deadlineAt: openWait.deadlineAt,
          message: activeRuns.length === 0 ? "No agent is active — waiting for a runner." : "Waiting for a runner.",
        }
      : openRetry
        ? {
            state: "waiting_retry",
            activeCount: activeRuns.length,
            targets: activeRuns.map(run => ({ jobId: run.jobId, stepId: run.stepId })),
            target: { jobId: openRetry.jobId, stepId: openRetry.stepId },
            reason: openRetry.lastFailure?.class ?? null,
            diagnostic: openRetry.lastFailure?.diagnostic ?? null,
            nextAt: openRetry.nextAttemptAt,
            deadlineAt: openRetry.startedAt + openRetry.maxElapsedMs,
            message: "No agent is active — waiting for the next retry.",
          }
        : {
            state: feature.status === "waiting_human"
              ? "waiting_human"
              : feature.status === "paused"
                ? "paused"
                : feature.status === "escalated"
                  ? "escalated"
                  : feature.status === "done" || feature.status === "abandoned"
                    ? "terminal"
                    : "active",
            activeCount: activeRuns.length,
            targets: activeRuns.map(run => ({ jobId: run.jobId, stepId: run.stepId })),
            target: null,
            reason: null,
            diagnostic: feature.status === "running" && activeRuns.length === 0 ? "No active agent or run is currently recorded." : null,
            nextAt: null,
            deadlineAt: null,
            message: feature.status === "running" && activeRuns.length === 0
              ? "No agent is active — orchestration is between steps or stalled."
              : activeRuns.length > 0
                ? `${activeRuns.length} active run${activeRuns.length === 1 ? "" : "s"}.`
                : feature.status === "escalated"
                  ? "Automation stopped and needs recovery."
                  : `Feature is ${feature.status}.`,
          }
    const recoverableTargets = feature.status === "escalated" ? engine.recoverableTargets?.(featureId) ?? null : null
    return {
      feature: {
        ...feature,
        activity,
        escalation: store.getEscalation(featureId),
        currentStep: currentStepOf(feature),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        workflowRef: workflowRefOf(feature.projectDir),
        feedback: store.getFeedback(featureId),
        findingCounts: store.countFindingsByStatus([featureId]).get(featureId)
          ?? { new: 0, fixed: 0, dismissed: 0, reopened: 0 },
        jobs: jobsDetail(feature, store.newestRunIdsByStep(featureId)),
        ...(recoverableTargets !== null ? { recoverableTargets } : {}),
      },
      activeRun: activeRunProjection(featureId),
      activeRuns: activeRuns.map(run => withAnswerDelivery(run)),
    }
  }

  /** The detail's active run: an asking run wins over merely-newest so the
   *  answering surfaces always see the pending question under fan-out. */
  function activeRunProjection(featureId: string) {
    const asking = store.listActiveRuns(featureId).find((run) => run.pendingQuestion !== null)
    return withAnswerDelivery(asking ?? store.getActiveRun(featureId))
  }

  /**
   * Additive projection (harden-interactive-answer-delivery task 3.1): a
   * run with a non-terminal answer delivery gains `answerDelivery:
   * {status, acceptedAt}` alongside `pendingQuestion` so an answering
   * surface can tell "the question is still visible, but a human answer
   * was already accepted and is pending/claimed for delivery" and
   * disable resubmission without the client having to infer that from
   * the feature staying `waiting_human`. Absent entirely once nothing is
   * open (delivered/failed/cancelled, or never accepted) — existing
   * consumers that only read `pendingQuestion` see no shape change.
   */
  function withAnswerDelivery(run: RunSummary | null): unknown {
    if (run === null) return null
    const delivery = store.getOpenAnswerDelivery(run.id)
    if (delivery === null) return run
    return { ...run, answerDelivery: { status: delivery.status, acceptedAt: delivery.createdAt } }
  }

  async function handle(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? randomUUID()
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const method = request.method.toUpperCase()

    // Tracked so `drain()` can await every accepted handler before the
    // process owner closes SQLite: a request whose socket is torn down
    // by a force-stop still runs its store writes to completion.
    const settled = deferred()
    inFlight.add(settled.promise)
    try {
      const response = await route(request, method, path, url, requestId)
      logger?.log({
        level: "info",
        message: "api request",
        fields: { method, path, status: response.status, requestId },
      })
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger?.log({ level: "error", message: `api request failed: ${message}`, fields: { method, path, requestId } })
      return error(requestId, "internal", "internal server error")
    } finally {
      inFlight.delete(settled.promise)
      settled.resolve()
    }
  }

  async function route(request: Request, method: string, path: string, url: URL, requestId: string): Promise<Response> {
    // Probes stay unauthenticated: a supervisor must be able to check
    // liveness without holding the API token.
    if (method === "GET" && path === "/v1/livez") {
      const snapshot = health()
      return json(snapshot.alive ? 200 : 503, { alive: snapshot.alive, phase: snapshot.phase }, requestId)
    }
    if (method === "GET" && path === "/v1/readyz") {
      const snapshot = health()
      return json(snapshot.ready ? 200 : 503, { ready: snapshot.ready, phase: snapshot.phase }, requestId)
    }

    // Static SPA serving is opt-in, strictly subordinate to /v1 routing
    // and — like the probes — unauthenticated: a browser's top-level
    // navigation and asset fetches cannot attach a bearer header, so the
    // app shell must load without one. The API under /v1 stays guarded.
    if (staticRoot !== null && !path.startsWith("/v1") && (method === "GET" || method === "HEAD")) {
      const served = serveStatic(staticRoot, path, requestId)
      if (served !== null) return served
    }

    if (!authorized(request, path)) return error(requestId, "unauthorized", "missing or invalid bearer token")

    if (method === "GET" && path === "/v1/health") {
      return json(200, health(), requestId)
    }

    if (method === "GET" && path === "/v1/events") {
      if (closed) return error(requestId, "conflict", "server is shutting down")
      return sseResponse(requestId)
    }

    if (path === "/v1/features") {
      if (method === "GET") {
        const project = url.searchParams.get("project") ?? undefined
        const active = url.searchParams.get("active") === "true"
        const statusRaw = url.searchParams.get("status")
        let statuses: FeatureStatus[] | undefined
        if (statusRaw !== null) {
          const parsed = parseStatusFilter(statusRaw)
          if (parsed === null) {
            return error(
              requestId,
              "invalid_request",
              `"status" must be a comma-separated list of: ${FEATURE_STATUSES.join(", ")}`,
            )
          }
          if (parsed.length > 0) statuses = parsed
        }
        const records = store.listFeatureRecords({
          ...(active ? { activeOnly: true } : {}),
          ...(project !== undefined ? { projectDir: project } : {}),
          ...(statuses !== undefined ? { statuses } : {}),
        })
        const findingCounts = store.countFindingsByStatus(records.map(record => record.state.id))
        const zeroCounts = { new: 0, fixed: 0, dismissed: 0, reopened: 0 }
        return json(
          200,
          {
            features: records.map(record => ({
              ...record.state,
              escalation: store.getEscalation(record.state.id),
              currentStep: currentStepOf(record.state),
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              findingCounts: findingCounts.get(record.state.id) ?? zeroCounts,
              jobs: jobsSummary(record.state),
            })),
          },
          requestId,
        )
      }
      if (method === "POST") return createFeature(request, requestId)
      return error(requestId, "not_found", `no route for ${method} ${path}`)
    }

    if (path === "/v1/projects/workflow" && method === "GET") {
      return projectWorkflow(url, requestId)
    }

    if (path === "/v1/projects" && method === "POST" && registerProject !== undefined) {
      const parsed = await readJsonBody(request)
      if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
      const dir = parsed.body["dir"]
      if (typeof dir !== "string" || dir.trim() === "") {
        return error(requestId, "invalid_request", '"dir" is required (project directory path)')
      }
      const result = registerProject(dir)
      if (!result.ok) {
        return json(
          422,
          {
            error: {
              code: "project_not_configured",
              message: `project "${dir}" failed to register`,
              requestId,
            },
            diagnostics: result.diagnostics,
          },
          requestId,
        )
      }
      return json(200, { project: dir, workflow: result.snapshot.workflow.name }, requestId)
    }

    if (path === "/v1/runners" && runners !== undefined) {
      if (method === "GET") {
        // Tokens the daemon uses to call runners back never leave the
        // registry — the listing is projection-only.
        return json(
          200,
          {
            runners: runners.list().map(entry => ({
              id: entry.id,
              name: entry.name,
              endpoint: entry.endpoint,
              projects: entry.projects,
              registeredAt: entry.registeredAt,
            })),
          },
          requestId,
        )
      }
      if (method === "POST") return registerRunner(request, requestId)
      return error(requestId, "not_found", `no route for ${method} ${path}`)
    }

    const runnerMatch = path.match(/^\/v1\/runners\/([^/]+)$/)
    if (runnerMatch && runners !== undefined && method === "DELETE") {
      const runnerId = decodeURIComponent(runnerMatch[1]!)
      if (!runners.deregister(runnerId)) return error(requestId, "not_found", `unknown runner "${runnerId}"`)
      return json(200, { deregistered: runnerId }, requestId)
    }

    const featureMatch = path.match(/^\/v1\/features\/([^/]+)(?:\/([a-z-]+))?$/)
    if (featureMatch) {
      const featureId = decodeURIComponent(featureMatch[1]!)
      const action = featureMatch[2]
      if (action === undefined && method === "GET") {
        const payload = featurePayload(featureId)
        if (!payload) return error(requestId, "not_found", `unknown feature "${featureId}"`)
        return json(200, payload, requestId)
      }
      if (action !== undefined && method === "GET") {
        return featureResource(featureId, action, requestId)
      }
      if (action !== undefined && method === "POST") {
        return featureCommand(request, featureId, action, requestId)
      }
      return error(requestId, "not_found", `no route for ${method} ${path}`)
    }

    const runMatch = path.match(/^\/v1\/runs\/([^/]+)(?:\/(report|logs|answer))?$/)
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]!)
      const action = runMatch[2]
      if (action === undefined && method === "GET") {
        const run = store.getRunById(runId)
        if (!run) return error(requestId, "not_found", `unknown run "${runId}"`)
        return json(200, { run: withAnswerDelivery(run) }, requestId)
      }
      if (action === "report" && method === "POST") return reportRun(request, runId, requestId)
      if (action === "answer" && method === "POST") return answerRun(request, runId, requestId)
      if (action === "logs" && method === "GET") return getRunLogs(url, runId, requestId)
      if (action === "logs" && method === "POST") return appendRunLogs(request, runId, requestId)
      return error(requestId, "not_found", `no route for ${method} ${path}`)
    }

    if (path === "/v1/plugins" && plugins !== undefined && method === "GET") {
      const project = url.searchParams.get("project") ?? undefined
      return json(200, plugins.listing(project), requestId)
    }

    if (path === "/v1/plugins/session" && plugins !== undefined && method === "POST") {
      return pluginSessionExchange(requestId)
    }

    const pluginMatch = path.match(/^\/v1\/plugins\/([^/]+)(\/.*)?$/)
    if (pluginMatch && plugins !== undefined) {
      const pluginId = decodeURIComponent(pluginMatch[1]!)
      const restPath = pluginMatch[2] ?? ""
      const project = url.searchParams.get("project") ?? undefined
      const resolved = plugins.resolve(pluginId, project)
      if (!resolved.ok) return error(requestId, "not_found", `unknown plugin "${pluginId}"`)
      const result = await proxyPluginRequest(resolved.target, restPath, request, requestId)
      if (result.kind === "not_found") return error(requestId, "not_found", `no route for ${method} ${path}`)
      if (result.kind === "unavailable") return error(requestId, "unavailable", result.message)
      return result.response
    }

    return error(requestId, "not_found", `no route for ${method} ${path}`)
  }

  function projectWorkflow(url: URL, requestId: string): Response {
    const dir = url.searchParams.get("dir")
    if (dir === null || dir.trim() === "") {
      return error(requestId, "invalid_request", "\"dir\" (project directory) query parameter is required")
    }
    if (workflowStatus === undefined) {
      return error(requestId, "not_found", `no workflow registered for "${dir}"`)
    }
    const status = workflowStatus(dir)
    if (status.state === "unregistered") {
      return error(requestId, "not_found", `no workflow registered for "${dir}"`)
    }
    if (status.state === "invalid") {
      // `safeMessage`, never `message` — same boundary rule as the
      // stale-diagnostics projection below: this route is browser-facing
      // and must never embed an action manifest's `sourcePath` or the
      // daemon's configured action registry search paths.
      const detail = status.diagnostics.map(diagnostic => diagnostic.safeMessage).join("; ")
      return error(requestId, "conflict", `workflow for "${dir}" is invalid: ${detail}`)
    }
    // Structure only — job edges, step ids/kinds and safe input
    // definitions. Prompts, expressions, role/model bindings, `with:`
    // payloads and retry policies never leave the daemon through this
    // route. Input defaults ARE exposed: they are user-facing start
    // values, not execution secrets.
    const workflow = status.snapshot.workflow
    const jobs: Record<string, { needs: readonly string[]; steps: Array<{ id: string; kind: string; interactive?: boolean }> }> = {}
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      jobs[jobId] = {
        needs: job.needs,
        steps: job.steps.map(step => ({
          id: step.id,
          kind: step.type,
          ...(step.type === "agent" && step.interactive === true ? { interactive: true } : {}),
        })),
      }
    }
    // `Object.fromEntries`, not `inputs[name] = def` — an input literally
    // named `__proto__` is a legal JSON key and must survive as a genuine
    // own property rather than reassigning `Object.prototype`'s accessor.
    const inputs: Record<string, InputDef> = Object.fromEntries(Object.entries(workflow.inputs))
    // Diagnostics project to `safeMessage`, never `message` —
    // `WorkflowDiagnostic.sourcePath` is an absolute on-daemon
    // filesystem path (this route's stale-only diagnostics come from a
    // reload failure) and, for an action-resolution failure, `message`
    // can additionally embed a resolved action manifest's `sourcePath`
    // and the daemon's configured action registry search paths —
    // `safeMessage` is the principled, structure-derived projection that
    // strips exactly those two path sources while keeping every other
    // diagnostic (parse errors, structural validation, missing file)
    // byte-identical, since those never carried a path beyond
    // `sourcePath` itself. This route is structure-only by design; the
    // browser never needs, and must never see, the daemon's local layout.
    return json(
      200,
      {
        name: workflow.name,
        stale: status.state === "stale",
        jobs,
        inputs,
        diagnostics: status.state === "stale" ? status.diagnostics.map(diagnostic => diagnostic.safeMessage) : [],
      },
      requestId,
    )
  }

  function serveStatic(root: string, path: string, requestId: string): Response | null {
    const served = serveStaticFile(root, path, requestId)
    if (served !== null) return served
    const fallback = pickStaticFile(resolve(root, "index.html"))
    if (fallback !== null) {
      return new Response(Bun.file(fallback), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "x-request-id": requestId },
      })
    }
    return null
  }

  /**
   * `POST /v1/plugins/session` mints an opaque cookie value scoped to
   * `/v1/plugins` (design D5). Reached only once already bearer-
   * authorized (or under `auth.mode: "none"`, where it is harmless — the
   * cookie is set but never needed). No `Secure` attribute: the daemon
   * has no TLS config to detect an https origin from (`ApiConfig` binds
   * plain HTTP), and the deployment this protects is loopback/LAN, not a
   * public origin — the honest v1 posture, not an oversight.
   */
  function pluginSessionExchange(requestId: string): Response {
    pruneExpiredPluginSessions()
    const value = randomBytes(32).toString("hex")
    pluginSessions.set(value, Date.now() + PLUGIN_SESSION_TTL_MS)
    const cookie = `${PLUGIN_SESSION_COOKIE}=${value}; Path=${PLUGIN_SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(PLUGIN_SESSION_TTL_MS / 1000)}`
    return new Response(null, { status: 204, headers: { "set-cookie": cookie, "x-request-id": requestId } })
  }

  async function registerRunner(request: Request, requestId: string): Promise<Response> {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const { name, endpoint, token, projects } = parsed.body
    if (typeof name !== "string" || name.trim() === "") {
      return error(requestId, "invalid_request", "\"name\" (non-empty string) is required")
    }
    if (typeof endpoint !== "string" || endpoint.trim() === "") {
      return error(requestId, "invalid_request", "\"endpoint\" (URL) is required")
    }
    if (token !== undefined && typeof token !== "string") {
      return error(requestId, "invalid_request", "\"token\" must be a string")
    }
    if (!Array.isArray(projects) || projects.some(entry => typeof entry !== "string" || entry.trim() === "")) {
      return error(requestId, "invalid_request", "\"projects\" must be an array of non-empty strings")
    }
    let registration
    try {
      registration = runners!.register({
        name,
        endpoint,
        ...(token !== undefined ? { token } : {}),
        projects: projects as string[],
      })
    } catch (err) {
      return error(requestId, "invalid_request", err instanceof Error ? err.message : String(err))
    }
    return json(
      201,
      {
        runner: {
          id: registration.id,
          name: registration.name,
          endpoint: registration.endpoint,
          projects: registration.projects,
          registeredAt: registration.registeredAt,
        },
      },
      requestId,
    )
  }

  async function createFeature(request: Request, requestId: string): Promise<Response> {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const { title, project, description, workflow, pr, sessionId, inputs } = parsed.body
    if (typeof title !== "string" || title.trim() === "") {
      return error(requestId, "invalid_request", "\"title\" (non-empty string) is required")
    }
    if (typeof project !== "string" || project.trim() === "") {
      return error(requestId, "invalid_request", "\"project\" (project directory) is required")
    }
    if (description !== undefined && typeof description !== "string") {
      return error(requestId, "invalid_request", "\"description\" must be a string")
    }
    if (workflow !== undefined && typeof workflow !== "string") {
      return error(requestId, "invalid_request", "\"workflow\" must be a string")
    }
    if (pr !== undefined && (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0)) {
      return error(requestId, "invalid_request", "\"pr\" must be a positive integer")
    }
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim() === "")) {
      return error(requestId, "invalid_request", "\"sessionId\" must be a non-empty string")
    }
    if (resolveWorkflow(project) === null) {
      return error(requestId, "project_not_configured", `no valid conductor.yaml registered for "${project}"`)
    }
    const result = await engine.startFeature(project, {
      title,
      ...(description !== undefined ? { description } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
      ...(pr !== undefined ? { pr } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
    })
    if (!result.ok) {
      if (result.code === "invalid_input") {
        return json(
          422,
          { error: { code: result.code, message: result.message, requestId }, diagnostics: result.diagnostics },
          requestId,
        )
      }
      return error(requestId, result.code, result.message)
    }
    return json(201, featurePayload(result.feature.id), requestId)
  }

  function featureResource(featureId: string, resource: string, requestId: string): Response {
    const feature = store.getFeature(featureId)
    if (!feature) return error(requestId, "not_found", `unknown feature "${featureId}"`)
    switch (resource) {
      case "runs":
        return json(200, { runs: store.listRuns(featureId).map(run => withAnswerDelivery(run)) }, requestId)
      case "findings":
        return json(200, { findings: store.listFindings(featureId) }, requestId)
      case "timeline":
        return json(200, { timeline: store.getTransitions(featureId) }, requestId)
      default:
        return error(requestId, "not_found", `no route for GET /v1/features/:id/${resource}`)
    }
  }

  async function featureCommand(request: Request, featureId: string, action: string, requestId: string): Promise<Response> {
    const feature = store.getFeature(featureId)
    if (!feature) return error(requestId, "not_found", `unknown feature "${featureId}"`)
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const notes = parsed.body.notes
    if (notes !== undefined && typeof notes !== "string") {
      return error(requestId, "invalid_request", "\"notes\" must be a string")
    }

    // The pre-checks below read a snapshot taken before the body await;
    // gate commands therefore ALSO re-validate the engine's structured
    // result prefix after the call — the engine's own atomic re-check is
    // the authority, and a racing loser maps to the same 409.
    switch (action) {
      case "approve": {
        if (feature.status !== "waiting_human") {
          return error(requestId, "conflict", `feature is not waiting for approval (status: ${feature.status})`)
        }
        const result = await engine.approve(featureId, notes)
        if (!result.startsWith("Approved")) {
          return error(requestId, "conflict", result)
        }
        return json(200, { result, ...(featurePayload(featureId) as Record<string, unknown>) }, requestId)
      }
      case "request-changes": {
        if (feature.status !== "waiting_human") {
          return error(requestId, "conflict", `feature is not waiting for approval (status: ${feature.status})`)
        }
        if (notes === undefined || notes.trim() === "") {
          return error(requestId, "invalid_request", "\"notes\" (non-empty string) is required for request-changes")
        }
        const result = await engine.requestChanges(featureId, notes)
        if (!result.startsWith("Changes requested")) {
          return error(requestId, "conflict", result)
        }
        return json(200, { result, ...(featurePayload(featureId) as Record<string, unknown>) }, requestId)
      }
      // `human.paused`/`human.abandoned` are unconditional in the
      // interpreter (seed semantics, preserved). The API guards terminal
      // features here: pausing a `done` feature would flip it back into
      // an ACTIVE status, and a later resume would restart the DAG.
      case "pause":
      case "abandon": {
        if (feature.status === "done" || feature.status === "abandoned") {
          return error(requestId, "conflict", `feature is already ${feature.status}`)
        }
        if (action === "pause") await engine.pause(featureId)
        else await engine.abandon(featureId)
        return json(200, featurePayload(featureId), requestId)
      }
      case "resume":
        await engine.resume(featureId)
        return json(200, featurePayload(featureId), requestId)
      case "recover": {
        if (feature.status !== "escalated") {
          return error(requestId, "conflict", `feature is not escalated (status: ${feature.status}) — recover only applies to escalated features`)
        }
        if (notes === undefined || notes.trim() === "") {
          return error(requestId, "invalid_request", "\"notes\" (non-empty string) is required for recover")
        }
        const expectedVersion = parsed.body["expectedVersion"]
        if (expectedVersion !== undefined && typeof expectedVersion !== "number") {
          return error(requestId, "invalid_request", "\"expectedVersion\" must be a number (the feature's updatedAt your view was rendered from)")
        }
        const idempotencyKey = parsed.body["idempotencyKey"]
        if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "")) {
          return error(requestId, "invalid_request", "\"idempotencyKey\" must be a non-empty string")
        }
        const parseTarget = (raw: unknown, label: string): { jobId: string; stepId: string } | string => {
          const candidate = raw as Record<string, unknown>
          const jobId = typeof candidate === "object" && candidate !== null ? candidate["jobId"] : undefined
          const stepId = typeof candidate === "object" && candidate !== null ? candidate["stepId"] : undefined
          if (typeof jobId !== "string" || jobId.trim() === "" || typeof stepId !== "string" || stepId.trim() === "") {
            return `${label} must be an object with non-empty string "jobId" and "stepId"`
          }
          return { jobId, stepId }
        }
        const rawTarget = parsed.body["target"]
        let target: { jobId: string; stepId: string } | undefined
        if (rawTarget !== undefined) {
          const parsedTarget = parseTarget(rawTarget, "\"target\"")
          if (typeof parsedTarget === "string") return error(requestId, "invalid_request", parsedTarget)
          target = parsedTarget
        }
        const rawTargets = parsed.body["targets"]
        let targets: { jobId: string; stepId: string }[] | undefined
        if (rawTargets !== undefined) {
          if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
            return error(requestId, "invalid_request", "\"targets\" must be a non-empty array of {jobId, stepId} objects")
          }
          targets = []
          for (const entry of rawTargets) {
            const parsedEntry = parseTarget(entry, "every \"targets\" entry")
            if (typeof parsedEntry === "string") return error(requestId, "invalid_request", parsedEntry)
            targets.push(parsedEntry)
          }
        }
        const rawAll = parsed.body["all"]
        if (rawAll !== undefined && typeof rawAll !== "boolean") {
          return error(requestId, "invalid_request", "\"all\" must be a boolean")
        }
        const all = rawAll === true
        if ([target !== undefined, targets !== undefined, all].filter(Boolean).length > 1) {
          return error(requestId, "invalid_request", "pass exactly one of \"target\", \"targets\", or \"all\" — they cannot be combined")
        }
        const result = await engine.recover(featureId, {
          notes,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(targets !== undefined ? { targets } : {}),
          ...(all ? { all } : {}),
        })
        if (!result.ok) {
          if (result.ambiguous === true) {
            return json(
              409,
              {
                error: { code: "ambiguous_target", message: result.message, requestId },
                targets: result.targets ?? [],
                ...(result.allowAll === true ? { allowAll: true } : {}),
              },
              requestId,
            )
          }
          if (result.staleTarget === true) {
            return json(409, { error: { code: "stale_target", message: result.message, requestId } }, requestId)
          }
          return error(requestId, result.stale === true ? "stale_version" : "conflict", result.message)
        }
        return json(
          200,
          {
            result: result.message,
            ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
            ...(featurePayload(featureId) as Record<string, unknown>),
          },
          requestId,
        )
      }
      default:
        return error(requestId, "not_found", `no route for POST /v1/features/:id/${action}`)
    }
  }

  function getRunLogs(url: URL, runId: string, requestId: string): Response {
    if (!store.getRunById(runId)) return error(requestId, "not_found", `unknown run "${runId}"`)
    const DEFAULT_LIMIT = 500
    const MAX_LIMIT = 2000
    let limit = DEFAULT_LIMIT
    let afterSeq = 0
    const rawLimit = url.searchParams.get("limit")
    if (rawLimit !== null) {
      const parsed = Number(rawLimit)
      if (!Number.isInteger(parsed) || parsed < 1) {
        return error(requestId, "invalid_request", "\"limit\" must be a positive integer")
      }
      limit = Math.min(parsed, MAX_LIMIT)
    }
    const rawAfter = url.searchParams.get("after")
    if (rawAfter !== null) {
      const parsed = Number(rawAfter)
      if (!Number.isInteger(parsed) || parsed < 0) {
        return error(requestId, "invalid_request", "\"after\" must be a non-negative integer sequence number")
      }
      afterSeq = parsed
    }
    return json(200, store.getRunLog(runId, { afterSeq, limit }), requestId)
  }

  async function appendRunLogs(request: Request, runId: string, requestId: string): Promise<Response> {
    const run = store.getRunById(runId)
    if (!run) return error(requestId, "not_found", `unknown run "${runId}"`)
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const { lines } = parsed.body
    if (!Array.isArray(lines) || lines.length === 0) {
      return error(requestId, "invalid_request", "\"lines\" must be a non-empty array")
    }
    if (lines.length > 2000) {
      return error(requestId, "invalid_request", "\"lines\" must contain at most 2000 entries")
    }
    const entries: RunLogEntryInput[] = []
    for (const line of lines) {
      if (typeof line !== "object" || line === null || Array.isArray(line)) {
        return error(requestId, "invalid_request", "each line must be an object with \"text\"")
      }
      const record = line as Record<string, unknown>
      if (typeof record.text !== "string" || record.text === "") {
        return error(requestId, "invalid_request", "each line's \"text\" must be a non-empty string")
      }
      // Bounded per line so a single entry can never blow through the
      // per-run storage cap (and silently erase the log it lands in).
      if (record.text.length > RUN_LOG_LINE_LIMIT) {
        return error(requestId, "invalid_request", `each line's "text" must be at most ${RUN_LOG_LINE_LIMIT} characters`)
      }
      const source = record.source ?? "step"
      if (source !== "step" && source !== "agent" && source !== "tool") {
        return error(requestId, "invalid_request", "\"source\" must be \"step\", \"agent\" or \"tool\"")
      }
      entries.push({ source, text: record.text })
    }
    // The pre-check projects a friendly 409 from the pre-await snapshot;
    // the store's requireRunning guard is the atomic authority — a run
    // concluded by a concurrent report while this request's body was
    // still being read yields null here and maps to the same 409.
    if (run.status !== "running") {
      return error(requestId, "run_already_concluded", `run ${runId} already concluded (${run.status})`)
    }
    const appended = store.appendRunLog(runId, entries, { requireRunning: true })
    if (appended === null) {
      const after = store.getRunById(runId)
      return error(requestId, "run_already_concluded", `run ${runId} already concluded (${after?.status ?? "unknown"})`)
    }
    return json(201, { appended: entries.length }, requestId)
  }

  async function reportRun(request: Request, runId: string, requestId: string): Promise<Response> {
    const run = store.getRunById(runId)
    if (!run) return error(requestId, "not_found", `unknown run "${runId}"`)
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const { outcome, verdict, notes, ask } = parsed.body
    if (outcome !== undefined && outcome !== "succeeded" && outcome !== "failed") {
      return error(requestId, "invalid_request", "\"outcome\" must be \"succeeded\" or \"failed\"")
    }
    if (verdict !== undefined && (typeof verdict !== "string" || verdict.trim() === "")) {
      return error(requestId, "invalid_request", "\"verdict\" must be a non-empty string")
    }
    if (notes !== undefined && typeof notes !== "string") {
      return error(requestId, "invalid_request", "\"notes\" must be a string")
    }
    if (ask !== undefined && (typeof ask !== "string" || ask.trim() === "")) {
      return error(requestId, "invalid_request", "\"ask\" must be a non-empty string")
    }
    const shapes = [outcome !== undefined, verdict !== undefined, ask !== undefined].filter(Boolean).length
    if (shapes === 0) {
      return error(requestId, "invalid_request", "one of \"outcome\", \"verdict\" or \"ask\" is required")
    }
    if (ask !== undefined && shapes > 1) {
      return error(requestId, "invalid_request", "\"ask\" cannot be combined with \"outcome\" or \"verdict\"")
    }
    // outcome:"succeeded" + verdict is redundant, not contradictory —
    // agents naturally send both and the verdict routes. Only a failed
    // outcome contradicts a verdict (a verdict concludes successfully).
    if (outcome === "failed" && verdict !== undefined) {
      return error(requestId, "invalid_request", "\"outcome\": \"failed\" and \"verdict\" are contradictory — a verdict implies successful completion")
    }
    // Duplicate reports are rejected idempotently: the engine's atomic
    // conclusion claim is the authority; this pre-check only projects the
    // already-concluded state onto a 409 without touching the engine.
    if (run.status !== "running") {
      return error(requestId, "run_already_concluded", `run ${runId} already concluded (${run.status})`)
    }
    const result = await engine.report({
      runId,
      ...(outcome !== undefined ? { outcome } : {}),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(ask !== undefined ? { ask } : {}),
    })
    // A concurrent report can still win the engine's atomic claim between
    // the pre-check and this call — the loser maps to the same 409. The
    // duplicate message is matched by its exact prefix (`Run <uuid>
    // already concluded`): success messages start with `Verdict "` /
    // `Step "`, so caller-controlled verdict/notes text can never spoof
    // the duplicate shape from inside a success message.
    if (result.startsWith(`Run ${runId} already concluded`)) {
      return error(requestId, "run_already_concluded", result)
    }
    return json(200, { result, run: withAnswerDelivery(store.getRunById(runId)) }, requestId)
  }

  async function answerRun(request: Request, runId: string, requestId: string): Promise<Response> {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const notes = parsed.body.notes
    if (typeof notes !== "string" || notes.trim() === "") {
      return error(requestId, "invalid_request", "\"notes\" is required and must be a non-empty string")
    }
    const result = await engine.answer(runId, notes)
    if (!result.ok) {
      if (result.code === "unknown_run") return error(requestId, "not_found", result.message)
      return error(requestId, result.code, result.message)
    }
    // `result.ok` covers three outcomes with the SAME wire shape (unchanged
    // contract): confirmed delivery (no open delivery left — the run
    // carries only `pendingQuestion: null`), and accepted-but-not-yet-
    // delivered (paused, or delivery still in flight) — the latter is
    // where `withAnswerDelivery` adds the additive `answerDelivery` field
    // so the caller can distinguish "accepted, delivering" from "resolved".
    return json(200, { result: result.message, run: withAnswerDelivery(store.getRunById(runId)) }, requestId)
  }

  function sseResponse(requestId: string): Response {
    const client: { current: SseClient | null } = { current: null }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const entry: SseClient = { id: randomUUID(), controller }
        client.current = entry
        sseClients.add(entry)
        controller.enqueue(encoder.encode(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ requestId })}\n\n`))
      },
      cancel() {
        if (client.current) sseClients.delete(client.current)
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": requestId,
      },
    })
  }

  function close(): void {
    if (closed) return
    closed = true
    unsubscribe()
    unsubscribePlugins?.()
    for (const client of [...sseClients]) {
      try {
        client.controller.close()
      } catch {
        // already closed by the client
      }
    }
    sseClients.clear()
  }

  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight])
    }
  }

  return {
    handle,
    close,
    drain,
    get sseClientCount() {
      return sseClients.size
    },
  }
}

// ---------------------------------------------------------------- server

export interface ApiServer {
  readonly hostname: string
  readonly port: number
  /** Ends SSE streams, then closes the listener. Idempotent. */
  stop(): Promise<void>
}

/**
 * Bind the API on the EXPLICIT host/port from `config.bind`. Graceful
 * shutdown order: end SSE streams first (so no response is left
 * hanging), force-close the listener, then drain in-flight handlers.
 * Force, not graceful: a graceful `server.stop()` keeps existing
 * keep-alive connections open and a pooled client can still push NEW
 * requests through them after "stop" — exactly the "accepting new work
 * while SQLite is closing" window shutdown must close. Force-close can
 * tear down a socket whose request was legitimately mid-handler; the
 * drain is what upholds the spec's "finishes persistence already in
 * progress": every accepted handler runs its store writes to completion
 * before `stop()` resolves, so the process owner's `Daemon.stop()`
 * never closes SQLite under an in-flight request. The client whose
 * socket was cut may not receive the response, but the write is durable
 * and a retry is rejected idempotently.
 */
export function startApiServer(config: ApiConfig, deps: ApiDeps): ApiServer {
  const api = createApi(config, deps)
  const server = Bun.serve({
    hostname: config.bind.host,
    port: config.bind.port,
    idleTimeout: 0,
    fetch: api.handle,
  })
  const hostname = server.hostname ?? config.bind.host
  const port = server.port ?? config.bind.port
  deps.logger?.log({
    level: "info",
    message: "api listening",
    fields: { host: hostname, port, auth: config.auth.mode },
  })
  let stopPromise: Promise<void> | null = null
  return {
    hostname,
    port,
    stop() {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        api.close()
        await server.stop(true)
        await api.drain()
        deps.logger?.log({ level: "info", message: "api stopped" })
      })()
      return stopPromise
    },
  }
}
