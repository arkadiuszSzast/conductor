/**
 * Daemon-side `SessionClient` over the OpenCode v2 HTTP API (design.md
 * D1–D5). One instance per `runners.opencode.<profile>`; the server is
 * external and never supervised here.
 *
 * Idempotency comes from the server, not from a local journal: session
 * and message ids are derived from the durable operation identity, the
 * server answers a replayed id with the ORIGINAL record (never a 409 —
 * see the task 1.1 probe in design.md D4), and the client compares that
 * echo with its request. A mismatch, or a write whose delivery cannot be
 * proven either way after bounded replays, is `delivery: "unknown"`.
 */

import { createHash, randomUUID } from "node:crypto"
import { RunnerOperationError } from "../ports.ts"
import type { OperationPurpose, PrepareInput, PrepareResult, SessionCapabilities, SessionClient, SessionStatus } from "../ports.ts"
import { directoryWithinRoots } from "../acp/config.ts"
import { DEFAULT_OPENCODE_DEADLINES, splitModelRef } from "./config.ts"
import type { OpencodeDeadlines } from "./config.ts"

export const OPENCODE_SESSION_CAPABILITIES: SessionCapabilities = {
  parentSessions: true,
  nonInferentialNotes: true,
  promptConfirmation: "immediate",
}

export const REPORT_PLUGIN_ID = "conductor.report"

const CATALOG_POLL_MS = 250
const WRITE_ATTEMPTS = 3

export type OpencodeFetch = (request: Request) => Promise<Response>

export interface OpencodeSessionsDeps {
  readonly profileId: string
  readonly baseUrl: string
  readonly username?: string
  /** Read lazily so a rotated password file is picked up without restart. */
  readonly password: () => string
  readonly allowedRoots: readonly string[]
  readonly maxConcurrent: number
  readonly deadlines?: Partial<OpencodeDeadlines>
  /** Running attempts currently bound to this profile. */
  readonly activeRuns: () => number
  /** Issues the attempt credential the reporting plugin reads from session metadata. */
  readonly credential: (runId: string) => { readonly runUrl: string; readonly token: string }
  readonly fetch?: OpencodeFetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

interface Selection {
  readonly directory: string
  readonly agent: string
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly expiresAt: number
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** `ses_c…` / `msg_c…`: 26 base62 characters after the `_`, derived from
 *  a SHA-256 of the identity so a replay always reuses the same id. */
export function deterministicId(prefix: "ses" | "msg", identity: string): string {
  let value = BigInt(`0x${createHash("sha256").update(identity).digest("hex")}`)
  let out = ""
  while (out.length < 25) {
    out += BASE62[Number(value % 62n)]
    value /= 62n
  }
  return `${prefix}_c${out}`
}

export function sessionIdForRun(runId: string): string {
  return deterministicId("ses", `conductor:create:${runId}`)
}

export function sessionIdForFeature(featureId: string): string {
  return deterministicId("ses", `conductor:feature:${featureId}`)
}

export function messageIdFor(sessionID: string, purpose: OperationPurpose, operationId: string): string {
  return deterministicId("msg", `conductor:${purpose}:${sessionID}:${operationId}`)
}

class HttpFailure extends Error {
  constructor(message: string, readonly status: number | null, readonly maybeDelivered: boolean, readonly body = "") {
    super(message)
  }
}

function isPreConnectFailure(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null
  const code = value?.code ?? value?.cause?.code
  return code === "ConnectionRefused" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "FailedToOpenSocket"
}

function bounded(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export class OpencodeSessions implements SessionClient {
  private readonly deadlines: OpencodeDeadlines
  private readonly fetchImpl: OpencodeFetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly reservations = new Map<string, Selection>()

  constructor(private readonly deps: OpencodeSessionsDeps) {
    this.deadlines = { ...DEFAULT_OPENCODE_DEADLINES, ...deps.deadlines }
    this.fetchImpl = deps.fetch ?? (request => fetch(request))
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = deps.now ?? Date.now
  }

  capabilities(): SessionCapabilities {
    return OPENCODE_SESSION_CAPABILITIES
  }

  // ------------------------------------------------------------------ http

  private url(path: string, directory?: string): string {
    const base = this.deps.baseUrl.replace(/\/+$/, "")
    const query = directory !== undefined ? `${path.includes("?") ? "&" : "?"}location%5Bdirectory%5D=${encodeURIComponent(directory)}` : ""
    return `${base}${path}${query}`
  }

  private async request(method: string, path: string, options: { directory?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.deps.username ?? "opencode"}:${this.deps.password()}`).toString("base64")}`,
    }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deadlines.requestMs)
    let response: Response
    try {
      response = await this.fetchImpl(new Request(this.url(path, options.directory), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      }))
    } catch (error) {
      clearTimeout(timer)
      const pre = isPreConnectFailure(error)
      throw new HttpFailure(`${method} ${path}: ${pre ? "connection refused" : controller.signal.aborted ? "request deadline exceeded" : "transport failure"}`, null, !pre)
    }
    try {
      const text = await response.text()
      if (!response.ok) throw new HttpFailure(`${method} ${path}: HTTP ${response.status}`, response.status, response.status >= 500, bounded(text))
      return { status: response.status, json: text ? JSON.parse(text) as unknown : null }
    } catch (error) {
      if (error instanceof HttpFailure) throw error
      throw new HttpFailure(`${method} ${path}: unreadable response`, response.status, true)
    } finally {
      clearTimeout(timer)
    }
  }

  private static data(json: unknown): unknown {
    return json && typeof json === "object" && "data" in json ? (json as { data: unknown }).data : json
  }

  /**
   * Bounded replay of an idempotent write. Only a definitive 4xx or a
   * pre-connect failure on EVERY attempt is `not_sent`; anything that
   * might have reached the server and was never answered is `unknown`.
   */
  private async idempotentWrite(path: string, body: unknown, operationId: string, directory?: string): Promise<unknown> {
    let maybeDelivered = false
    let last: HttpFailure | undefined
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      try {
        return OpencodeSessions.data((await this.request("POST", path, { body, ...(directory !== undefined ? { directory } : {}) })).json)
      } catch (error) {
        if (!(error instanceof HttpFailure)) throw error
        last = error
        maybeDelivered ||= error.maybeDelivered
        if (error.status !== null && error.status < 500) {
          if (maybeDelivered) break
          throw new RunnerOperationError(`OpenCode rejected the request: ${error.message}`, {
            delivery: "not_sent", operationId, diagnostic: bounded(`${error.message} ${error.body}`),
            ...(error.status === 400 || error.status === 422 ? { failureClass: "invalid_config" as const } : {}),
          })
        }
        if (attempt < WRITE_ATTEMPTS - 1) await this.sleep(CATALOG_POLL_MS * (attempt + 1))
      }
    }
    throw new RunnerOperationError(`OpenCode write outcome unknown: ${last?.message ?? "no response"}`, {
      delivery: maybeDelivered ? "unknown" : "not_sent", operationId, diagnostic: bounded(last?.message ?? "no response"),
    })
  }

  // --------------------------------------------------------------- prepare

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    this.expireReservations()
    if (!directoryWithinRoots(input.directory, this.deps.allowedRoots)) {
      return { ok: false, reason: "incompatible", diagnostic: `directory "${input.directory}" is outside allowedRoots of opencode profile "${this.deps.profileId}"` }
    }
    if (this.deps.activeRuns() + this.reservations.size >= this.deps.maxConcurrent) {
      return { ok: false, reason: "unavailable", diagnostic: `opencode profile "${this.deps.profileId}" is at maxConcurrent=${this.deps.maxConcurrent}` }
    }
    if (input.model === undefined) {
      return { ok: false, reason: "incompatible", diagnostic: `no model configured for agent "${input.agent}" (set role.model or runners.opencode.${this.deps.profileId}.bindings.${input.agent}.model)` }
    }
    const ref = splitModelRef(input.model)
    if (!ref) return { ok: false, reason: "incompatible", diagnostic: `model "${input.model}" must be "provider/id"` }

    const deadline = this.now() + this.deadlines.startupMs
    let agents: { id?: unknown; name?: unknown }[] = []
    let plugins: { id?: unknown; state?: { status?: unknown } }[] = []
    let lastError = ""
    for (;;) {
      try {
        agents = OpencodeSessions.data((await this.request("GET", "/api/agent", { directory: input.directory })).json) as typeof agents
        if (Array.isArray(agents) && agents.length > 0) {
          plugins = OpencodeSessions.data((await this.request("GET", "/api/plugin", { directory: input.directory })).json) as typeof plugins
          if (Array.isArray(plugins) && plugins.some(p => p.id === REPORT_PLUGIN_ID && p.state?.status === "active")) break
          lastError = `reporting plugin "${REPORT_PLUGIN_ID}" is not active for this location`
        } else {
          lastError = "agent catalog is empty (cold location)"
        }
      } catch (error) {
        lastError = error instanceof HttpFailure ? bounded(`${error.message} ${error.body}`) : String(error)
        if (error instanceof HttpFailure && (error.status === 401 || error.status === 403)) {
          return { ok: false, reason: "incompatible", diagnostic: `opencode profile "${this.deps.profileId}": authentication rejected` }
        }
      }
      if (this.now() >= deadline) {
        const loaded = Array.isArray(agents) && agents.length > 0
        return { ok: false, reason: loaded ? "incompatible" : "unavailable", diagnostic: `opencode location not ready: ${lastError}` }
      }
      await this.sleep(CATALOG_POLL_MS)
    }

    if (!agents.some(agent => agent.id === input.agent || agent.name === input.agent)) {
      return { ok: false, reason: "incompatible", diagnostic: `agent "${input.agent}" is not defined for ${input.directory}` }
    }
    let models: { id?: unknown; providerID?: unknown; variants?: { id?: unknown }[] }[]
    try {
      models = OpencodeSessions.data((await this.request("GET", "/api/model", { directory: input.directory })).json) as typeof models
    } catch (error) {
      return { ok: false, reason: "unavailable", diagnostic: `opencode model catalog unavailable: ${error instanceof Error ? error.message : String(error)}` }
    }
    const model = Array.isArray(models) ? models.find(m => m.providerID === ref.providerID && m.id === ref.id) : undefined
    if (!model) return { ok: false, reason: "incompatible", diagnostic: `model "${input.model}" is not offered by the server` }
    if (input.variant !== undefined && !(model.variants ?? []).some(v => v.id === input.variant)) {
      const offered = (model.variants ?? []).map(v => String(v.id)).join(", ") || "none"
      return { ok: false, reason: "incompatible", diagnostic: `variant "${input.variant}" is not offered by model "${input.model}" (offered: ${offered})` }
    }

    const reservationId = randomUUID()
    this.reservations.set(reservationId, {
      directory: input.directory,
      agent: input.agent,
      providerID: ref.providerID,
      modelID: ref.id,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      expiresAt: this.now() + this.deadlines.startupMs,
    })
    return { ok: true, reservationId, capabilities: OPENCODE_SESSION_CAPABILITIES }
  }

  async releaseReservation(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId)
  }

  private expireReservations(): void {
    const now = this.now()
    for (const [id, selection] of this.reservations) if (selection.expiresAt <= now) this.reservations.delete(id)
  }

  // ---------------------------------------------------------------- create

  async createSession(input: Parameters<SessionClient["createSession"]>[0]): Promise<{ id: string }> {
    const selection = input.reservationId !== undefined ? this.reservations.get(input.reservationId) : undefined
    if (input.reservationId !== undefined) this.reservations.delete(input.reservationId)
    if (!selection || !input.runId) throw new RunnerOperationError("opencode reservation unavailable", { delivery: "not_sent" })
    if (selection.directory !== input.directory) throw new RunnerOperationError("opencode reservation directory mismatch", { delivery: "not_sent" })
    const id = sessionIdForRun(input.runId)
    const { runUrl, token } = this.deps.credential(input.runId)
    const model = { providerID: selection.providerID, id: selection.modelID, ...(selection.variant !== undefined ? { variant: selection.variant } : {}) }
    const echo = await this.idempotentWrite("/api/session", {
      id,
      title: input.title,
      ...(input.parentID !== undefined ? { parentID: input.parentID } : {}),
      agent: selection.agent,
      model,
      location: { directory: input.directory },
      metadata: { conductor: { runUrl, runId: input.runId, token } },
    }, input.operationId ?? input.runId, input.directory) as {
      id?: unknown; parentID?: unknown; agent?: unknown; model?: { providerID?: unknown; id?: unknown; variant?: unknown }
      metadata?: { conductor?: { runId?: unknown } }; location?: { directory?: unknown }
    } | null
    if (!echo || echo.id !== id || echo.agent !== selection.agent || echo.model?.providerID !== model.providerID
      || echo.model?.id !== model.id || (echo.model?.variant ?? undefined) !== model.variant || echo.metadata?.conductor?.runId !== input.runId
      || (echo.parentID ?? undefined) !== input.parentID) {
      throw new RunnerOperationError("opencode session identity conflict", {
        delivery: "unknown", ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
        diagnostic: `session ${id} exists with a different agent, model, parent or run binding`,
      })
    }
    // A child is created at its parent's location regardless of the
    // requested one; moving it before the first prompt is what makes the
    // agent run (and load plugins/skills) in the step's directory.
    if (input.parentID !== undefined && echo.location?.directory !== input.directory) await this.moveSession(id, input.directory, input.operationId)
    return { id }
  }

  async ensureParentSession(input: { featureId: string; title: string; directory: string }): Promise<{ id: string }> {
    const id = sessionIdForFeature(input.featureId)
    const echo = await this.idempotentWrite("/api/session", {
      id, title: input.title, location: { directory: input.directory },
    }, `feature:${input.featureId}`, input.directory) as { id?: unknown; parentID?: unknown } | null
    if (!echo || echo.id !== id || echo.parentID != null) {
      throw new RunnerOperationError("opencode feature session identity conflict", {
        delivery: "not_sent", diagnostic: `session ${id} exists but is not this feature's root session`,
      })
    }
    return { id }
  }

  private async moveSession(sessionID: string, directory: string, operationId: string | undefined): Promise<void> {
    try {
      await this.idempotentWrite(`/api/session/${encodeURIComponent(sessionID)}/move`, { directory }, operationId ?? sessionID)
    } catch (error) {
      // Nothing has been prompted yet, so no agent work can have started:
      // a failed move is a clean, retryable creation failure.
      throw new RunnerOperationError(`opencode session move to ${directory} failed`, {
        delivery: "not_sent", ...(operationId !== undefined ? { operationId } : {}),
        diagnostic: error instanceof RunnerOperationError ? error.diagnostic : String(error),
      })
    }
  }

  // ---------------------------------------------------------------- prompt

  async prompt(input: Parameters<SessionClient["prompt"]>[0]): Promise<void> {
    const purpose = input.purpose ?? "initial"
    if (input.operationId === undefined) throw new RunnerOperationError("opencode prompt requires an operation id", { delivery: "not_sent" })
    const id = messageIdFor(input.sessionID, purpose, input.operationId)
    const echo = await this.idempotentWrite(`/api/session/${encodeURIComponent(input.sessionID)}/prompt`, { id, text: input.text }, input.operationId) as
      { id?: unknown; payload?: { text?: unknown }; text?: unknown } | null
    const text = echo?.payload?.text ?? echo?.text
    if (!echo || echo.id !== id || text !== input.text) {
      throw new RunnerOperationError("opencode prompt identity conflict", {
        delivery: "unknown", operationId: input.operationId, diagnostic: `message ${id} exists with different text`,
      })
    }
  }

  async note(input: { sessionID: string; text: string }): Promise<void> {
    try {
      await this.request("POST", `/api/session/${encodeURIComponent(input.sessionID)}/synthetic`, { body: { text: input.text, resume: false } })
    } catch (error) {
      throw new RunnerOperationError(`opencode note failed: ${error instanceof Error ? error.message : String(error)}`, { delivery: error instanceof HttpFailure && error.maybeDelivered ? "unknown" : "not_sent" })
    }
  }

  // ---------------------------------------------------------------- status

  async status(sessionID: string): Promise<SessionStatus> {
    try {
      const active = OpencodeSessions.data((await this.request("GET", "/api/session/active")).json) as Record<string, { type?: unknown }> | null
      const entry = active?.[sessionID]
      if (entry) return entry.type === "retry" ? "retry" : "busy"
    } catch {
      return "unknown"
    }
    try {
      await this.request("GET", `/api/session/${encodeURIComponent(sessionID)}`)
      return "idle"
    } catch (error) {
      return error instanceof HttpFailure && error.status === 404 ? "missing" : "unknown"
    }
  }

  async sessionExists(sessionID: string): Promise<boolean> {
    try {
      await this.request("GET", `/api/session/${encodeURIComponent(sessionID)}`)
      return true
    } catch (error) {
      // Only a confirmed not-found proves absence; anything else must not
      // trigger missing-session handling.
      return !(error instanceof HttpFailure && error.status === 404)
    }
  }

  async abort(sessionID: string): Promise<void> {
    try {
      await this.request("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt?resume=false`)
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) return
      throw error
    }
  }
}
