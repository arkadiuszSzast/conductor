/**
 * The `conductor.report` tool surface, independent of the OpenCode SDK so
 * it can be tested with plain fakes. The credential is never taken from
 * tool arguments: it is read from the calling session's
 * `metadata.conductor`, which only the daemon writes at session creation
 * (design.md D5). Semantics mirror the stdio bridge in
 * `packages/cli/src/report-mcp.ts`.
 */

export interface SessionCredential {
  readonly runUrl: string
  readonly runId: string
  readonly token: string
}

export interface ToolResult {
  readonly content: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type ReportFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>

export interface ReportToolsDeps {
  /** Resolves the session's stored metadata; `undefined` for an unknown session. */
  readonly sessionMetadata: (sessionID: string) => Promise<unknown>
  readonly fetch?: ReportFetch
  readonly newInvocationId?: () => string
  readonly sleep?: (ms: number) => Promise<void>
}

const HTTP_TIMEOUT_MS = 10_000
const MAX_RETRIES = 2

export const UNBOUND_MESSAGE =
  "This session is not a Conductor worker session, so there is no run to report for. " +
  "conductor_report, conductor_ask and conductor_status only work inside sessions Conductor created for a step."

export const REPORT_DESCRIPTION =
  "Report this attempt's outcome. Pass outcome (succeeded/failed) for ordinary steps, or verdict " +
  "(approved/changes_requested) for review steps — never verdict together with outcome=failed. " +
  "Structured review gates also require the review object argument. If the call is rejected, read the " +
  "error, fix exactly the named field and call again: the step only concludes when this tool succeeds; " +
  "a report written as chat text is lost."

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  description:
    "Structured gate report — a JSON object argument, never a string and never embedded in notes. " +
    "Required on structured review gates together with verdict.",
  properties: {
    head: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", description: "Full lowercase Git SHA of the reviewed head" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^F[1-9][0-9]*$", description: "Only for findings from a previous round (reuse its F id). Omit for new findings — the daemon assigns ids." },
          path: { type: "string", minLength: 1, description: "Repository-relative file path (no leading /, no ..)" },
          line: { type: "integer", minimum: 1 },
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          blocking: { type: "boolean" },
          body: { type: "string", minLength: 1 },
          acceptanceTests: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "ARRAY of strings, e.g. [\"Foo rejects empty input\"]. Must be non-empty when blocking is true; [] otherwise.",
          },
          status: { type: "string", enum: ["new", "fixed", "dismissed", "reopened"] },
          resolution: { type: "string", minLength: 1, description: "Required when status is not new" },
        },
        required: ["path", "line", "severity", "blocking", "body", "acceptanceTests", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["head", "findings"],
  additionalProperties: false,
} as const

export const TOOL_SCHEMAS = {
  conductor_report: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["succeeded", "failed"] },
      verdict: { type: "string" },
      notes: { type: "string", description: "Short plain-text summary" },
      review: REVIEW_JSON_SCHEMA,
      run_id: { type: "string", description: "Optional; must equal this session's run when given" },
    },
    additionalProperties: false,
  },
  conductor_ask: {
    type: "object",
    properties: { question: { type: "string", minLength: 1 }, run_id: { type: "string" } },
    required: ["question"],
    additionalProperties: false,
  },
  conductor_status: { type: "object", properties: { run_id: { type: "string" } }, additionalProperties: false },
} as const

/** Accepts both the bare `Session.Info` and a `{data}` envelope. */
export function credentialFromMetadata(session: unknown): SessionCredential | null {
  const info = session && typeof session === "object" && "data" in session ? (session as { data: unknown }).data : session
  const conductor = (info as { metadata?: { conductor?: unknown } } | null | undefined)?.metadata?.conductor as Partial<SessionCredential> | undefined
  if (!conductor || typeof conductor.runUrl !== "string" || typeof conductor.runId !== "string" || typeof conductor.token !== "string") return null
  if (!conductor.runUrl || !conductor.runId || !conductor.token) return null
  let url: URL
  try { url = new URL(conductor.runUrl) } catch { return null }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null
  return { runUrl: url.origin, runId: conductor.runId, token: conductor.token }
}

function errorBody(body: Record<string, unknown>, fallback: string): { code: string; message: string } {
  const error = body["error"]
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    return { code: String(record["code"] ?? ""), message: String(record["message"] ?? fallback) }
  }
  return { code: "", message: fallback }
}

export function createReportTools(deps: ReportToolsDeps) {
  const fetchImpl: ReportFetch = deps.fetch ?? ((url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }))
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const newInvocationId = deps.newInvocationId ?? (() => crypto.randomUUID())

  const resolve = async (sessionID: string, claimedRunId: unknown): Promise<SessionCredential | ToolResult> => {
    let credential: SessionCredential | null = null
    try {
      credential = credentialFromMetadata(await deps.sessionMetadata(sessionID))
    } catch {
      credential = null
    }
    if (!credential) return { content: UNBOUND_MESSAGE, metadata: { error: "unbound_session" } }
    if (claimedRunId !== undefined && claimedRunId !== credential.runId) {
      return { content: `run_id "${String(claimedRunId)}" does not belong to this session; omit run_id — the session's run is used automatically.`, metadata: { error: "run_id_mismatch" } }
    }
    return credential
  }

  /** Same request replayed on transport failure only; HTTP answers are never retried. */
  const call = async (credential: SessionCredential, path: string, method: string, body?: unknown): Promise<Response> => {
    let last: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fetchImpl(`${credential.runUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${credential.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
      } catch (error) {
        last = error
        if (attempt < MAX_RETRIES) await sleep(100 * (attempt + 1))
      }
    }
    throw last
  }

  const strip = (input: Record<string, unknown>): Record<string, unknown> => {
    const { run_id: _runId, ...rest } = input
    return rest
  }

  return {
    async report(input: Record<string, unknown>, sessionID: string): Promise<ToolResult> {
      const credential = await resolve(sessionID, input["run_id"])
      if (!("token" in credential)) return credential
      try {
        const response = await call(credential, "/v1/worker/report", "POST", strip(input))
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) {
          const { code, message } = errorBody(body, response.statusText)
          // A prior report already committed; only the acknowledgement was lost.
          if (response.status === 409 && code === "run_already_concluded") return { content: `Already reported: ${message}` }
          return { content: `Report failed (${response.status}): ${message}`, metadata: { error: code || "rejected" } }
        }
        return { content: String(body["result"] ?? "Reported.") }
      } catch {
        return { content: "Report request failed: daemon request could not be confirmed", metadata: { error: "unreachable" } }
      }
    },

    async ask(input: Record<string, unknown>, sessionID: string): Promise<ToolResult> {
      const credential = await resolve(sessionID, input["run_id"])
      if (!("token" in credential)) return credential
      try {
        const response = await call(credential, "/v1/worker/report", "POST", { ask: input["question"], invocation_id: newInvocationId() })
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) return { content: `Ask failed (${response.status}): ${errorBody(body, response.statusText).message}`, metadata: { error: "rejected" } }
        return {
          content: `${String(body["result"] ?? "Question recorded.")}\n` +
            "Your session stays alive: the human's answer will arrive here as a new message. " +
            "End your turn now and wait — do NOT report an outcome yet.",
        }
      } catch {
        return { content: "Ask request failed: daemon request could not be confirmed", metadata: { error: "unreachable" } }
      }
    },

    async status(input: Record<string, unknown>, sessionID: string): Promise<ToolResult> {
      const credential = await resolve(sessionID, input["run_id"])
      if (!("token" in credential)) return credential
      try {
        const response = await call(credential, "/v1/worker/status", "GET")
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) return { content: `Status request failed (${response.status})`, metadata: { error: "rejected" } }
        return { content: JSON.stringify(body["status"] ?? body) }
      } catch {
        return { content: "Status request failed: daemon request could not be confirmed", metadata: { error: "unreachable" } }
      }
    },
  }
}
