/**
 * `conductor report-mcp` — the stdio MCP reporting bridge (design.md D8,
 * task 4.3). Exposes EXACTLY three tools (`conductor_report`,
 * `conductor_ask`, `conductor_status`) over stdio MCP, bound to one
 * run's attempt-scoped credential injected via environment. This module
 * MUST:
 *
 *  - bypass ordinary CLI administrator config/token discovery entirely —
 *    it reads ONLY `CONDUCTOR_RUN_URL`, `CONDUCTOR_RUN_ID`,
 *    `CONDUCTOR_RUN_TOKEN` from its injected environment;
 *  - never start a daemon;
 *  - emit ONLY MCP protocol data on stdout — every diagnostic goes to
 *    stderr, never stdout (stdout is protocol-only, matching ACP's own
 *    stdio contract elsewhere in this change);
 *  - never persist a parallel outcome ledger — every tool call is a
 *    bounded HTTP request to the daemon's restricted `/v1/worker/*`
 *    routes, which hold the ONLY durable state.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { randomUUID } from "node:crypto"

export interface ReportMcpEnv {
  readonly CONDUCTOR_RUN_URL?: string
  readonly CONDUCTOR_RUN_ID?: string
  readonly CONDUCTOR_RUN_TOKEN?: string
}

export interface ReportMcpConfig {
  readonly runUrl: string
  readonly runId: string
  readonly runToken: string
}

export class ReportMcpConfigError extends Error {}

/** Reads ONLY the three injected run-scoped variables — never touches
 *  any other environment variable, never falls back to a config file,
 *  never discovers an admin token (D3: "reads only injected
 *  CONDUCTOR_RUN_URL, CONDUCTOR_RUN_ID, CONDUCTOR_RUN_TOKEN; it must
 *  bypass normal CLI config/token discovery and daemon auto-start"). */
export function readReportMcpConfig(env: ReportMcpEnv): ReportMcpConfig {
  const runUrl = env.CONDUCTOR_RUN_URL
  const runId = env.CONDUCTOR_RUN_ID
  const runToken = env.CONDUCTOR_RUN_TOKEN
  if (!runUrl || runUrl.trim() === "") throw new ReportMcpConfigError("CONDUCTOR_RUN_URL is required")
  if (!runId || runId.trim() === "") throw new ReportMcpConfigError("CONDUCTOR_RUN_ID is required")
  if (!runToken || runToken.trim() === "") throw new ReportMcpConfigError("CONDUCTOR_RUN_TOKEN is required")
  let parsed: URL
  try {
    parsed = new URL(runUrl)
  } catch {
    throw new ReportMcpConfigError("CONDUCTOR_RUN_URL is not a valid URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ReportMcpConfigError("CONDUCTOR_RUN_URL must use http or https")
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new ReportMcpConfigError("CONDUCTOR_RUN_URL must be an origin without credentials, path, query or fragment")
  return { runUrl: parsed.origin, runId, runToken }
}

const HTTP_TIMEOUT_MS = 10_000
const MAX_RETRIES = 2

/** One outgoing HTTP call description — a plain data shape rather than
 *  a `Request` object, deliberately: `Request`'s exact global type can
 *  differ between Bun's own lib and a transitively-pulled Node/undici
 *  typing (from the MCP SDK's own dependencies), which makes a shared
 *  `Request`-typed function signature fragile across package
 *  boundaries. A plain shape has no such ambiguity. */
export interface ReportMcpRequestInit {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** Injectable HTTP fetch — production performs the real network call,
 *  tests inject a fake that never touches the network. */
export type ReportMcpFetch = (request: ReportMcpRequestInit) => Promise<Response>

const defaultFetchImpl: ReportMcpFetch = request =>
  fetch(request.url, {
    method: request.method,
    redirect: "error",
    headers: request.headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    ...(request.body !== undefined ? { body: request.body } : {}),
  })

export interface ReportMcpDeps {
  readonly config: ReportMcpConfig
  readonly fetchImpl?: ReportMcpFetch
  /** stderr-only diagnostic sink — NEVER stdout (D3: "stdout is
   *  protocol only"). Defaults to `console.error`. */
  readonly logError?: (message: string) => void
}

/**
 * Bounded same-key retry (D8: "bridge assigns an invocation id per MCP
 * request and reuses it across bounded HTTP retries"). Only call for
 * idempotent status/readiness, terminal reports, or durably keyed asks.
 * A fetch exception is ambiguous, NOT evidence of a pre-connect failure.
 * HTTP rejections are never retried.
 */
async function boundedRequest(
  fetchImpl: ReportMcpFetch,
  request: ReportMcpRequestInit,
  maxRetries: number = MAX_RETRIES,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchImpl(request)
    } catch (error) {
      lastError = error
      if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function workerRequest(config: ReportMcpConfig, path: string, method: string, body?: unknown): ReportMcpRequestInit {
  return {
    url: `${config.runUrl}${path}`,
    method,
    headers: {
      authorization: `Bearer ${config.runToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
}

interface ToolTextResult {
  [key: string]: unknown
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function textResult(text: string, isError = false): ToolTextResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
}

/**
 * Builds the MCP server with exactly the three permitted tools. Readiness
 * callbacks (`initialized`/`tools_listed`) are posted to
 * `/v1/worker/ready` as soon as this server actually connects and lists
 * its tools — proving the runtime engaged the bridge, not merely that
 * the process was spawned (D8: "Merely spawning a bridge is not tool
 * readiness").
 */
export function createReportMcpServer(deps: ReportMcpDeps): McpServer {
  const fetchImpl = deps.fetchImpl ?? defaultFetchImpl
  const logError = deps.logError ?? ((message: string) => console.error(message))
  const { config } = deps

  const server = new McpServer(
    { name: "conductor-report", version: "1.0.0" },
    { capabilities: { tools: {} } },
  )

  server.registerTool(
    "conductor_report",
    {
      title: "Report step outcome",
      description: "Reports the outcome of the current step: succeeded, failed, a verdict, or an ask question.",
      inputSchema: {
        outcome: z.enum(["succeeded", "failed"]).optional(),
        verdict: z.string().optional(),
        notes: z.string().optional(),
        review: z.unknown().optional(),
      },
    },
    async input => {
      try {
        const response = await boundedRequest(fetchImpl, workerRequest(config, "/v1/worker/report", "POST", input))
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) {
          const code = typeof body["error"] === "object" && body["error"] !== null
            ? String((body["error"] as Record<string, unknown>)["code"] ?? "")
            : ""
          const message = typeof body["error"] === "object" && body["error"] !== null
            ? String((body["error"] as Record<string, unknown>)["message"] ?? response.statusText)
            : response.statusText
          // D8/lost-report-ACK: a 409 "run_already_concluded" means a
          // PRIOR report from this exact credential already committed —
          // the agent lost only the acknowledgement, not the outcome.
          // This is NOT a failure the agent needs to retry or correct:
          // surfacing it as a tool error would invite exactly the
          // pointless re-report/redo-work loop the design's revoked-
          // credential carve-out exists to prevent. Every OTHER error
          // status still surfaces as a genuine tool error.
          if (response.status === 409 && code === "run_already_concluded") return textResult(`Already reported: ${message}`)
          return textResult(`Report failed (${response.status}): ${message}`, true)
        }
        return textResult(String(body["result"] ?? "Reported."))
      } catch (error) {
        logError(`conductor_report request failed: ${errorMessage(error)}`)
        // Tool errors never invent success (D8) — an unreachable daemon
        // surfaces as an explicit tool error, never a fabricated "ok".
        return textResult(`Report request failed: ${errorMessage(error)}`, true)
      }
    },
  )

  server.registerTool(
    "conductor_ask",
    {
      title: "Ask a question",
      description: "Asks a human a question and pauses the step for an answer. Only available on interactive steps.",
      inputSchema: { question: z.string().min(1) },
    },
    async input => {
      // D8: bridge assigns an invocation id per MCP request and reuses
      // it across bounded HTTP retries — generated ONCE per logical
      // call, threaded through every retry attempt inside boundedRequest
      // via the request body itself (not the transport layer), so a
      // retried delivery is recognizably the SAME invocation to the
      // daemon's dedup store.
      const invocationId = randomUUID()
      try {
        const response = await boundedRequest(
          fetchImpl,
          workerRequest(config, "/v1/worker/report", "POST", { ask: input.question, invocation_id: invocationId }),
        )
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) {
          const message = typeof body["error"] === "object" && body["error"] !== null
            ? String((body["error"] as Record<string, unknown>)["message"] ?? response.statusText)
            : response.statusText
          return textResult(`Ask failed (${response.status}): ${message}`, true)
        }
        return textResult(String(body["result"] ?? "Question recorded."))
      } catch (error) {
        logError(`conductor_ask request failed: ${errorMessage(error)}`)
        return textResult(`Ask request failed: ${errorMessage(error)}`, true)
      }
    },
  )

  server.registerTool(
    "conductor_status",
    {
      title: "Own run status",
      description: "Returns the minimal status of THIS attempt's own run only.",
      inputSchema: {},
    },
    async () => {
      try {
        const response = await boundedRequest(fetchImpl, workerRequest(config, "/v1/worker/status", "GET"))
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) return textResult(`Status request failed (${response.status})`, true)
        return textResult(JSON.stringify(body["status"] ?? body))
      } catch (error) {
        logError(`conductor_status request failed: ${errorMessage(error)}`)
        return textResult(`Status request failed: ${errorMessage(error)}`, true)
      }
    },
  )

  // These hooks run only after actual client protocol activity. Connecting a
  // transport alone is not evidence of initialization or tools discovery.
  server.server.oninitialized = () => { void postReadyPhase(deps, "initialized") }
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    await postReadyPhase(deps, "tools_listed")
    return { tools: [
      { name: "conductor_report", description: "Report this attempt's outcome or structured review", inputSchema: { type: "object" as const, properties: { outcome: { type: "string", enum: ["succeeded", "failed"] }, verdict: { type: "string" }, notes: { type: "string" }, review: { type: "object" } }, additionalProperties: false } },
      { name: "conductor_ask", description: "Ask a human on an interactive step", inputSchema: { type: "object" as const, properties: { question: { type: "string", minLength: 1 } }, required: ["question"], additionalProperties: false } },
      { name: "conductor_status", description: "Own attempt status only", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } },
    ] }
  })
  return server
}

/** Posts a readiness phase to `/v1/worker/ready` — best-effort, logs to
 *  stderr only on failure (never stdout, never throws — a readiness-post
 *  failure must not crash the bridge itself). */
async function postReadyPhase(deps: ReportMcpDeps, phase: "initialized" | "tools_listed"): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? defaultFetchImpl
  const logError = deps.logError ?? ((message: string) => console.error(message))
  try {
    const response = await boundedRequest(fetchImpl, workerRequest(deps.config, "/v1/worker/ready", "POST", { phase }), 1)
    if (!response.ok) logError(`readiness phase ${phase} rejected (${response.status})`)
  } catch (error) {
    logError(`failed to post readiness phase "${phase}": ${errorMessage(error)}`)
  }
}

/**
 * Runs the report-mcp entrypoint over stdio until the transport closes.
 * `env` is the ONLY environment source (bypasses normal CLI config
 * discovery); `fetchImpl`/`logError` are injectable for deterministic
 * tests. Never starts a daemon, never reads `~/.config/conductor`.
 */
export async function runReportMcp(env: ReportMcpEnv, deps: Omit<ReportMcpDeps, "config"> = {}): Promise<void> {
  const config = readReportMcpConfig(env)
  const server = createReportMcpServer({ ...deps, config })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function errorMessage(_error: unknown): string {
  // Fetch errors can contain the URL, headers or injected environment.
  return "daemon request could not be confirmed"
}
