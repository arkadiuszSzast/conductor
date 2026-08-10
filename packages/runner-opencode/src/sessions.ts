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
    get(input: { path: { id: string } }): Promise<{ data?: { id: string } }>
    status(input?: { query?: { directory?: string } }): Promise<{ data?: Record<string, { type: string }> }>
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
  }
}

export function createOpencodeSessions(rawClient: RawOpencodeSessionApi): SessionClient {
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
    async sessionExists(sessionID) {
      try {
        const result = await rawClient.session.get({ path: { id: sessionID } })
        return result.data?.id === sessionID
      } catch {
        return false
      }
    },
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
    async status(sessionID) {
      // /session/status only lists sessions with live activity state; a
      // session absent from the map is idle unless it no longer exists.
      try {
        const result = await rawClient.session.status()
        const entry = result.data?.[sessionID]
        if (entry?.type === "busy") return "busy"
        if (entry?.type === "retry") return "retry"
        if (entry?.type === "idle") return "idle"
        return (await this.sessionExists(sessionID)) ? "idle" : "missing"
      } catch {
        // Status endpoint unavailable → claim busy: the safe direction
        // (never nudge/reap on missing information).
        return "busy"
      }
    },
  }
}
