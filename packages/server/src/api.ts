/**
 * HTTP API v1 — the daemon's primary control surface (REST + SSE).
 *
 * The API is a thin projection over the extracted `Store`/`Engine`/
 * `Daemon`: every command operation routes through the SAME engine
 * methods (`dispatch`/`report`/`approve`/`requestChanges`) the CLI, UI
 * and runners use — there is no privileged in-process path and no
 * pipeline logic duplicated here. State reads come straight from the
 * store; SSE (`/v1/events`) is an INVALIDATION stream: subscribers get
 * `{kind, featureId}` notifications after a transition/run/finding is
 * durable and refetch authoritative state over REST — the event itself
 * never carries state.
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
import type { Store, StoreChange } from "./store.ts"
import type { DaemonHealth, DaemonLogger } from "./daemon.ts"
import type { ConfigResolver } from "./engine/ports.ts"
import type { PipelineEvent } from "./store.ts"

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
}

// ------------------------------------------------------------------- deps

/**
 * The engine surface the API commands route through — the same methods
 * every other client uses. `Engine` satisfies this structurally.
 */
export interface EngineControl {
  dispatch(featureId: string, event: PipelineEvent): Promise<void>
  report(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string }): Promise<string>
  approve(featureId: string, notes?: string): Promise<string>
  requestChanges(featureId: string, notes: string): Promise<string>
}

export interface ApiDeps {
  readonly store: Store
  readonly engine: EngineControl
  readonly health: () => DaemonHealth
  /** Per-project config lookup — used to validate feature-start requests. */
  readonly resolveConfig: ConfigResolver
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
  /** Open SSE subscriber count (observability + shutdown tests). */
  readonly sseClientCount: number
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

const encoder = new TextEncoder()

export function createApi(config: ApiConfig, deps: ApiDeps): ConductorApi {
  const { store, engine, health, resolveConfig, logger } = deps
  const sseClients = new Set<SseClient>()
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

  function featurePayload(featureId: string) {
    const feature = store.getFeature(featureId)
    if (!feature) return null
    return { feature, activeRun: store.getActiveRun(featureId) }
  }

  async function handle(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? randomUUID()
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const method = request.method.toUpperCase()

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
      return sseResponse(request, requestId)
    }

    if (path === "/v1/features") {
      if (method === "GET") {
        const project = url.searchParams.get("project") ?? undefined
        const active = url.searchParams.get("active") === "true"
        const features = store.listFeatures({
          ...(active ? { activeOnly: true } : {}),
          ...(project !== undefined ? { projectDir: project } : {}),
        })
        return json(200, { features }, requestId)
      }
      if (method === "POST") return createFeature(request, requestId)
      return error(requestId, "not_found", `no route for ${method} ${path}`)
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
        return json(200, { run: { id: runId, ...run } }, requestId)
      }
      if (action === "report" && method === "POST") return reportRun(request, runId, requestId)
      return error(requestId, "not_found", `no route for ${method} ${path}`)
    }

    return error(requestId, "not_found", `no route for ${method} ${path}`)
  }

  async function createFeature(request: Request, requestId: string): Promise<Response> {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) return error(requestId, "invalid_json", "request body must be a JSON object")
    const { title, project, description, workflow, pr } = parsed.body
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
    const config = resolveConfig(project)
    if (!config) {
      return error(requestId, "project_not_configured", `no valid conductor config registered for "${project}"`)
    }
    if (workflow !== undefined && config.resolvedWorkflows[workflow] === undefined) {
      const known = Object.keys(config.resolvedWorkflows)
      return error(
        requestId,
        "unknown_workflow",
        `unknown workflow "${workflow}"${known.length > 0 ? ` (available: ${known.join(", ")})` : ""}`,
      )
    }
    const feature = store.createFeature({
      title,
      slug: slugify(title),
      projectDir: project,
      ...(workflow !== undefined ? { workflow } : {}),
      ...(description !== undefined ? { description } : {}),
    })
    if (pr !== undefined) store.setFeatureFields(feature.id, { pr })
    await engine.dispatch(feature.id, { kind: "feature.start" })
    return json(201, featurePayload(feature.id), requestId)
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

    switch (action) {
      case "approve": {
        if (feature.status !== "waiting_human") {
          return error(requestId, "conflict", `feature is not waiting for approval (status: ${feature.status})`)
        }
        const result = await engine.approve(featureId, notes)
        return json(200, { result, ...featurePayload(featureId) }, requestId)
      }
      case "request-changes": {
        if (feature.status !== "waiting_human") {
          return error(requestId, "conflict", `feature is not waiting for approval (status: ${feature.status})`)
        }
        if (notes === undefined || notes.trim() === "") {
          return error(requestId, "invalid_request", "\"notes\" (non-empty string) is required for request-changes")
        }
        const result = await engine.requestChanges(featureId, notes)
        return json(200, { result, ...featurePayload(featureId) }, requestId)
      }
      case "pause":
        await engine.dispatch(featureId, { kind: "human.paused" })
        return json(200, featurePayload(featureId), requestId)
      case "resume":
        await engine.dispatch(featureId, { kind: "human.resumed" })
        return json(200, featurePayload(featureId), requestId)
      case "abandon":
        await engine.dispatch(featureId, { kind: "human.abandoned" })
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
    // the pre-check and this call — the loser maps to the same 409.
    if (result.includes("already concluded")) {
      return error(requestId, "run_already_concluded", result)
    }
    return json(200, { result, run: { id: runId, ...store.getRunById(runId) } }, requestId)
  }

  function sseResponse(request: Request, requestId: string): Response {
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
    request.signal.addEventListener("abort", () => {
      if (client.current) {
        sseClients.delete(client.current)
        try {
          client.current.controller.close()
        } catch {
          // already closed
        }
      }
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

  return {
    handle,
    close,
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
 * shutdown order: end SSE streams (so no response is left hanging),
 * then stop the listener with in-flight requests allowed to finish.
 * The process owner composes this with `Daemon.stop()` — API first, so
 * no new commands arrive while the daemon is closing SQLite.
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
        await server.stop()
        deps.logger?.log({ level: "info", message: "api stopped" })
      })()
      return stopPromise
    },
  }
}
