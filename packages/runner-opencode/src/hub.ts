/**
 * Process-wide runner hub — the adapter's replacement for the seed's
 * in-process daemon singleton. One opencode process serves many project
 * directories (one plugin instance each); the hub owns the ONE callback
 * listener those instances share and keeps the daemon's view of this
 * runner current.
 *
 * Unlike the seed's singleton, NOTHING here depends on registration
 * order: the callback bind and auth come from the environment (identical
 * for every instance), every project registration re-registers with the
 * daemon (the daemon upserts by endpoint and unions the project list),
 * and session routing picks the serving project by longest path-prefix
 * over a SORTED project map — never "whoever registered first".
 *
 * The hub is transport only: no SQLite, no interpreter, no reconciler.
 * Its HTTP surface is the runner callback protocol the daemon's
 * `createRunnerSessionClient` speaks:
 *   POST /v1/sessions                  {title, directory, parentID?} → 201 {id}
 *   GET  /v1/sessions/:id/status       → 200 {status}
 *   GET  /v1/sessions/:id/exists       → 200 {exists}
 *   POST /v1/sessions/:id/prompt       {text, agent?, model?} → 200 | 404
 *   POST /v1/sessions/:id/note         {text} → 200 | 404
 * Auth is explicit even on localhost: bearer when the operator set
 * `CONDUCTOR_RUNNER_TOKEN`, or the written-down `CONDUCTOR_RUNNER_AUTH=none`.
 */

import { timingSafeEqual } from "node:crypto"
import type { SessionClient } from "@conductor/server"
import type { RunnerCallbackAuth, RunnerConfig } from "./config.ts"

export type CallbackHandler = (request: Request) => Promise<Response>

export interface CallbackListener {
  readonly hostname: string
  readonly port: number
  stop(): Promise<void>
}

/** Listener binding as an injectable port so tests run socketless. */
export type ListenFn = (host: string, port: number, handler: CallbackHandler) => CallbackListener

export type DaemonFetch = (request: Request) => Promise<Response>

export interface RunnerHubDeps {
  /** Transport to the DAEMON's API (registration). Injectable for tests. */
  readonly daemonFetch?: DaemonFetch
  /** Callback listener binding. Injectable for tests. */
  readonly listen?: ListenFn
  readonly log?: (message: string) => void
  /** Re-announce interval in ms; 0 disables the loop (tests drive announces manually). */
  readonly reannounceMs?: number
  readonly setInterval?: typeof globalThis.setInterval
  readonly clearInterval?: typeof globalThis.clearInterval
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function authorized(auth: RunnerCallbackAuth, request: Request): boolean {
  if (auth.mode === "none") return true
  const header = request.headers.get("authorization")
  if (header === null || !header.startsWith("Bearer ")) return false
  const presented = Buffer.from(header.slice("Bearer ".length))
  const expected = Buffer.from(auth.token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function isPathPrefix(prefix: string, directory: string): boolean {
  return directory === prefix || directory.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
}

/** Bound on the session→run attribution map — evicted oldest-first. */
const MAX_SESSION_RUN_IDS = 1024

/** How often the hub re-POSTs its registration. The daemon's registry is
 *  in-memory and starts empty after a restart; periodic re-announce heals
 *  that gap without operator intervention (registration is an upsert, so
 *  steady-state re-announces are no-ops server-side). */
const DEFAULT_REANNOUNCE_MS = 15_000

export const bunListen: ListenFn = (host, port, handler) => {
  const server = Bun.serve({ hostname: host, port, idleTimeout: 0, fetch: handler })
  return {
    hostname: server.hostname ?? host,
    port: server.port ?? port,
    async stop() {
      await server.stop(true)
    },
  }
}

export class OpencodeRunnerHub {
  /** projectDir → that instance's session transport. Sorted iteration everywhere. */
  private readonly projects = new Map<string, SessionClient>()
  /** sessionID → the conductor run the daemon created it for (optional hint). */
  private readonly sessionRunIds = new Map<string, string>()
  private listener: CallbackListener | null = null
  private runnerId: string | null = null
  private stopped = false
  private reannounceTimer: ReturnType<typeof globalThis.setInterval> | null = null

  private readonly daemonFetch: DaemonFetch
  private readonly listen: ListenFn
  private readonly log: (message: string) => void
  private readonly reannounceMs: number
  private readonly setIntervalFn: typeof globalThis.setInterval
  private readonly clearIntervalFn: typeof globalThis.clearInterval

  constructor(
    private readonly config: RunnerConfig,
    deps: RunnerHubDeps = {},
  ) {
    this.daemonFetch = deps.daemonFetch ?? (request => fetch(request))
    this.listen = deps.listen ?? bunListen
    this.log = deps.log ?? (() => {})
    this.reannounceMs = deps.reannounceMs ?? DEFAULT_REANNOUNCE_MS
    this.setIntervalFn = deps.setInterval ?? globalThis.setInterval.bind(globalThis)
    this.clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis)
  }

  /** The callback handler — exposed for socketless tests. */
  readonly handle: CallbackHandler = async request => {
    try {
      return await this.route(request)
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * Register a project instance's session transport and (re-)announce
   * this runner to the daemon. Idempotent per directory; every call
   * re-POSTs the full sorted project list — the daemon upserts by
   * endpoint, so concurrent instances converge regardless of order.
   */
  async registerProject(directory: string, sessions: SessionClient): Promise<void> {
    if (this.stopped) throw new Error("runner hub is stopped")
    // Bind the listener BEFORE recording the project: a failed bind
    // (port taken) must not leave a half-registered directory behind.
    if (!this.listener) {
      this.listener = this.listen(this.config.callbackHost, this.config.callbackPort, this.handle)
      this.log(`runner callback listening on ${this.listener.hostname}:${this.listener.port}`)
    }
    this.projects.set(directory, sessions)
    await this.announce()
    // A daemon restart wipes its in-memory runner registry; the loop
    // re-announces until stop() so the gap heals itself. Failures are
    // logged and retried on the next tick — the daemon may simply be
    // down for a deploy.
    if (this.reannounceTimer === null && this.reannounceMs > 0) {
      this.reannounceTimer = this.setIntervalFn(() => {
        void this.announce().catch(err => {
          this.log(`runner re-announce failed (will retry): ${err instanceof Error ? err.message : String(err)}`)
        })
      }, this.reannounceMs)
      if (typeof (this.reannounceTimer as { unref?: () => void }).unref === "function") {
        ;(this.reannounceTimer as unknown as { unref: () => void }).unref()
      }
    }
  }

  /** Deregister from the daemon and stop the callback listener. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.reannounceTimer !== null) {
      this.clearIntervalFn(this.reannounceTimer)
      this.reannounceTimer = null
    }
    if (this.runnerId !== null) {
      try {
        await this.callDaemon("DELETE", `/v1/runners/${encodeURIComponent(this.runnerId)}`)
      } catch (err) {
        this.log(`runner deregistration failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.runnerId = null
    }
    if (this.listener) {
      await this.listener.stop()
      this.listener = null
    }
  }

  get endpoint(): string | null {
    if (!this.listener) return null
    return `http://${this.listener.hostname}:${this.listener.port}`
  }

  get registeredProjects(): readonly string[] {
    return [...this.projects.keys()].sort()
  }

  /**
   * The conductor run id a session was created for, when the daemon
   * supplied the hint on session create. Absent for parent/other
   * sessions — callers (agent-log push) treat that as "not mapped".
   */
  runIdForSession(sessionID: string): string | undefined {
    return this.sessionRunIds.get(sessionID)
  }

  private async announce(): Promise<void> {
    const endpoint = this.endpoint
    if (endpoint === null) throw new Error("runner hub has no listener")
    const response = await this.callDaemon("POST", "/v1/runners", {
      name: "opencode",
      endpoint,
      ...(this.config.callbackAuth.mode === "bearer" ? { token: this.config.callbackAuth.token } : {}),
      projects: this.registeredProjects,
    })
    if (!response.ok) {
      throw new Error(`daemon rejected runner registration (status ${response.status})`)
    }
    const body = (await response.json()) as { runner?: { id?: string } }
    const previousId = this.runnerId
    if (typeof body.runner?.id === "string") this.runnerId = body.runner.id
    if (this.runnerId !== previousId) {
      this.log(`runner registered with daemon as ${this.runnerId ?? "?"} (${this.registeredProjects.length} project(s))`)
    }
  }

  private callDaemon(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (this.config.daemonToken !== undefined) headers["authorization"] = `Bearer ${this.config.daemonToken}`
    return this.daemonFetch(
      new Request(`${this.config.daemonUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    )
  }

  // ------------------------------------------------------------- routing

  /**
   * Session transport for a directory: the project whose path is the
   * longest prefix wins (a worktree UNDER a registered project routes to
   * that project); a directory outside every project — the default
   * `worktreeDir: ".."` layout — falls back to the first project in
   * sorted order. Every instance's transport talks to the same opencode
   * server, so the fallback choice only needs to be deterministic.
   */
  private sessionsForDirectory(directory: string): SessionClient | null {
    const sorted = [...this.projects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    if (sorted.length === 0) return null
    let best: SessionClient | null = null
    let bestLength = -1
    for (const [projectDir, sessions] of sorted) {
      if (isPathPrefix(projectDir, directory) && projectDir.length > bestLength) {
        best = sessions
        bestLength = projectDir.length
      }
    }
    return best ?? sorted[0]![1]
  }

  private anySessions(): readonly SessionClient[] {
    return [...this.projects.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, sessions]) => sessions)
  }

  private async route(request: Request): Promise<Response> {
    if (!authorized(this.config.callbackAuth, request)) {
      return json(401, { error: "missing or invalid bearer token" })
    }
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, "")
    const method = request.method.toUpperCase()

    if (path === "/v1/sessions" && method === "POST") {
      const body = (await request.json()) as { title?: unknown; directory?: unknown; parentID?: unknown; runId?: unknown }
      if (typeof body.title !== "string" || typeof body.directory !== "string") {
        return json(400, { error: "\"title\" and \"directory\" are required strings" })
      }
      if (body.parentID !== undefined && typeof body.parentID !== "string") {
        return json(400, { error: "\"parentID\" must be a string" })
      }
      if (body.runId !== undefined && typeof body.runId !== "string") {
        return json(400, { error: "\"runId\" must be a string" })
      }
      const sessions = this.sessionsForDirectory(body.directory)
      if (!sessions) return json(503, { error: "no project registered with this runner" })
      const created = await sessions.createSession({
        title: body.title,
        directory: body.directory,
        ...(body.parentID !== undefined ? { parentID: body.parentID } : {}),
      })
      // Remember the run attribution for the plugin's agent-log push.
      // The hint is optional end-to-end; when absent no mapping is kept
      // and no push happens for this session. The map is bounded: beyond
      // the cap the oldest entries (insertion order = session-creation
      // order) are evicted — those sessions' runs have long concluded.
      if (body.runId !== undefined) {
        this.sessionRunIds.set(created.id, body.runId)
        while (this.sessionRunIds.size > MAX_SESSION_RUN_IDS) {
          const oldest = this.sessionRunIds.keys().next().value
          if (oldest === undefined) break
          this.sessionRunIds.delete(oldest)
        }
      }
      return json(201, { id: created.id })
    }

    const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)\/(status|exists|prompt|note)$/)
    if (sessionMatch) {
      const sessionID = decodeURIComponent(sessionMatch[1]!)
      const action = sessionMatch[2]!
      const all = this.anySessions()
      if (all.length === 0) return json(503, { error: "no project registered with this runner" })
      // Every instance's transport reaches the same opencode server —
      // the sorted-first transport answers for any session id.
      const sessions = all[0]!

      if (action === "status" && method === "GET") {
        return json(200, { status: await sessions.status(sessionID) })
      }
      if (action === "exists" && method === "GET") {
        return json(200, { exists: await sessions.sessionExists(sessionID) })
      }
      if (action === "prompt" && method === "POST") {
        const body = (await request.json()) as { text?: unknown; agent?: unknown; model?: unknown }
        if (typeof body.text !== "string") return json(400, { error: "\"text\" is required" })
        if (!(await sessions.sessionExists(sessionID))) return json(404, { error: `unknown session "${sessionID}"` })
        await sessions.prompt({
          sessionID,
          text: body.text,
          ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
          ...(typeof body.model === "string" ? { model: body.model } : {}),
        })
        return json(200, { ok: true })
      }
      if (action === "note" && method === "POST") {
        const body = (await request.json()) as { text?: unknown }
        if (typeof body.text !== "string") return json(400, { error: "\"text\" is required" })
        if (!(await sessions.sessionExists(sessionID))) return json(404, { error: `unknown session "${sessionID}"` })
        await sessions.note({ sessionID, text: body.text })
        return json(200, { ok: true })
      }
    }

    return json(404, { error: `no route for ${method} ${path}` })
  }
}
