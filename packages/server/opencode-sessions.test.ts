import { describe, expect, it } from "bun:test"
import { RunnerOperationError } from "./src/ports.ts"
import { OpencodeSessions, deterministicId, messageIdFor, sessionIdForFeature, sessionIdForRun } from "./src/opencode/sessions.ts"
import { resolveModelSelection, splitModelRef } from "./src/opencode/config.ts"

interface FakeOptions {
  coldCatalogPolls?: number
  pluginActive?: boolean
  dropCreateResponses?: number
  dropPromptResponses?: number
  refuse?: boolean
  failMove?: boolean
}

function fakeServer(options: FakeOptions = {}) {
  const sessions = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, Record<string, unknown>>()
  const active = new Map<string, string>()
  const requests: { method: string; path: string; auth: string | null; body: unknown }[] = []
  let catalogPolls = 0
  let dropCreate = options.dropCreateResponses ?? 0
  let dropPrompt = options.dropPromptResponses ?? 0
  const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } })
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const body = request.method === "POST" && request.headers.get("content-type") ? await request.json() as Record<string, unknown> : undefined
    requests.push({ method: request.method, path: url.pathname + url.search, auth: request.headers.get("authorization"), body })
    if (options.refuse) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" })
    if (request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:pw").toString("base64")}`) return json(null, 401)
    const path = url.pathname
    if (path === "/api/agent") {
      catalogPolls++
      return json(catalogPolls <= (options.coldCatalogPolls ?? 0) ? [] : [{ id: "build", name: "build" }, { id: "review", name: "review" }])
    }
    if (path === "/api/plugin") return json([{ id: "conductor.report", state: { status: options.pluginActive === false ? "failed" : "active" } }])
    if (path === "/api/model") return json([{ id: "claude/x", providerID: "omni", variants: [{ id: "low" }, { id: "medium" }] }])
    if (path === "/api/session/active") return json(Object.fromEntries([...active].map(([id, type]) => [id, { type }])))
    if (path === "/api/session" && request.method === "POST") {
      const id = String(body!.id)
      // Real v2 behaviour: a child is placed at its parent's location,
      // ignoring the requested one, until it is moved.
      const parent = body!.parentID !== undefined ? sessions.get(String(body!.parentID)) : undefined
      if (!sessions.has(id)) sessions.set(id, { ...body, ...(parent ? { location: parent.location } : {}) })
      if (dropCreate > 0) { dropCreate--; throw new Error("socket closed") }
      return json(sessions.get(id))
    }
    const match = /^\/api\/session\/([^/]+)(\/[a-z]+)?$/.exec(path)
    if (match) {
      const [, id, action] = match
      const session = sessions.get(id!)
      if (!session) return json({ name: "SessionNotFoundError" }, 404)
      if (!action) return json(session)
      if (action === "/prompt") {
        const mid = String(body!.id)
        if (!messages.has(mid)) { messages.set(mid, { id: mid, payload: { text: body!.text } }); active.set(id!, "running") }
        if (dropPrompt > 0) { dropPrompt--; throw new Error("socket closed") }
        return json(messages.get(mid))
      }
      if (action === "/synthetic") return json({ id: "msg_synthetic", resume: body!.resume })
      if (action === "/interrupt") { active.delete(id!); return json(null) }
      if (action === "/move") {
        if (options.failMove) return json(null, 400)
        session.location = { directory: body!.directory }
        return new Response(null, { status: 204 })
      }
    }
    return json(null, 404)
  }
  return { fetch, sessions, messages, active, requests }
}

function client(server: ReturnType<typeof fakeServer>, overrides: Partial<ConstructorParameters<typeof OpencodeSessions>[0]> = {}) {
  let now = 0
  return new OpencodeSessions({
    profileId: "v2",
    baseUrl: "http://fake/",
    password: () => "pw",
    allowedRoots: ["/repo"],
    maxConcurrent: 2,
    activeRuns: () => 0,
    credential: runId => ({ runUrl: "http://daemon", token: `token-${runId}` }),
    fetch: server.fetch,
    sleep: async ms => { now += ms },
    now: () => now,
    deadlines: { startupMs: 2_000 },
    ...overrides,
  })
}

const prepareInput = { projectDir: "/repo", directory: "/repo/wt", agent: "build", model: "omni/claude/x", variant: "medium" }

async function prepared(c: OpencodeSessions, input = prepareInput): Promise<string> {
  const result = await c.prepare(input)
  if (!result.ok) throw new Error(result.diagnostic)
  return result.reservationId
}

describe("opencode ids and selection", () => {
  it("derives stable, grammar-valid ids", () => {
    const id = sessionIdForRun("run-1")
    expect(id).toMatch(/^ses_c[0-9A-Za-z]{25}$/)
    expect(sessionIdForRun("run-1")).toBe(id)
    expect(sessionIdForRun("run-2")).not.toBe(id)
    expect(messageIdFor(id, "initial", "op")).toMatch(/^msg_c[0-9A-Za-z]{25}$/)
    expect(messageIdFor(id, "nudge", "op")).not.toBe(messageIdFor(id, "initial", "op"))
    expect(deterministicId("ses", "x")).toBe(deterministicId("ses", "x"))
  })

  it("resolves role first, binding second", () => {
    expect(resolveModelSelection({ agent: "a", variant: "low" }, { model: "p/m", variant: "medium" })).toEqual({ model: "p/m", variant: "low" })
    expect(resolveModelSelection({ agent: "a", model: "p/r" }, undefined)).toEqual({ model: "p/r" })
    expect(splitModelRef("omni/claude/x")).toEqual({ providerID: "omni", id: "claude/x" })
    expect(splitModelRef("nomodel")).toBeNull()
  })
})

describe("OpencodeSessions.prepare", () => {
  it("retries a cold agent catalog, then reserves", async () => {
    const server = fakeServer({ coldCatalogPolls: 3 })
    const result = await client(server).prepare(prepareInput)
    expect(result.ok).toBe(true)
    expect(server.requests.filter(r => r.path.startsWith("/api/agent"))).toHaveLength(4)
    expect(server.requests[0]!.path).toContain("location%5Bdirectory%5D=%2Frepo%2Fwt")
  })

  it("reports a catalog that never loads as unavailable", async () => {
    const result = await client(fakeServer({ coldCatalogPolls: 1_000 })).prepare(prepareInput)
    expect(result).toMatchObject({ ok: false, reason: "unavailable" })
  })

  it("rejects unknown agent, model and variant as incompatible", async () => {
    const c = client(fakeServer())
    expect(await c.prepare({ ...prepareInput, agent: "ghost" })).toMatchObject({ ok: false, reason: "incompatible" })
    expect(await c.prepare({ ...prepareInput, model: "omni/other" })).toMatchObject({ ok: false, reason: "incompatible" })
    const variant = await c.prepare({ ...prepareInput, variant: "xhigh" })
    expect(variant).toMatchObject({ ok: false, reason: "incompatible" })
    if (!variant.ok) expect(variant.diagnostic).toContain("low, medium")
    expect(await c.prepare({ ...prepareInput, model: undefined })).toMatchObject({ ok: false, reason: "incompatible" })
  })

  it("requires the reporting plugin to be active", async () => {
    const result = await client(fakeServer({ pluginActive: false })).prepare(prepareInput)
    expect(result).toMatchObject({ ok: false, reason: "incompatible" })
  })

  it("refuses directories outside allowed roots without contacting the server", async () => {
    const server = fakeServer()
    expect(await client(server).prepare({ ...prepareInput, directory: "/elsewhere" })).toMatchObject({ ok: false, reason: "incompatible" })
    expect(server.requests).toHaveLength(0)
  })

  it("enforces the concurrency limit including reservations", async () => {
    const c = client(fakeServer(), { activeRuns: () => 1 })
    await prepared(c)
    expect(await c.prepare(prepareInput)).toMatchObject({ ok: false, reason: "unavailable" })
  })

  it("never sends the password anywhere but the auth header", async () => {
    const server = fakeServer()
    await prepared(client(server))
    for (const request of server.requests) expect(request.path).not.toContain("pw")
  })
})

describe("OpencodeSessions.createSession / prompt", () => {
  it("creates with the full model selection and session-bound credential", async () => {
    const server = fakeServer()
    const c = client(server)
    const { id } = await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op-create" })
    expect(id).toBe(sessionIdForRun("run-1"))
    expect(server.sessions.get(id)).toMatchObject({
      agent: "build",
      model: { providerID: "omni", id: "claude/x", variant: "medium" },
      metadata: { conductor: { runId: "run-1", runUrl: "http://daemon", token: "token-run-1" } },
    })
  })

  it("replays a lost create response without a second session", async () => {
    const server = fakeServer({ dropCreateResponses: 1 })
    const c = client(server)
    const { id } = await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    expect(server.sessions.size).toBe(1)
    expect(server.requests.filter(r => r.path.startsWith("/api/session?"))).toHaveLength(2)
    expect(id).toBe(sessionIdForRun("run-1"))
  })

  it("fences when the replay echoes a different binding", async () => {
    const server = fakeServer()
    server.sessions.set(sessionIdForRun("run-1"), { id: sessionIdForRun("run-1"), agent: "review", model: { providerID: "omni", id: "claude/x" }, metadata: { conductor: { runId: "run-1" } } })
    const c = client(server)
    const error = await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op" }).catch(e => e)
    expect(error).toBeInstanceOf(RunnerOperationError)
    expect((error as RunnerOperationError).delivery).toBe("unknown")
  })

  it("groups a step session under the feature root and moves it to the step directory", async () => {
    const server = fakeServer()
    const c = client(server)
    const root = await c.ensureParentSession({ featureId: "feat-1", title: "[conductor] f", directory: "/repo" })
    expect(root.id).toBe(sessionIdForFeature("feat-1"))
    expect((await c.ensureParentSession({ featureId: "feat-1", title: "[conductor] f", directory: "/repo" })).id).toBe(root.id)
    expect(server.sessions.size).toBe(1)
    const { id } = await c.createSession({ title: "t", directory: "/repo/wt", parentID: root.id, runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    expect(server.sessions.get(id)).toMatchObject({ parentID: root.id, location: { directory: "/repo/wt" } })
    const moves = server.requests.filter(r => r.path.endsWith("/move"))
    expect(moves).toHaveLength(1)
    expect(moves[0]!.body).toEqual({ directory: "/repo/wt" })
    expect(server.requests.findIndex(r => r.path.endsWith("/move"))).toBeGreaterThan(server.requests.findIndex(r => r.body !== undefined && (r.body as { id?: unknown }).id === id))
  })

  it("does not move a child that already sits in the step directory", async () => {
    const server = fakeServer()
    const c = client(server)
    const root = await c.ensureParentSession({ featureId: "feat-1", title: "f", directory: "/repo/wt" })
    await c.createSession({ title: "t", directory: "/repo/wt", parentID: root.id, runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    expect(server.requests.filter(r => r.path.endsWith("/move"))).toHaveLength(0)
  })

  it("reports a failed move as not_sent so the step can retry", async () => {
    const server = fakeServer({ failMove: true })
    const c = client(server)
    const root = await c.ensureParentSession({ featureId: "feat-1", title: "f", directory: "/repo" })
    const error = await c.createSession({ title: "t", directory: "/repo/wt", parentID: root.id, runId: "run-1", reservationId: await prepared(c), operationId: "op" }).catch(e => e)
    expect((error as RunnerOperationError).delivery).toBe("not_sent")
    expect(server.requests.filter(r => r.path.includes("/prompt"))).toHaveLength(0)
  })

  it("fences when the replayed step session hangs off a different parent", async () => {
    const server = fakeServer()
    const c = client(server)
    await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    const root = await c.ensureParentSession({ featureId: "feat-1", title: "f", directory: "/repo/wt" })
    const error = await c.createSession({ title: "t", directory: "/repo/wt", parentID: root.id, runId: "run-1", reservationId: await prepared(c), operationId: "op" }).catch(e => e)
    expect((error as RunnerOperationError).delivery).toBe("unknown")
  })

  it("refuses to adopt a child session as a feature root", async () => {
    const server = fakeServer()
    server.sessions.set(sessionIdForFeature("feat-1"), { id: sessionIdForFeature("feat-1"), parentID: "ses_other" })
    const error = await client(server).ensureParentSession({ featureId: "feat-1", title: "f", directory: "/repo" }).catch(e => e)
    expect(error).toBeInstanceOf(RunnerOperationError)
  })

  it("reports an unreachable server as not_sent", async () => {
    const server = fakeServer()
    const c = client(server)
    const reservationId = await prepared(c)
    const refusing = fakeServer({ refuse: true })
    const down = client(refusing)
    ;(down as unknown as { reservations: Map<string, unknown> }).reservations.set(reservationId, (c as unknown as { reservations: Map<string, unknown> }).reservations.get(reservationId))
    const error = await down.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId, operationId: "op" }).catch(e => e)
    expect((error as RunnerOperationError).delivery).toBe("not_sent")
  })

  it("rejects a create without a valid reservation", async () => {
    const error = await client(fakeServer()).createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: "nope" }).catch(e => e)
    expect((error as RunnerOperationError).delivery).toBe("not_sent")
  })

  it("prompts with a deterministic message id and no model, replaying lost responses", async () => {
    const server = fakeServer({ dropPromptResponses: 1 })
    const c = client(server)
    const { id } = await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    await c.prompt({ sessionID: id, text: "do it", agent: "build", model: "omni/claude/x", operationId: "op-prompt", purpose: "initial" })
    expect(server.messages.size).toBe(1)
    const sent = server.requests.filter(r => r.path.endsWith("/prompt"))
    expect(sent).toHaveLength(2)
    expect(sent[0]!.body).toEqual({ id: messageIdFor(id, "initial", "op-prompt"), text: "do it" })
  })

  it("fences when a replayed message id carries different text", async () => {
    const server = fakeServer()
    const c = client(server)
    const { id } = await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    await c.prompt({ sessionID: id, text: "first", agent: "build", operationId: "op-prompt" })
    const error = await c.prompt({ sessionID: id, text: "second", agent: "build", operationId: "op-prompt" }).catch(e => e)
    expect((error as RunnerOperationError).delivery).toBe("unknown")
  })
})

describe("OpencodeSessions status / abort / note", () => {
  it("maps active, idle and missing sessions", async () => {
    const server = fakeServer()
    const c = client(server)
    const { id } = await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    expect(await c.status(id)).toBe("idle")
    server.active.set(id, "running")
    expect(await c.status(id)).toBe("busy")
    server.active.set(id, "retry")
    expect(await c.status(id)).toBe("retry")
    expect(await c.status("ses_missing")).toBe("missing")
    expect(await c.sessionExists("ses_missing")).toBe(false)
    expect(await c.sessionExists(id)).toBe(true)
    expect(await client(fakeServer({ refuse: true })).status(id)).toBe("unknown")
    expect(await client(fakeServer({ refuse: true })).sessionExists(id)).toBe(true)
  })

  it("aborts idempotently and notes without resuming", async () => {
    const server = fakeServer()
    const c = client(server)
    const { id } = await c.createSession({ title: "t", directory: "/repo/wt", runId: "run-1", reservationId: await prepared(c), operationId: "op" })
    server.active.set(id, "running")
    await c.abort(id)
    await c.abort(id)
    await c.abort("ses_missing")
    expect(server.active.has(id)).toBe(false)
    expect(server.requests.filter(r => r.path.includes("/interrupt?resume=false"))).toHaveLength(3)
    await c.note({ sessionID: id, text: "fyi" })
    expect(server.requests.find(r => r.path.endsWith("/synthetic"))!.body).toEqual({ text: "fyi", resume: false })
  })
})

describe("composed opencode runners", () => {
  it("expose feature-session grouping, routed by the project's profile", async () => {
    const { composeOpencodeRunners } = await import("./src/runner-router.ts")
    const { openMigratedDatabase } = await import("./src/database.ts")
    const { Store } = await import("./src/store.ts")
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const directory = mkdtempSync(join(tmpdir(), "opencode-router-"))
    const db = openMigratedDatabase({ path: join(directory, "state.db") })
    try {
      const server = fakeServer()
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => server.fetch(new Request(input as string, init))) as typeof fetch
      try {
        const { sessions } = composeOpencodeRunners({
          default: "native",
          projects: { "/repo": "v2" },
          acp: {},
          opencode: { v2: { baseUrl: "http://fake/", passwordEnv: "PW", allowedRoots: ["/repo"], maxConcurrent: 2, bindings: {} } },
        }, new Store(db.db), { now: () => 0 } as never, () => "http://daemon", { PW: "pw" })
        expect(sessions.ensureParentSession).toBeDefined()
        const root = await sessions.ensureParentSession!({ featureId: "feat-1", title: "f", directory: "/repo" })
        expect(root.id).toBe(sessionIdForFeature("feat-1"))
        const unrouted = await sessions.ensureParentSession!({ featureId: "feat-2", title: "f", directory: "/elsewhere" }).catch(e => e)
        expect((unrouted as RunnerOperationError).delivery).toBe("not_sent")
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      db.close?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
