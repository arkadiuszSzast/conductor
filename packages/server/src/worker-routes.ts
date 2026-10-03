import type { EngineControl } from "./api.ts"
import { WorkerInvocationConflict, type Store } from "./store.ts"
import type { ReportingReadinessPort } from "./runner-execution.ts"
import { extractBearerToken, verifyRunCredential } from "./run-auth.ts"
import { isAlreadyConcludedMessage, ownRunStatusProjection, parseReportBody, reportRejectionLogEntry } from "./run-reporting.ts"

export interface WorkerRoutesDeps {
  readonly store: Store
  readonly engine: EngineControl
  readonly readiness: ReportingReadinessPort
  readonly clock: { readonly now: () => number }
}
export interface WorkerRouteResult { readonly status: number; readonly body: unknown }
const reject = (status: number, code: string, message: string): WorkerRouteResult => ({ status, body: { error: { code, message } } })
class WorkerAuthorizationError extends Error {}
class WorkerScopeError extends WorkerAuthorizationError {}

/** No await may intervene between this check and a synchronous mutation. The
 * engine must call this again in its report/ask transaction, not just at entry. */
function authorize(deps: WorkerRoutesDeps, request: Request, allowConcluded = false, scope?: unknown): { runId: string; concluded: boolean } {
  const token = extractBearerToken(request.headers.get("authorization"))
  if (!token) throw new WorkerAuthorizationError()
  const verified = verifyRunCredential(deps.store, token, deps.clock.now())
  if (!verified.ok && !(allowConcluded && verified.reason === "revoked_concluded")) throw new WorkerAuthorizationError()
  if (!("credential" in verified)) throw new WorkerAuthorizationError()
  const credential = verified.credential
  if (scope !== undefined && scope !== credential.runId) throw new WorkerScopeError()
  if (!verified.ok) return { runId: credential.runId, concluded: true }
  const run = deps.store.getRunById(credential.runId)
  const binding = deps.store.getRunnerBinding(credential.runId)
  if (!run || run.attempt !== credential.attempt || run.status !== "running" || deps.store.getFence(run.id)
    || (binding && (binding.phase !== "active" || binding.processGeneration !== credential.processGeneration))) throw new WorkerAuthorizationError()
  return { runId: run.id, concluded: false }
}

/** Bound both memory and time while consuming an untrusted body. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 256 * 1024) throw new Error("body limit")
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const text = new TextDecoder().decode(bytes)
      const body: unknown = text.trim() ? JSON.parse(text) : {}
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required")
      return body as Record<string, unknown>
    }
    return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("body timeout")), 10_000) })])
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

export async function handleWorkerReport(deps: WorkerRoutesDeps, request: Request): Promise<WorkerRouteResult> {
  authorize(deps, request, true)
  const body = await readBody(request)
  const auth = authorize(deps, request, true, body["run_id"])
  const validated = parseReportBody(body)
  if (!validated.ok) {
    if (!auth.concluded) deps.store.appendRunLog(auth.runId, [reportRejectionLogEntry(validated.message)], { requireRunning: true })
    return reject(400, "invalid_request", validated.message)
  }
  if (auth.concluded) {
    if (validated.ask !== undefined) throw new WorkerAuthorizationError()
    return reject(409, "run_already_concluded", "Run already concluded; no mutation performed.")
  }
  const invocationId = body["invocation_id"]
  if (validated.ask !== undefined && (typeof invocationId !== "string" || !invocationId.trim() || invocationId.length > 128)) {
    return reject(400, "invalid_request", "ask requires a non-empty invocation_id (at most 128 characters)")
  }
  // No fallback to an unguarded report: composition must provide the engine's
  // shared transactional authority, including durable invocation dedup for ask.
  if (!deps.engine.reportWorker) return reject(503, "unavailable", "Guarded worker reporting and durable ask dedup are not available")
  const { ok: _ok, ...input } = validated
  const result = await deps.engine.reportWorker({
    ...input, runId: auth.runId,
    ...(validated.ask !== undefined ? { invocationId: invocationId as string } : {}),
    authorize: () => { authorize(deps, request, false, auth.runId) },
  })
  if (result.startsWith("Invalid review:")) {
    deps.store.appendRunLog(auth.runId, [reportRejectionLogEntry(result)], { requireRunning: true })
    return reject(400, "invalid_request", result)
  }
  if (isAlreadyConcludedMessage(result, auth.runId)) return reject(409, "run_already_concluded", result)
  return { status: 200, body: { result } }
}
export async function handleWorkerStatus(deps: WorkerRoutesDeps, request: Request): Promise<WorkerRouteResult> {
  const scope = new URL(request.url).searchParams.get("run_id") ?? undefined
  const auth = authorize(deps, request, false, scope)
  return { status: 200, body: { status: ownRunStatusProjection(deps.store.getRunById(auth.runId)!) } }
}
export async function handleWorkerReady(deps: WorkerRoutesDeps, request: Request): Promise<WorkerRouteResult> {
  authorize(deps, request)
  const body = await readBody(request)
  const auth = authorize(deps, request, false, body["run_id"])
  const phase = body["phase"]
  if (phase !== "initialized" && phase !== "tools_listed") return reject(400, "invalid_request", "phase must be initialized or tools_listed")
  deps.readiness.markPhase(auth.runId, phase)
  return { status: 200, body: { ok: true } }
}
export async function createWorkerRoutes(deps: WorkerRoutesDeps, request: Request, method: string, path: string): Promise<WorkerRouteResult | null> {
  try {
    if (path === "/v1/worker/report" && method === "POST") return await handleWorkerReport(deps, request)
    if (path === "/v1/worker/status" && method === "GET") return await handleWorkerStatus(deps, request)
    if (path === "/v1/worker/ready" && method === "POST") return await handleWorkerReady(deps, request)
    authorize(deps, request)
    return reject(404, "not_found", "Unknown worker route")
  } catch (error) {
    if (error instanceof WorkerInvocationConflict) return reject(409, "conflict", error.message)
    if (error instanceof WorkerScopeError) return reject(403, "unauthorized", "run_id does not match credential scope")
    if (error instanceof WorkerAuthorizationError) return reject(401, "unauthorized", "Invalid worker credential or scope")
    if (error instanceof SyntaxError || (error instanceof Error && ["body limit", "body timeout", "object required"].includes(error.message))) return reject(400, "invalid_json", "Expected a bounded JSON object")
    // Never include request data, credentials or arbitrary engine errors.
    return reject(500, "internal", "Worker request failed")
  }
}
