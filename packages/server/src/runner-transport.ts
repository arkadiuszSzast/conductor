/**
 * Daemon-side half of the runner callback transport: a runtime-neutral
 * `SessionClient` that routes session operations over HTTP to runner
 * endpoints registered in the `RunnerRegistry`. This is the v1
 * same-host topology from the design: the daemon never imports a
 * runtime SDK — a runner (the opencode adapter today) exposes a small
 * authenticated HTTP callback surface and registers its endpoint; the
 * daemon speaks this wire protocol and nothing else.
 *
 * Wire protocol (all JSON, bearer-authenticated with the token the
 * runner supplied at registration):
 *   POST <endpoint>/v1/sessions                {title, directory, parentID?} → 201 {id}
 *   GET  <endpoint>/v1/sessions/:id/status     → 200 {status: busy|idle|retry|missing}
 *   GET  <endpoint>/v1/sessions/:id/exists     → 200 {exists: boolean}
 *   POST <endpoint>/v1/sessions/:id/prompt     {text, agent?, model?} → 200 | 404 unknown session
 *   POST <endpoint>/v1/sessions/:id/note       {text} → 200 | 404 unknown session
 *
 * Safe directions, matching the daemon's stand-in client exactly:
 * with no registered runner (or an unreachable one), `status` claims
 * "busy" and `sessionExists` claims true — in-flight runs are never
 * nudged or reaped on missing information (TTL reaping still applies);
 * `createSession`/`prompt`/`note` fail loudly into the engine's normal
 * step-failure path.
 *
 * Multi-endpoint routing: `createSession` picks the runner whose
 * registered project is the longest path-prefix of the requested
 * directory; a worktree outside every registered project (the default
 * `worktreeDir: ".."` layout) deterministically falls back to the
 * first endpoint in sorted order — NEVER registration order. Reads
 * (`status`/`sessionExists`) aggregate across every endpoint so a
 * session is only "missing" when every runner disavows it; writes
 * (`prompt`/`note`) try endpoints in sorted order and skip the ones
 * that return 404 for the session.
 */

import type { SessionClient } from "./engine/ports.ts"
import type { RunnerDirectory, RunnerRegistration } from "./runner-registry.ts"

export type RunnerFetch = (request: Request) => Promise<Response>

export interface RunnerSessionClientDeps {
  readonly runners: RunnerDirectory
  readonly fetchImpl?: RunnerFetch
}

function isPathPrefix(prefix: string, directory: string): boolean {
  return directory === prefix || directory.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
}

function routeForDirectory(runners: readonly RunnerRegistration[], directory: string): RunnerRegistration {
  let best: RunnerRegistration | null = null
  let bestLength = -1
  for (const runner of runners) {
    for (const project of runner.projects) {
      if (isPathPrefix(project, directory) && project.length > bestLength) {
        best = runner
        bestLength = project.length
      }
    }
  }
  return best ?? runners[0]!
}

export function createRunnerSessionClient(deps: RunnerSessionClientDeps): SessionClient {
  const fetchImpl = deps.fetchImpl ?? (request => fetch(request))

  const call = async (
    runner: RunnerRegistration,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers: Record<string, string> = { accept: "application/json" }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (runner.token !== undefined) headers["authorization"] = `Bearer ${runner.token}`
    return fetchImpl(
      new Request(`${runner.endpoint}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    )
  }

  const readJson = async (response: Response): Promise<Record<string, unknown>> => {
    const parsed: unknown = await response.json()
    if (typeof parsed !== "object" || parsed === null) throw new Error("runner returned a non-object body")
    return parsed as Record<string, unknown>
  }

  return {
    async createSession(input) {
      const runners = deps.runners.list()
      if (runners.length === 0) throw new Error("no runner registered with the daemon")
      const runner = routeForDirectory(runners, input.directory)
      const response = await call(runner, "POST", "/v1/sessions", {
        title: input.title,
        directory: input.directory,
        ...(input.parentID !== undefined ? { parentID: input.parentID } : {}),
      })
      if (!response.ok) {
        throw new Error(`runner ${runner.endpoint} failed to create session (status ${response.status})`)
      }
      const body = await readJson(response)
      if (typeof body.id !== "string" || body.id === "") {
        throw new Error(`runner ${runner.endpoint} returned no session id`)
      }
      return { id: body.id }
    },

    async prompt(input) {
      const runners = deps.runners.list()
      if (runners.length === 0) throw new Error("no runner registered with the daemon")
      for (const runner of runners) {
        const response = await call(runner, "POST", `/v1/sessions/${encodeURIComponent(input.sessionID)}/prompt`, {
          text: input.text,
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
        })
        if (response.status === 404) continue
        if (!response.ok) throw new Error(`runner ${runner.endpoint} failed to prompt (status ${response.status})`)
        return
      }
      throw new Error(`no registered runner knows session ${input.sessionID}`)
    },

    async note(input) {
      const runners = deps.runners.list()
      if (runners.length === 0) throw new Error("no runner registered with the daemon")
      for (const runner of runners) {
        const response = await call(runner, "POST", `/v1/sessions/${encodeURIComponent(input.sessionID)}/note`, {
          text: input.text,
        })
        if (response.status === 404) continue
        if (!response.ok) throw new Error(`runner ${runner.endpoint} failed to post note (status ${response.status})`)
        return
      }
      throw new Error(`no registered runner knows session ${input.sessionID}`)
    },

    async sessionExists(sessionID) {
      const runners = deps.runners.list()
      if (runners.length === 0) return true
      for (const runner of runners) {
        try {
          const response = await call(runner, "GET", `/v1/sessions/${encodeURIComponent(sessionID)}/exists`)
          if (!response.ok) return true
          const body = await readJson(response)
          if (body.exists === true) return true
        } catch {
          // Unreachable runner: claim the session exists — never treat a
          // transport failure as a vanished session.
          return true
        }
      }
      return false
    },

    async status(sessionID) {
      const runners = deps.runners.list()
      if (runners.length === 0) return "busy"
      let sawRetry = false
      let sawIdle = false
      for (const runner of runners) {
        let status: unknown
        try {
          const response = await call(runner, "GET", `/v1/sessions/${encodeURIComponent(sessionID)}/status`)
          if (!response.ok) return "busy"
          status = (await readJson(response)).status
        } catch {
          return "busy"
        }
        if (status === "busy") return "busy"
        if (status === "retry") sawRetry = true
        else if (status === "idle") sawIdle = true
        else if (status !== "missing") return "busy"
      }
      if (sawRetry) return "retry"
      if (sawIdle) return "idle"
      return "missing"
    },
  }
}
