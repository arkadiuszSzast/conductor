import { describe, expect, it } from "bun:test"
import { RunnerRegistry } from "./src/runner-registry.ts"
import { createRunnerSessionClient, NoLiveRunnerError } from "./src/runner-transport.ts"

const registration = (port: number) => ({ name: "runner", endpoint: `http://localhost:${port}`, token: "secret", projects: ["/project"] })
const refused = () => Object.assign(new Error("refused"), { code: "ConnectionRefused" })

describe("runner liveness", () => {
  it("expires old ports without evicting refreshed same-host runners", () => {
    let now = 0
    const registry = new RunnerRegistry(() => now)
    const old = registry.register(registration(1))
    const live = registry.register(registration(2))
    now = 45_000
    const refresh = registry.register({ ...registration(2), projects: ["/other"] })
    expect(refresh.id).toBe(live.id)
    expect(refresh.projects).toEqual(["/project", "/other"])
    registry.markUnreachable(live)
    expect(registry.list()).toHaveLength(2)
    now = 60_000
    expect(registry.get(old.id)).toBeNull()
    expect(registry.list()).toEqual([refresh])
    now = 105_000
    expect(registry.hasAny()).toBe(false)
    expect(registry.hasUnavailable()).toBe(true)
  })

  it("probes with auth, skips a refused endpoint, and routes writes and reads to the owner", async () => {
    const runners = new RunnerRegistry()
    runners.register(registration(1))
    runners.register(registration(2))
    const calls: string[] = []
    const client = createRunnerSessionClient({ runners, fetchImpl: async request => {
      const url = new URL(request.url)
      calls.push(`${url.port} ${request.method} ${url.pathname}`)
      expect(request.headers.get("authorization")).toBe("Bearer secret")
      if (url.port === "1") throw refused()
      if (url.pathname === "/v1/health") return Response.json({ ok: true })
      if (url.pathname === "/v1/sessions") return Response.json({ id: "session" })
      if (url.pathname.endsWith("/status")) return Response.json({ status: "idle" })
      return Response.json({ ok: true })
    } })
    await client.createSession({ title: "t", directory: "/project" })
    await client.prompt({ sessionID: "session", text: "go" })
    expect(await client.status("session")).toBe("idle")
    expect(runners.list()).toHaveLength(1)
    expect(calls[0]).toBe("1 GET /v1/health")
    expect(calls.filter(call => call.startsWith("1 POST"))).toHaveLength(0)
  })

  for (const operation of ["create", "prompt", "note"] as const) {
    for (const code of ["ECONNRESET", "ETIMEDOUT"]) {
      it(`does not replay ambiguous ${operation} ${code}`, async () => {
        const runners = new RunnerRegistry()
        runners.register(registration(1))
        runners.register(registration(2))
        let posts = 0
        const client = createRunnerSessionClient({ runners, fetchImpl: async request => {
          if (request.method === "GET") return Response.json({ ok: true })
          posts++
          throw Object.assign(new Error(code), { code })
        } })
        const result = operation === "create" ? client.createSession({ title: "t", directory: "/project" })
          : client[operation]({ sessionID: "s", text: "go" })
        await expect(result).rejects.toThrow(code)
        expect(posts).toBe(1)
        expect(runners.list()).toHaveLength(2)
      })
    }
  }

  it("waits without writes on ambiguous or rejected health probes", async () => {
    for (const status of [401, 500, 404]) {
      const runners = new RunnerRegistry()
      runners.register(registration(1))
      let posts = 0
      const client = createRunnerSessionClient({ runners, fetchImpl: async request => {
        if (request.method === "POST") posts++
        return Response.json({}, { status })
      } })
      await expect(client.createSession({ title: "t", directory: "/project" })).rejects.toBeInstanceOf(NoLiveRunnerError)
      expect(posts).toBe(0)
      expect(runners.hasAny()).toBe(true)
    }
  })

  it("retains read uncertainty across repeated reads and eviction", async () => {
    const runners = new RunnerRegistry()
    const dead = runners.register(registration(1))
    runners.register(registration(2))
    const client = createRunnerSessionClient({ runners, fetchImpl: async request => {
      if (new URL(request.url).port === "1") throw refused()
      return Response.json({ exists: false, status: "missing" })
    } })
    expect(await client.sessionExists("unknown")).toBe(true)
    expect(await client.status("unknown")).toBe("busy")
    runners.markUnreachable(dead)
    expect(await client.sessionExists("unknown")).toBe(true)
    expect(await client.status("unknown")).toBe("busy")
  })

  it("treats malformed reads conservatively and all explicit negatives as missing", async () => {
    const runners = new RunnerRegistry()
    runners.register(registration(1))
    let malformed = true
    const client = createRunnerSessionClient({ runners, fetchImpl: async () => malformed
      ? new Response("invalid") : Response.json({ exists: false, status: "missing" }) })
    expect(await client.sessionExists("s")).toBe(true)
    expect(await client.status("s")).toBe("busy")
    malformed = false
    expect(await client.sessionExists("s")).toBe(false)
    expect(await client.status("s")).toBe("missing")
  })

  it("preserves HTTP write errors and all-404 missing-session errors", async () => {
    const runners = new RunnerRegistry()
    runners.register(registration(1))
    let status = 500
    const client = createRunnerSessionClient({ runners, fetchImpl: async request => request.method === "GET"
      ? Response.json({ ok: true }) : Response.json({}, { status }) })
    await expect(client.prompt({ sessionID: "s", text: "go" })).rejects.toThrow("status 500")
    expect(runners.hasAny()).toBe(true)
    status = 404
    await expect(client.note({ sessionID: "s", text: "go" })).rejects.toThrow("no registered runner knows session")
  })
})
