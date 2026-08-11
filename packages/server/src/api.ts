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

import { randomUUID, timingSafeEqual } from "node:crypto"
import { statSync } from "node:fs"
import { extname, resolve, sep } from "node:path"
import type { FeatureState, FeatureStatus, StepRuntime } from "@conductor/core"
import type { RunSummary, Store, StoreChange } from "./store.ts"
import type { DaemonHealth, DaemonLogger } from "./daemon.ts"
import type { WorkflowResolver, WorkflowStatus } from "./workflow-registry.ts"
import type { RunnerRegistry } from "./runner-registry.ts"

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
    input: { title: string; description?: string; workflow?: string; pr?: number; sessionId?: string },
  ): Promise<
    | { readonly ok: true; readonly feature: FeatureState }
    | { readonly ok: false; readonly code: "project_not_configured" | "unknown_workflow"; readonly message: string }
  >
  report(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string }): Promise<string>
  approve(featureId: string, notes?: string): Promise<string>
  requestChanges(featureId: string, notes: string): Promise<string>
  pause(featureId: string): Promise<void>
  resume(featureId: string): Promise<void>
  abandon(featureId: string): Promise<void>
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
  /** Runner endpoint registration (`/v1/runners`). Absent → those routes 404. */
  readonly runners?: RunnerRegistry
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
  | "conflict"
  | "run_already_concluded"
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
  conflict: 409,
  run_already_concluded: 409,
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

interface StepDetailProjection {
  readonly status: StepRuntime["status"]
  readonly outputs: Readonly<Record<string, string>>
  readonly truncated?: boolean
  readonly runId?: string
}

/**
 * Full per-job runtime for the DETAIL payload: everything `JobRuntime`
 * carries, with step outputs cut at `STEP_OUTPUT_LIMIT`. A truncated
 * step is marked and points at its newest run so the client can fetch
 * the full output from the runs API.
 */
function jobsDetail(
  feature: FeatureState,
  runs: readonly RunSummary[],
): Readonly<Record<string, unknown>> {
  const newestRunByStep = new Map<string, string>()
  for (const run of runs) {
    const key = `${run.jobId}\u0000${run.stepId}`
    if (!newestRunByStep.has(key)) newestRunByStep.set(key, run.id)
  }
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
      steps[stepId] = {
        status: stepRuntime.status,
        outputs,
        ...(truncated ? { truncated: true } : {}),
        ...(truncated && runId !== undefined ? { runId } : {}),
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

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}

export function createApi(config: ApiConfig, deps: ApiDeps): ConductorApi {
  const { store, engine, health, resolveWorkflow, workflowStatus, runners, logger } = deps
  const staticRoot = config.ui !== undefined ? resolve(config.ui.staticDir) : null
  const sseClients = new Set<SseClient>()
  const inFlight = new Set<Promise<void>>()
  let closed = false

  const unsubscribe = store.onChange((change: StoreChange) => {
    const frame = encoder.encode(`event: change\ndata: ${JSON.stringify(change)}\n\n`)
    for (const client of [...sseClients]) {
      try {
        client.controller.enqueue(frame)
      } catch {
        sseClients.delete(client)
      }
    }
  })

  const error = (requestId: string, code: ApiErrorCode, message: string): Response =>
    json(ERROR_STATUS[code], { error: { code, message, requestId } } satisfies ErrorBody, requestId)

  const json = (status: number, body: unknown, requestId: string): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    })

  const authorized = (request: Request): boolean => {
    if (config.auth.mode === "none") return true
    const header = request.headers.get("authorization")
    if (header === null || !header.startsWith("Bearer ")) return false
    const presented = Buffer.from(header.slice("Bearer ".length))
    const expected = Buffer.from(config.auth.token)
    return presented.length === expected.length && timingSafeEqual(presented, expected)
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
    const runs = store.listRuns(featureId)
    return {
      feature: {
        ...feature,
        escalation: store.getEscalation(featureId),
        currentStep: currentStepOf(feature),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        workflowRef: workflowRefOf(feature.projectDir),
        jobs: jobsDetail(feature, runs),
      },
      activeRun: store.getActiveRun(featureId),
    }
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

    if (!authorized(request)) return error(requestId, "unauthorized", "missing or invalid bearer token")

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

    const runMatch = path.match(/^\/v1\/runs\/([^/]+)(?:\/(report))?$/)
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]!)
      const action = runMatch[2]
      if (action === undefined && method === "GET") {
        const run = store.getRunById(runId)
        if (!run) return error(requestId, "not_found", `unknown run "${runId}"`)
        return json(200, { run }, requestId)
      }
      if (action === "report" && method === "POST") return reportRun(request, runId, requestId)
      return error(requestId, "not_found", `no route for ${method} ${path}`)
    }

    // Static SPA serving is opt-in and strictly subordinate: only paths
    // the /v1 router did not claim reach here, so API routes always win.
    if (staticRoot !== null && !path.startsWith("/v1") && (method === "GET" || method === "HEAD")) {
      const served = serveStatic(staticRoot, path, requestId)
      if (served !== null) return served
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
      const detail = status.diagnostics.map(diagnostic => diagnostic.message).join("; ")
      return error(requestId, "conflict", `workflow for "${dir}" is invalid: ${detail}`)
    }
    // Structure only — job edges plus step ids and kinds. Prompts,
    // expressions, `with:` payloads and retry policies never leave the
    // daemon through this route.
    const workflow = status.snapshot.workflow
    const jobs: Record<string, { needs: readonly string[]; steps: Array<{ id: string; kind: string }> }> = {}
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      jobs[jobId] = {
        needs: job.needs,
        steps: job.steps.map(step => ({ id: step.id, kind: step.type })),
      }
    }
    return json(
      200,
      {
        name: workflow.name,
        stale: status.state === "stale",
        jobs,
        diagnostics: status.state === "stale" ? status.diagnostics : [],
      },
      requestId,
    )
  }

  function serveStatic(root: string, path: string, requestId: string): Response | null {
    const decoded = safeDecode(path)
    if (decoded === null) return null
    const candidate = resolve(root, `.${decoded}`)
    if (candidate !== root && !candidate.startsWith(root + sep)) return null
    const file = pickStaticFile(candidate) ?? pickStaticFile(resolve(root, "index.html"))
    if (file === null) return null
    const contentType = STATIC_CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
    return new Response(Bun.file(file), {
      status: 200,
      headers: { "content-type": contentType, "x-request-id": requestId },
    })
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
    const { title, project, description, workflow, pr, sessionId } = parsed.body
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
    })
    if (!result.ok) return error(requestId, result.code, result.message)
    return json(201, featurePayload(result.feature.id), requestId)
  }

  function featureResource(featureId: string, resource: string, requestId: string): Response {
    const feature = store.getFeature(featureId)
    if (!feature) return error(requestId, "not_found", `unknown feature "${featureId}"`)
    switch (resource) {
      case "runs":
        return json(200, { runs: store.listRuns(featureId) }, requestId)
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
      default:
        return error(requestId, "not_found", `no route for POST /v1/features/:id/${action}`)
    }
  }

  async function reportRun(request: Request, runId: string, requestId: string): Promise<Response> {
    const run = store.getRunById(runId)
    if (!run) return error(requestId, "not_found", `unknown run "${runId}"`)
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const { outcome, verdict, notes } = parsed.body
    if (outcome !== undefined && outcome !== "succeeded" && outcome !== "failed") {
      return error(requestId, "invalid_request", "\"outcome\" must be \"succeeded\" or \"failed\"")
    }
    if (verdict !== undefined && (typeof verdict !== "string" || verdict.trim() === "")) {
      return error(requestId, "invalid_request", "\"verdict\" must be a non-empty string")
    }
    if (notes !== undefined && typeof notes !== "string") {
      return error(requestId, "invalid_request", "\"notes\" must be a string")
    }
    if (outcome === undefined && verdict === undefined) {
      return error(requestId, "invalid_request", "one of \"outcome\" or \"verdict\" is required")
    }
    if (outcome !== undefined && verdict !== undefined) {
      return error(requestId, "invalid_request", "\"outcome\" and \"verdict\" are mutually exclusive")
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
    return json(200, { result, run: store.getRunById(runId) }, requestId)
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

function safeDecode(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path)
    if (decoded.includes("\0")) return null
    return decoded
  } catch {
    return null
  }
}

function pickStaticFile(path: string): string | null {
  try {
    return statSync(path).isFile() ? path : null
  } catch {
    return null
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
