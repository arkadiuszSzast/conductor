/**
 * `SessionClient` over the opencode SDK client — extracted verbatim
 * from the seed plugin's session transport. The adapter keeps the
 * engine's runtime-neutral `SessionClient` shape on one side and the
 * opencode wire shape on the other; no SDK type crosses the boundary.
 *
 * `RawOpencodeSessionApi` is the structural surface the adapter needs
 * from `PluginInput.client` — the same narrowing the seed performed, so
 * SDK version drift in unrelated endpoints cannot break the adapter.
 */

import type { SessionClient } from "@conductor/server"

export interface RawOpencodeSessionApi {
  session: {
    create(input: {
      body: { title?: string; parentID?: string }
      query?: { directory?: string }
    }): Promise<{ data?: { id: string } }>
    /**
     * The opencode SDK client (`responseStyle: "fields"`, the default —
     * see `@opencode-ai/sdk`'s generated client) does NOT throw on an
     * HTTP error response by default: a 404/500/etc. resolves normally
     * as `{ error, request, response }` with `data` undefined and
     * `response.status` carrying the real HTTP status. Only a genuine
     * transport failure (network down, DNS) rejects the promise. Both
     * `error` and `response` are exposed here (not just `data`) so the
     * adapter can distinguish a confirmed-gone 404 from every other
     * non-throwing failure shape instead of collapsing them all into
     * "missing".
     */
    get(input: { path: { id: string } }): Promise<{
      data?: { id: string; directory?: string }
      error?: unknown
      response?: { status: number }
    }>
    status(input?: { query?: { directory?: string } }): Promise<{ data?: Record<string, { type: string }> }>
    messages(input: {
      path: { id: string }
      query?: { directory?: string; limit?: number }
    }): Promise<{ data?: Array<{ info?: { role?: string; time?: { completed?: number } }; parts?: Array<{ type?: string; state?: { status?: string } }> }> }>
    promptAsync(input: {
      path: { id: string }
      query?: { directory?: string }
      body: {
        agent?: string
        model?: { providerID: string; modelID: string }
        noReply?: boolean
        parts: Array<{ type: string; text: string }>
      }
    }): Promise<unknown>
    abort(input: { path: { id: string }; query?: { directory?: string } }): Promise<unknown>
  }
}

/**
 * `session.get`'s outcome, three-valued rather than the two-valued
 * "found or null" the SDK's `data` field alone can express: a
 * non-throwing SDK call (`throwOnError` is off by default — see
 * `RawOpencodeSessionApi.get`'s doc comment) resolves to `data:
 * undefined` for EVERY HTTP error, 404 included but also 500, 429, a
 * malformed upstream body, anything. Collapsing all of those to "gone"
 * (as a naive `!result.data` check would) means a transient 5xx or a
 * momentary network hiccup gets reported exactly like a confirmed-
 * deleted session — the daemon would reap/recreate a perfectly live
 * run's session on a blip. Only an explicit 404 (`NotFoundError`, or
 * `response.status === 404` as the version-tolerant fallback) proves
 * the session is actually gone; every other non-2xx/thrown outcome is
 * "unknown" and must be treated as "might still be live".
 */
type SessionLookup =
  | { readonly kind: "found"; readonly session: { id: string; directory?: string } }
  | { readonly kind: "not_found" }
  | { readonly kind: "unknown" }

export function createOpencodeSessions(rawClient: RawOpencodeSessionApi): SessionClient {
  async function lookupSession(sessionID: string): Promise<SessionLookup> {
    let result: Awaited<ReturnType<RawOpencodeSessionApi["session"]["get"]>>
    try {
      result = await rawClient.session.get({ path: { id: sessionID } })
    } catch {
      // A thrown promise is a transport failure (network down, DNS),
      // never an HTTP error — the SDK reports those via `error`/
      // `response`, not by rejecting. Unknown, not confirmed-gone.
      return { kind: "unknown" }
    }
    if (result.data?.id === sessionID) return { kind: "found", session: result.data }
    const name = (result.error as { name?: unknown } | undefined)?.name
    if (result.response?.status === 404 || name === "NotFoundError") return { kind: "not_found" }
    return { kind: "unknown" }
  }
  /**
   * True only once the session is confirmed either live OR unknown
   * (transient failure) — false requires a confirmed 404. Mirrors
   * `status`'s "never mistake transient for gone" rule: the callers
   * (parent-session recreation, the hub's prompt/note/abort 404 gate)
   * would otherwise treat a 500 identically to a deleted session.
   */
  async function sessionExists(sessionID: string): Promise<boolean> {
    return (await lookupSession(sessionID)).kind !== "not_found"
  }

  return {
    async createSession(args) {
      // `directory` is a QUERY parameter on /session (the body silently
      // drops it). Getting this wrong routes the step session into the
      // daemon-owner's project — the multi-project failure mode where a
      // gloam feature's implementer works inside conductor-test.
      const result = await rawClient.session.create({
        body: {
          title: args.title,
          ...(args.parentID !== undefined ? { parentID: args.parentID } : {}),
        },
        query: { directory: args.directory },
      })
      const id = result.data?.id
      if (!id) throw new Error("session.create returned no id")
      return { id }
    },
    async prompt(args) {
      const model = args.model?.includes("/")
        ? {
            providerID: args.model.slice(0, args.model.indexOf("/")),
            modelID: args.model.slice(args.model.indexOf("/") + 1),
          }
        : undefined
      await rawClient.session.promptAsync({
        path: { id: args.sessionID },
        body: {
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(model !== undefined ? { model } : {}),
          parts: [{ type: "text", text: args.text }],
        },
      })
    },
    sessionExists,
    async note(args) {
      // noReply: append the message to the session without triggering
      // inference — a pure timeline entry, zero tokens spent.
      await rawClient.session.promptAsync({
        path: { id: args.sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: args.text }],
        },
      })
    },
    async abort(sessionID) {
      // Best-effort by the port contract: a session that is already
      // finished or gone aborts as a no-op success — only a live
      // transport failure propagates (and the engine logs, never blocks).
      if (!(await sessionExists(sessionID))) return
      await rawClient.session.abort({ path: { id: sessionID } })
    },
    async status(sessionID) {
      const lookup = await lookupSession(sessionID)
      if (lookup.kind === "not_found") return "missing"
      // "unknown" (transient error, no evidence either way) claims busy —
      // the same safe direction as an unreachable status/timeline below:
      // never nudge/reap/recreate on missing information.
      if (lookup.kind === "unknown") return "busy"
      const session = lookup.session
      try {
        const result = await rawClient.session.status({ query: { directory: session.directory } })
        const entry = result.data?.[sessionID]
        if (entry?.type === "busy") return "busy"
        if (entry?.type === "retry") return "retry"
        if (entry?.type === "idle") return "idle"
        try {
          const messages = await rawClient.session.messages({
            path: { id: sessionID },
            query: { directory: session.directory, limit: 5 },
          })
          // No data at all, OR a bounded-but-empty page: neither carries
          // any evidence of a completed assistant turn, and a live
          // session (this branch only runs once `lookupSession` above
          // confirmed the session exists) that has been prompted always
          // has at least one message — an empty page here is itself
          // suspicious (endpoint lag, a fetch that silently dropped
          // rows), not proof of "never started". Same safe direction as
          // every other missing-evidence branch in this function.
          if (!messages.data || messages.data.length === 0) return "busy"
          const last = messages.data.findLast(message => message.info?.role === "assistant")
          // Every message is a user message (no assistant turn at all in
          // this bounded window) — a trailing user nudge must never be
          // read as "idle": the design.md scenario this guards is a
          // user-only fallback window hiding an unfinished assistant
          // turn that simply scrolled outside the `limit: 5` page.
          if (!last) return "busy"
          if (typeof last.info?.time?.completed !== "number" || last.parts?.some(part =>
            part.type === "tool" && (part.state?.status === "pending" || part.state?.status === "running"),
          )) return "busy"
        } catch {
          // Timeline unreachable → claim busy: the safe direction
          // (never nudge/reap on missing information).
          return "busy"
        }
        return "idle"
      } catch {
        return "busy"
      }
    },
  }
}
