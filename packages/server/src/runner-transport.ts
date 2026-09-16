import type { SessionClient } from "./ports.ts"
import type { RunnerDirectory, RunnerRegistration } from "./runner-registry.ts"

export type RunnerFetch = (request: Request) => Promise<Response>

export interface RunnerSessionClientDeps {
  readonly runners: RunnerDirectory
  readonly fetchImpl?: RunnerFetch
}

export class NoLiveRunnerError extends Error {
  constructor(message = "no live runner available") {
    super(message)
    this.name = "NoLiveRunnerError"
  }
}

function isDefinitivePreConnectFailure(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null
  const code = value?.code ?? value?.cause?.code
  return code === "ConnectionRefused" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN"
}

function routeForDirectory(runners: readonly RunnerRegistration[], directory: string): RunnerRegistration {
  let best = runners[0]!
  let length = -1
  for (const runner of runners) {
    for (const project of runner.projects) {
      const prefix = project.replace(/\/+$/, "")
      if ((directory === prefix || directory.startsWith(`${prefix}/`)) && prefix.length > length) {
        best = runner
        length = prefix.length
      }
    }
  }
  return best
}

export function createRunnerSessionClient(deps: RunnerSessionClientDeps): SessionClient {
  const fetchImpl = deps.fetchImpl ?? (request => fetch(request))
  const owners = new Map<string, string>()
  const remember = (sessionID: string, runner: RunnerRegistration): void => {
    owners.delete(sessionID)
    owners.set(sessionID, runner.id)
    if (owners.size > 1024) owners.delete(owners.keys().next().value!)
  }
  const ordered = (sessionID: string): readonly RunnerRegistration[] => {
    const runners = deps.runners.list()
    const owner = runners.find(runner => runner.id === owners.get(sessionID))
    return owner ? [owner, ...runners.filter(runner => runner !== owner)] : runners
  }
  const call = (runner: RunnerRegistration, method: string, path: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { accept: "application/json" }
    if (runner.token !== undefined) headers.authorization = `Bearer ${runner.token}`
    if (body !== undefined) headers["content-type"] = "application/json"
    return fetchImpl(new Request(`${runner.endpoint}${path}`, {
      method, headers, redirect: "error", signal: AbortSignal.timeout(10_000),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }))
  }
  const json = async (response: Response): Promise<Record<string, unknown>> => {
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null) throw new Error("runner returned a non-object body")
    return body as Record<string, unknown>
  }
  const probe = async (runner: RunnerRegistration): Promise<boolean> => {
    try {
      const response = await call(runner, "GET", "/v1/health")
      if (!response.ok || (await json(response)).ok !== true) throw new NoLiveRunnerError("runner health probe failed")
      return true
    } catch (error) {
      if (isDefinitivePreConnectFailure(error)) {
        deps.runners.markUnreachable(runner)
        return false
      }
      throw new NoLiveRunnerError("runner health probe unavailable; no write sent")
    }
  }
  const write = async (runner: RunnerRegistration, path: string, body?: unknown): Promise<Response | null> => {
    if (!(await probe(runner))) return null
    try {
      return await call(runner, "POST", path, body)
    } catch (error) {
      if (!isDefinitivePreConnectFailure(error)) throw error
      deps.runners.markUnreachable(runner)
      return null
    }
  }
  const sessionWrite = async (sessionID: string, action: string, body?: unknown): Promise<void> => {
    let unavailable = deps.runners.hasUnavailable()
    const runners = ordered(sessionID)
    for (const runner of runners) {
      const response = await write(runner, `/v1/sessions/${encodeURIComponent(sessionID)}/${action}`, body)
      if (response === null) { unavailable = true; continue }
      if (response.status === 404) continue
      if (!response.ok) throw new Error(`runner failed to ${action} (status ${response.status})`)
      remember(sessionID, runner)
      return
    }
    if (action === "abort") return
    if (unavailable || runners.length === 0) throw new NoLiveRunnerError()
    throw new Error(`no registered runner knows session ${sessionID}`)
  }
  const read = async (sessionID: string, action: "status" | "exists"): Promise<unknown> => {
    const runners = ordered(sessionID)
    let uncertain = deps.runners.hasUnavailable() || runners.length === 0
    let found: unknown
    for (const runner of runners) {
      try {
        const response = await call(runner, "GET", `/v1/sessions/${encodeURIComponent(sessionID)}/${action}`)
        if (!response.ok) { uncertain = true; continue }
        const value = (await json(response))[action]
        const valid = action === "exists" ? typeof value === "boolean" : ["busy", "idle", "retry", "missing"].includes(String(value))
        if (!valid) { uncertain = true; continue }
        if (owners.get(sessionID) === runner.id) return value
        if (value === true || value === "busy") return value
        if (value === "retry" || (value === "idle" && found !== "retry")) found = value
      } catch {
        uncertain = true
      }
    }
    if (uncertain) return action === "exists" ? true : "busy"
    return found ?? (action === "exists" ? false : "missing")
  }
  return {
    async createSession(input) {
      let runners = deps.runners.list()
      while (runners.length > 0) {
        const runner = routeForDirectory(runners, input.directory)
        const response = await write(runner, "/v1/sessions", input)
        if (response === null) { runners = runners.filter(candidate => candidate !== runner); continue }
        if (!response.ok) throw new Error(`runner failed to create session (status ${response.status})`)
        const body = await json(response)
        if (typeof body.id !== "string" || body.id === "") throw new Error("runner returned no session id")
        remember(body.id, runner)
        return { id: body.id }
      }
      throw new NoLiveRunnerError()
    },
    prompt: input => sessionWrite(input.sessionID, "prompt", {
      text: input.text,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    }),
    note: input => sessionWrite(input.sessionID, "note", { text: input.text }),
    abort: sessionID => sessionWrite(sessionID, "abort"),
    sessionExists: async sessionID => (await read(sessionID, "exists")) as boolean,
    status: async sessionID => (await read(sessionID, "status")) as "busy" | "idle" | "retry" | "missing",
  }
}
