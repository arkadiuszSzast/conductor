import { afterEach, describe, expect, it } from "bun:test"
import { openMigratedDatabase } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const directories: string[] = []

const databases: ReturnType<typeof openMigratedDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
import { agent as buildAgent } from "@agentclientprotocol/sdk"
import type { AgentConnection } from "@agentclientprotocol/sdk"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { ManagedSessions, type ManagedSessionsDeps } from "./src/acp/sessions.ts"
import { realAcpProcessSpawner, type AcpProcessExit, type AcpProcessHandle, type AcpProcessSpawner } from "./src/acp/process.ts"
import { sessionCapabilitiesOf } from "./src/ports.ts"

/**
 * A fake `AcpProcessSpawner` that, instead of launching a real OS
 * process, connects a real in-process ACP agent (built with the SDK's
 * own `agent()` builder — a "stable ACP 1" peer) over a byte-level
 * `ndJsonStream`-framed linked pipe. This exercises the ENTIRE
 * `ManagedSessions` stack (connection, framing, session lifecycle,
 * prompt/turn tracking) without ever touching a real OpenCode binary,
 * a provider, or host credentials.
 */
function fakeSpawner(agentFactory: () => ReturnType<typeof buildAgent>, beforeWrite?: (text: string) => Promise<void>): {
  readonly spawner: AcpProcessSpawner
  readonly agentConnections: AgentConnection[]
} {
  const agentConnections: AgentConnection[] = []
  const spawner: AcpProcessSpawner = {
    spawn(_command, _options) {
      // `ManagedSessions.prepare()` wraps `processHandle.stdin/stdout`
      // through `ndJsonStream` itself — this fake spawner must therefore
      // hand back RAW byte streams (never an already-ndJsonStream-wrapped
      // `Stream`), exactly like a real spawned process's stdio would be.
      // The fake agent peer, on the other hand, IS a real ACP `Agent`
      // implementation and needs its OWN message-level `Stream`, built
      // from the SAME underlying raw byte transforms — each raw
      // transform's readable/writable can only be locked ONCE, so
      // `ndJsonStream` is called exactly once per side here (never both
      // sides via a shared helper that locks all four endpoints up front).
      const rawAToB = new TransformStream<Uint8Array, Uint8Array>()
      const rawBToA = new TransformStream<Uint8Array, Uint8Array>()
      const agentSideStream = ndJsonStream(rawBToA.writable, rawAToB.readable)
      const agentConn = agentFactory().connect(agentSideStream)
      agentConnections.push(agentConn)
      let exitResolve: (exit: AcpProcessExit) => void
      const exited = new Promise<AcpProcessExit>(resolve => {
        exitResolve = resolve
      })
      const handle: AcpProcessHandle = {
        // The client writes framed bytes into `rawAToB` (the agent's
        // `ndJsonStream` reads them as its own "stdin" via `b`), and
        // reads the agent's framed bytes back out of `rawBToA` (the
        // agent writes them as its own "stdout" via `b`) — exactly the
        // stdio shape a real spawned child process would present.
        stdin: new WritableStream<Uint8Array>({ async write(bytes) {
          await beforeWrite?.(new TextDecoder().decode(bytes))
          const writer = rawAToB.writable.getWriter()
          try { await writer.write(bytes) } finally { writer.releaseLock() }
        } }),
        stdout: rawBToA.readable,
        recentStderr: () => "",
        signal(_name) {
          agentConn.close()
          exitResolve({ code: 0, signal: null })
        },
        exited,
      }
      return handle
    },
  }
  return { spawner, agentConnections }
}

function cooperativeAgent(options: { readonly stopReason?: "end_turn" | "cancelled"; readonly turnDelayMs?: number } = {}) {
  return () =>
    buildAgent({ name: "fake-cooperative-agent" })
      .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
      .onRequest("session/new", () => ({ modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, sessionId: `sess-${Math.random().toString(36).slice(2)}` }))
      .onRequest("authenticate", () => ({}))
      .onRequest("session/prompt", async () => {
        if (options.turnDelayMs) await new Promise(resolve => setTimeout(resolve, options.turnDelayMs))
        return { stopReason: options.stopReason ?? "end_turn" }
      })
      .onNotification("session/cancel", () => {})

}

function neverRespondingAgent() {
  return buildAgent({ name: "fake-silent-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
    .onRequest("session/new", () => ({ modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, sessionId: "sess-silent" }))
    .onRequest("authenticate", () => ({}))
    .onRequest("session/prompt", () => new Promise(() => {
      // never resolves — simulates a lost/very-long turn response
    }))
    .onNotification("session/cancel", () => {})
}

/** An agent that never answers `session/new` — the lost-create-response
 *  case (D5/D6). */
function neverCreatesSessionAgent() {
  return buildAgent({ name: "fake-silent-create-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
    .onRequest("session/new", () => new Promise(() => {
      // never resolves — simulates a lost session/new response
    }))
    .onRequest("authenticate", () => ({}))
}

/** An agent that requests permission during a prompt turn and never
 *  responds to session/cancel — the "agent ignores cancellation" case
 *  (acp-execution spec). Used to prove bounded termination proceeds
 *  regardless. */
function ignoresCancelAgent() {
  let sessionCancelReceived = 0
  const agent = buildAgent({ name: "fake-stubborn-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
    .onRequest("session/new", () => ({ modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, sessionId: "sess-stubborn" }))
    .onRequest("authenticate", () => ({}))
    .onRequest("session/prompt", () => new Promise(() => {
      // never resolves, even after session/cancel — proves bounded
      // TERM/KILL cleanup does not depend on the agent's cooperation.
    }))
    .onNotification("session/cancel", () => {
      sessionCancelReceived += 1
      // deliberately does not resolve/act on the cancellation
    })
  return { agent, cancelCount: () => sessionCancelReceived }
}

function baseDeps(overrides: Partial<ManagedSessionsDeps> = {}): Omit<ManagedSessionsDeps, "spawner"> {
  const directory = mkdtempSync(join(tmpdir(), "acp-journal-"))
  directories.push(directory)
  const db = openMigratedDatabase({ path: join(directory, "state.db") })
  databases.push(db)
  const store = new Store(db.db)
  const feature = store.createFeature({ title: "fake", slug: "fake", projectDir: "/tmp", workflow: "fake" })
  for (const id of ["run", "a", "b"]) {
    const runId = store.insertRun({ featureId: feature.id, jobId: id, stepId: "work", stepType: "agent", attempt: 1 })
    db.db.run("UPDATE run SET id = ? WHERE id = ?", [id, runId])
    store.bindRunnerTransport({ runId: id, transport: "acp", directory: "/tmp", daemonGeneration: 1 })
  }
  return {
    store,
    generation: 1,
    readiness: { isReady: () => true, markPhase() {} },
    bindings: { build: { mode: "build" } },
    permissions: { allowKinds: [] },
    allowedRoots: ["/tmp"],
    command: "/usr/bin/true",
    args: ["acp"],
    env: {},
    maxConcurrent: 2,
    deadlines: { startupMs: 2000, writeMs: 1000, turnMs: 500, cancelMs: 200, killMs: 200 },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 3.3: SessionClient create/configure/prompt/status/abort
// ---------------------------------------------------------------------------

describe("3.3: ManagedSessions — create/prompt/status lifecycle", () => {
  it("F3 session updates touch durable activity with bounded write frequency", async () => {
    let now = Date.now()
    const { spawner, agentConnections } = fakeSpawner(cooperativeAgent())
    const deps = baseDeps({ activityNow: () => now })
    const sessions = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const remoteId = deps.store.getRunnerBinding("run")!.remoteSessionId!
    const times: number[] = []
    const touch = deps.store.touchRunActivity.bind(deps.store)
    deps.store.touchRunActivity = (id, time) => { times.push(time!); touch(id, time) }
    for (let i = 0; i < 4; i++) {
      now += 2000
      for (let chunk = 0; chunk < 10; chunk++) await agentConnections[0]!.client.notify("session/update", {
        sessionId: remoteId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "not persisted" } },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(times).toHaveLength(4)
    expect((deps.store as Store).getRunById("run")!.timeLastActivity).toBe(now)
    await sessions.stop()
  })
  it("writes agent narrative and tool status from session updates to the run log", async () => {
    const { spawner, agentConnections } = fakeSpawner(cooperativeAgent())
    const base = baseDeps()
    const store = base.store as Store
    const deps = { ...base, runLog: (runId: string, lines: readonly { source: "agent" | "tool"; text: string }[]) => { store.appendRunLog(runId, lines) } }
    const sessions = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const remoteId = store.getRunnerBinding("run")!.remoteSessionId!
    const notify = (update: unknown) => agentConnections[0]!.client.notify("session/update", { sessionId: remoteId, update } as never)
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Implementing " } })
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the change" } })
    await notify({ sessionUpdate: "tool_call", toolCallId: "t1", title: "edit src/a.ts", kind: "edit" })
    await notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hidden" } })
    await new Promise(resolve => setTimeout(resolve, 0))
    await sessions.stop()
    const lines = store.getRunLog("run", {}).lines.map(line => ({ source: line.source, text: line.text }))
    expect(lines).toEqual([
      { source: "agent", text: "Implementing the change" },
      { source: "tool", text: "editing file" },
    ])
  })
  it.each([
    { shape: "OpenCode config only", id: "mode", category: "mode", legacy: false, confirmed: true },
    { shape: "mode category with custom id", id: "agent", category: "mode", legacy: false, confirmed: true },
    { shape: "mode id without category", id: "mode", category: undefined, legacy: false, confirmed: true },
    { shape: "legacy modes take precedence", id: "mode", category: "mode", legacy: true, confirmed: true },
    { shape: "unconfirmed config selection", id: "mode", category: "mode", legacy: false, confirmed: false },
  ])("selects exact binding: $shape", async ({ id, category, legacy, confirmed }) => {
    const mode = "conductor-implementer"
    const calls: unknown[] = []
    let prompts = 0
    const option = { id, name: "Session Mode", ...(category ? { category } : {}), type: "select" as const,
      currentValue: "build", options: [{ value: "build", name: "Build" }, { value: mode, name: "Implementer" }] }
    const { spawner } = fakeSpawner(() => buildAgent({ name: "mode-shapes" })
      .onRequest("initialize", () => ({ protocolVersion: 1 }))
      .onRequest("session/new", () => ({ sessionId: "s", configOptions: [option],
        ...(legacy ? { modes: { currentModeId: "build", availableModes: [{ id: mode, name: "Implementer" }] } } : {}) }))
      .onRequest("session/set_mode", request => { calls.push({ method: "session/set_mode", ...request.params }); return {} })
      .onRequest("session/set_config_option", request => {
        calls.push({ method: "session/set_config_option", ...request.params })
        return { configOptions: [{ ...option, currentValue: confirmed ? mode : "build" }] }
      })
      .onRequest("session/prompt", () => { prompts++; return { stopReason: "end_turn" } })
      .onNotification("session/cancel", () => {}))
    const deps = baseDeps({ bindings: { build: { mode } }, deadlines: { killMs: 1 } })
    const sessions = new ManagedSessions({ ...deps, spawner })
    try {
      const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
      if (!prepared.ok) throw new Error("prepare failed")
      const creating = sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
      if (confirmed) {
        const created = await creating
        await sessions.prompt({ sessionID: created.id, text: "work" })
        expect(prompts).toBe(1)
      } else {
        await expect(creating).rejects.toMatchObject({ delivery: "not_sent", failureClass: "invalid_config" })
        expect(prompts).toBe(0)
        expect(deps.store.getRunnerBinding("run")?.remoteSessionId).toBeNull()
      }
      expect(calls).toEqual([legacy
        ? { method: "session/set_mode", sessionId: "s", modeId: mode }
        : { method: "session/set_config_option", sessionId: "s", configId: id, value: mode }])
    } finally {
      await sessions.stop()
    }
  })

  describe("D6 option ordering", () => {
    const mode = "build"
    const modeOption = { id: "mode", name: "Mode", category: "mode", type: "select" as const, currentValue: "build", options: [{ value: "build", name: "Build" }] }
    const modelOption = { id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "p/a", options: [{ value: "p/a", name: "A" }, { value: "p/b", name: "B" }] }
    const effortOption = { id: "effort", name: "Effort", category: "thought_level", type: "select" as const, currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] }

    /** A peer whose model switch resets effort to its default, like OpenCode's. */
    function resettingPeer(calls: { configId: string; value: string }[], keepEffort = true) {
      const state: Record<string, string> = { mode: "build", model: "p/a", effort: "high" }
      const snapshot = () => [modeOption, modelOption, effortOption].map(option => ({ ...option, currentValue: state[option.id]! }))
      return fakeSpawner(() => buildAgent({ name: "ordering" })
        .onRequest("initialize", () => ({ protocolVersion: 1 }))
        .onRequest("session/new", () => ({ sessionId: "s", configOptions: snapshot() }))
        .onRequest("session/set_config_option", request => {
          const { configId, value } = request.params as { configId: string; value: string }
          calls.push({ configId, value })
          state[configId] = value
          if (configId === "model") state["effort"] = "high"
          if (!keepEffort && configId === "effort") state["effort"] = "high"
          return { configOptions: snapshot() }
        })
        .onRequest("session/prompt", () => ({ stopReason: "end_turn" }))
        .onNotification("session/cancel", () => {}))
    }

    it("applies model first and effort last so a model reset cannot win", async () => {
      const calls: { configId: string; value: string }[] = []
      const { spawner } = resettingPeer(calls)
      const sessions = new ManagedSessions({ ...baseDeps({ bindings: { build: { mode, configOptions: { effort: "low", model: "p/b" } } }, deadlines: { killMs: 1 } }), spawner })
      try {
        const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
        if (!prepared.ok) throw new Error("prepare failed")
        await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
        expect(calls.filter(c => c.configId !== "mode")).toEqual([{ configId: "model", value: "p/b" }, { configId: "effort", value: "low" }])
      } finally {
        await sessions.stop()
      }
    })

    it("lets the role model and variant override the binding", async () => {
      const calls: { configId: string; value: string }[] = []
      const { spawner } = resettingPeer(calls)
      const sessions = new ManagedSessions({ ...baseDeps({ bindings: { build: { mode, configOptions: { effort: "low", model: "p/b" } } }, deadlines: { killMs: 1 } }), spawner })
      try {
        const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build", model: "p/a", variant: "medium" })
        if (!prepared.ok) throw new Error("prepare failed")
        await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
        expect(calls.filter(c => c.configId !== "mode")).toEqual([{ configId: "model", value: "p/a" }, { configId: "effort", value: "medium" }])
      } finally {
        await sessions.stop()
      }
    })

    it("rejects an unadvertised variant as invalid_config", async () => {
      const { spawner } = resettingPeer([])
      const sessions = new ManagedSessions({ ...baseDeps({ bindings: { build: { mode } }, deadlines: { killMs: 1 } }), spawner })
      try {
        const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build", variant: "xhigh" })
        if (!prepared.ok) throw new Error("prepare failed")
        await expect(sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId }))
          .rejects.toMatchObject({ delivery: "not_sent", failureClass: "invalid_config" })
      } finally {
        await sessions.stop()
      }
    })
  })

  it("refuses an unadvertised mode without prompting", async () => {
    let prompts = 0
    const { spawner } = fakeSpawner(() => buildAgent({ name: "missing-mode" })
      .onRequest("initialize", () => ({ protocolVersion: 1 }))
      .onRequest("session/new", () => ({ sessionId: "s" }))
      .onRequest("session/prompt", () => { prompts++; return { stopReason: "end_turn" } }))
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await expect(sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })).rejects.toMatchObject({ diagnostic: "unsupported_mode", delivery: "not_sent" })
    expect(prompts).toBe(0)
  })

  it("fails closed for a run whose reporting bridge has not listed tools", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps({ readiness: { isReady: () => false, markPhase() {} } }), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    await expect(sessions.prompt({ sessionID: created.id, text: "work" })).rejects.toMatchObject({ diagnostic: "reporting_not_ready" })
    await sessions.abort(created.id)
  })

  it("prepare() -> createSession() -> prompt() -> observeOperation() reaches completed", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    expect(created.id).toBeTruthy()
    expect(await sessions.status(created.id)).toBe("idle")

    const result = await sessions.prompt({ sessionID: created.id, text: "do work" })
    expect(result).toMatchObject({ kind: "submitted" })
    if (!result) throw new Error("expected submitted result")

    // Poll observeOperation until the background turn completes.
    let observation = await sessions.observeOperation(result.operationId)
    for (let i = 0; i < 20 && observation.status !== "completed"; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      observation = await sessions.observeOperation(result.operationId)
    }
    expect(observation.status).toBe("completed")
    expect(observation.stopReason).toBe("end_turn")
    await expect(sessions.prompt({ sessionID: created.id, text: "do work" })).rejects.toThrow()
  })

  it("review fix: a lost session/new response records the SPECIFIC create_response_lost diagnostic, never the generic prompt/answer code", async () => {
    const { spawner } = fakeSpawner(neverCreatesSessionAgent)
    const deps = baseDeps({ deadlines: { startupMs: 100, writeMs: 1000, turnMs: 5000, cancelMs: 200, killMs: 200 } })
    const sessions = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await expect(sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId }))
      .rejects.toMatchObject({ delivery: "unknown" })
    const op = deps.store.findOperation("run", "create", "run")
    expect(op?.phase).toBe("unknown")
    expect(op?.diagnosticCode).toBe("create_response_lost")
  })

  it("zero prompts are sent for an agent whose binding is unsupported (no configured mode for this agent)", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps({ bindings: {} }), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.reason).toBe("incompatible")
  })

  it("capabilities() reports submitted confirmation and no parent/note support", () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    const caps = sessionCapabilitiesOf(sessions)
    expect(caps.promptConfirmation).toBe("submitted")
    expect(caps.parentSessions).toBe(false)
    expect(caps.nonInferentialNotes).toBe(false)
  })

  it("note() throws rather than silently sending a real prompt (capability is false)", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    await expect(sessions.note({ sessionID: "whatever", text: "info" })).rejects.toThrow()
  })

  it("no accidental inference: createSession never calls session/prompt itself", async () => {
    let promptCalled = false
    const spawnerFactory = () =>
      buildAgent({ name: "prompt-tracker" })
        .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
        .onRequest("session/new", () => ({ modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, sessionId: "sess-1" }))
        .onRequest("authenticate", () => ({}))
        .onRequest("session/prompt", () => {
          promptCalled = true
          return { stopReason: "end_turn" as const }
        })
        .onNotification("session/cancel", () => {})
    const { spawner } = fakeSpawner(spawnerFactory)
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    expect(promptCalled).toBe(false)
  })

  it("independent same-cwd attempts get independent sessions with distinct local ids", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    const preparedA = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    const preparedB = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!preparedA.ok || !preparedB.ok) throw new Error("prepare failed")
    const a = await sessions.createSession({ title: "a", runId: "a", directory: "/tmp", reservationId: preparedA.reservationId })
    const b = await sessions.createSession({ title: "b", runId: "b", directory: "/tmp", reservationId: preparedB.reservationId })
    expect(a.id).not.toBe(b.id)
  })

  it("optional parents (parentID) are accepted but never produce a synthetic remote parent", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({
      title: "t", runId: "run", directory: "/tmp", parentID: "some-parent-id", reservationId: prepared.reservationId,
    })
    expect(created.id).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 3.4: independent deadlines, single outstanding prompt, restart safety
// ---------------------------------------------------------------------------

describe("3.4: independent startup/write/turn deadlines", () => {
  it("paused bytes cannot report submitted; long turn remains busy and a late response cannot undo deadline uncertainty", async () => {
    let release!: () => void
    let entered!: () => void
    const boundary = new Promise<void>(resolve => { entered = resolve })
    const pause = new Promise<void>(resolve => { release = resolve })
    let respond!: (value: { stopReason: "end_turn" }) => void
    const response = new Promise<{ stopReason: "end_turn" }>(resolve => { respond = resolve })
    const { spawner } = fakeSpawner(() => buildAgent({ name: "controlled" })
      .onRequest("initialize", () => ({ protocolVersion: 1 }))
      .onRequest("session/new", () => ({ sessionId: "s", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } }))
      .onRequest("session/prompt", () => response), async text => {
        if (text.includes("session/prompt")) { entered(); await pause }
      })
    let expire!: () => void
    let deadlineMs = 0
    const deps = baseDeps({ turnDeadline: (callback, ms) => { expire = callback; deadlineMs = ms; return () => {} }, deadlines: { turnMs: 3_600_000 } })
    const sessions = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    let returned = false
    const submission = sessions.prompt({ sessionID: created.id, text: "work" }).then(value => { returned = true; return value })
    await boundary
    expect(returned).toBe(false)
    expect(deps.store.findOperation("run", "prompt", "run")?.phase).toBe("sending")
    release()
    const result = await submission
    if (!result) throw new Error("missing submission")
    expect(await sessions.status(created.id)).toBe("busy")
    expect(deadlineMs).toBe(3_600_000)
    expect((await sessions.observeOperation(result.operationId)).status).toBe("submitted")
    expire()
    respond({ stopReason: "end_turn" })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await sessions.status(created.id)).toBe("unknown")
    expect((await sessions.observeOperation(result.operationId)).status).toBe("unknown")
    expect(deps.store.getOperation(result.operationId)?.phase).toBe("unknown")
    // Review fix: the durable operation's diagnosticCode records SPECIFICALLY
    // that the TURN deadline fired (never the generic lost-write/lost-
    // response code) — this is what lets the engine's
    // observeRunnerOperation propagate the specific turn_deadline_exceeded
    // fence reason rather than collapsing every unknown cause into
    // lost_prompt_response.
    expect(deps.store.getOperation(result.operationId)?.diagnosticCode).toBe("turn_deadline_exceeded")
    await expect(sessions.prompt({ sessionID: created.id, text: "work" })).rejects.toThrow()
  })

  it("a submitted long turn stays busy until its matching response, cancelling only its turn deadline", async () => {
    let respond!: (value: { stopReason: "end_turn" }) => void
    const response = new Promise<{ stopReason: "end_turn" }>(resolve => { respond = resolve })
    const { spawner } = fakeSpawner(() => buildAgent({ name: "long-turn" })
      .onRequest("initialize", () => ({ protocolVersion: 1 }))
      .onRequest("session/new", () => ({ sessionId: "s", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } }))
      .onRequest("session/prompt", () => response))
    let remaining = 0
    let fire!: () => void
    let cancelled = false
    const deps = baseDeps({ deadlines: { turnMs: 3_600_000 }, turnDeadline: (callback, ms) => { remaining = ms; fire = callback; return () => { cancelled = true } } })
    const sessions = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const result = await sessions.prompt({ sessionID: created.id, text: "work" })
    if (!result) throw new Error("missing submission")
    remaining -= 60_000
    if (remaining <= 0) fire()
    expect(await sessions.status(created.id)).toBe("busy")
    expect(cancelled).toBe(false)
    respond({ stopReason: "end_turn" })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
    expect(await sessions.status(created.id)).toBe("idle")
    expect(deps.store.getOperation(result.operationId)?.phase).toBe("completed")
  })

  it("journal failure prevents execution bytes", async () => {
    let executionBytes = 0
    const { spawner } = fakeSpawner(cooperativeAgent(), async text => { if (text.includes("session/new")) executionBytes++ })
    const deps = baseDeps()
    deps.store.transitionOperationPhase = () => { throw new Error("disk failure") }
    const sessions = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await expect(sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })).rejects.toThrow()
    expect(executionBytes).toBe(0)
  })
  it("write submission is independent of a delayed turn response", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent({ turnDelayMs: 50 }))
    const sessions = new ManagedSessions({
      ...baseDeps({ deadlines: { startupMs: 2000, writeMs: 1000, turnMs: 5000, cancelMs: 200, killMs: 200 } }),
      spawner,
    })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const result = await sessions.prompt({ sessionID: created.id, text: "long task" })
    expect(result).toMatchObject({ kind: "submitted" })
  })

  it("lost prompt response (agent never answers): observeOperation eventually reports unknown, not completed", async () => {
    const { spawner } = fakeSpawner(neverRespondingAgent)
    const deps = baseDeps({ deadlines: { startupMs: 2000, writeMs: 1000, turnMs: 100, cancelMs: 200, killMs: 200 } })
    const sessions = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const result = await sessions.prompt({ sessionID: created.id, text: "will never finish" })
    if (!result) throw new Error("expected submitted")
    await new Promise(resolve => setTimeout(resolve, 250))
    const observation = await sessions.observeOperation(result.operationId)
    expect(observation.status).toBe("unknown")
    expect(deps.store.getOperation(result.operationId)?.diagnosticCode).toBe("turn_deadline_exceeded")
  })

  it("only one prompt may be in flight — a second prompt on a busy session throws (never overlaps)", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent({ turnDelayMs: 300 }))
    const sessions = new ManagedSessions({ ...baseDeps({ deadlines: { startupMs: 2000, writeMs: 50, turnMs: 5000, cancelMs: 200, killMs: 200 } }), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const first = sessions.prompt({ sessionID: created.id, text: "first" })
    await first
    // The turn is still running in the background (300ms delay); status
    // must report busy, and a second prompt call must be rejected.
    expect(await sessions.status(created.id)).toBe("busy")
    await expect(sessions.prompt({ sessionID: created.id, text: "second" })).rejects.toThrow()
  })

  it("no load/resume/replay is attempted after a fresh ManagedSessions instance (restart simulation)", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions1 = new ManagedSessions({ ...baseDeps(), spawner })
    const prepared = await sessions1.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions1.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    await sessions1.prompt({ sessionID: created.id, text: "work" })

    // A brand new instance (simulating a daemon restart) has NO
    // knowledge of the old local session id — sessionExists must report
    // false/unknown, never resurrect it.
    const { spawner: spawner2 } = fakeSpawner(cooperativeAgent())
    const sessions2 = new ManagedSessions({ ...baseDeps(), spawner: spawner2 })
    expect(await sessions2.sessionExists(created.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3.5: bounded cancel/TERM/KILL cleanup, generation-safe observations
// ---------------------------------------------------------------------------

describe("SECURITY (D9): fs/terminal client capabilities are explicitly rejected, never implemented as an accidental filesystem/shell service", () => {
  /** Builds a fake agent that, during its ONE `session/prompt` turn,
   *  calls `method` on the client and reports back whether it succeeded
   *  or was rejected — driven through `sessions.prompt()`'s real
   *  operation/observation plumbing exactly like every other
   *  `acp-sessions.test.ts` case, rather than a raw connection probe. */
  function agentCallingClientMethod(method: string, params: Record<string, unknown>) {
    return () => buildAgent({ name: `fake-agent-calling-${method}` })
      .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
      .onRequest("session/new", () => ({ modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, sessionId: "sess-fs-probe" }))
      .onRequest("authenticate", () => ({}))
      .onRequest("session/prompt", async (ctx: { client: { request: (method: string, params: unknown) => Promise<unknown> } }) => {
        try {
          await ctx.client.request(method, params)
          return { stopReason: "end_turn" as const } // unreachable in a correct implementation
        } catch {
          return { stopReason: "refusal" as const }
        }
      })
      .onNotification("session/cancel", () => {})
  }

  it.each([
    ["fs/read_text_file", { sessionId: "sess-fs-probe", path: "/etc/passwd" }],
    ["fs/write_text_file", { sessionId: "sess-fs-probe", path: "/tmp/would-be-pwned", content: "x" }],
    ["terminal/create", { sessionId: "sess-fs-probe", command: "ls" }],
    ["terminal/output", { sessionId: "sess-fs-probe", terminalId: "t1" }],
    ["terminal/release", { sessionId: "sess-fs-probe", terminalId: "t1" }],
    ["terminal/wait_for_exit", { sessionId: "sess-fs-probe", terminalId: "t1" }],
    ["terminal/kill", { sessionId: "sess-fs-probe", terminalId: "t1" }],
  ] as const)("REGRESSION (was a silent fake-success on this SDK's legacy client wrapper): %s is rejected with method-not-found, never a fabricated success", async (method, params) => {
    const { spawner } = fakeSpawner(agentCallingClientMethod(method, params))
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const result = await sessions.prompt({ sessionID: created.id, text: "try an unsupported client capability" })
    if (!result) throw new Error("expected submitted")
    let observation = await sessions.observeOperation(result.operationId)
    for (let i = 0; i < 40 && observation.status !== "completed"; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      observation = await sessions.observeOperation(result.operationId)
    }
    // "refusal" is this test's OWN sentinel stopReason the fake agent
    // reports only when its client.request() call actually threw — a
    // silently-succeeding client (the exact regression) would report
    // "end_turn" instead.
    expect(observation.stopReason).toBe("refusal")
  })
})

describe("3.5: bounded cancel/TERM/KILL cleanup", () => {
  it("abort() sends session/cancel and completes even when the agent ignores it (bounded kill proceeds)", async () => {
    const { agent, cancelCount } = ignoresCancelAgent()
    const { spawner } = fakeSpawner(() => agent)
    const sessions = new ManagedSessions({
      ...baseDeps({ deadlines: { startupMs: 2000, writeMs: 50, turnMs: 5000, cancelMs: 50, killMs: 50 } }),
      spawner,
    })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    await sessions.prompt({ sessionID: created.id, text: "do something slow" })

    const start = Date.now()
    await sessions.abort(created.id)
    const elapsed = Date.now() - start
    // Bounded: cancelMs (50) + killMs (50) generously bounded well under
    // a second, never hanging on an agent that ignores cancellation.
    expect(elapsed).toBeLessThan(2000)
    expect(cancelCount()).toBeGreaterThan(0)
  })

  it("abort() on an unknown/already-released session is a harmless no-op", async () => {
    const { spawner } = fakeSpawner(cooperativeAgent())
    const sessions = new ManagedSessions({ ...baseDeps(), spawner })
    await expect(sessions.abort("never-existed")).resolves.toBeUndefined()
  })

  it("cancellation while a permission request is pending resolves the permission cancelled, never granting execution", async () => {
    // decidePermissionBounded's own unit tests already cover the pure
    // decision function; this integration test proves ManagedSessions'
    // requestPermission handler actually routes through it with a
    // revoked-by-default reservation state for a session it does not
    // recognize as still live.
    const permissionAgent = buildAgent({ name: "fake-permission-agent" })
      .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
      .onRequest("session/new", () => ({ modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, sessionId: "sess-perm" }))
      .onRequest("authenticate", () => ({}))
      .onRequest("session/prompt", async (ctx: { client: { request: (method: string, params: unknown) => Promise<{ outcome: { outcome: string } }> } }) => {
        const response = await ctx.client.request("session/request_permission", {
          sessionId: "sess-perm",
          toolCall: { toolCallId: "call-1", kind: "edit", title: "edit file" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        })
        return { stopReason: response.outcome.outcome === "selected" ? "end_turn" : "cancelled" }
      })
      .onNotification("session/cancel", () => {})
    const { spawner } = fakeSpawner(() => permissionAgent)
    // Empty allowKinds (the deny-default) means even a legitimate
    // "edit" permission request is cancelled, never selected.
    const sessions = new ManagedSessions({ ...baseDeps({ permissions: { allowKinds: [] } }), spawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const result = await sessions.prompt({ sessionID: created.id, text: "edit a file" })
    if (!result) throw new Error("expected submitted")
    let observation = await sessions.observeOperation(result.operationId)
    for (let i = 0; i < 40 && observation.status !== "completed"; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      observation = await sessions.observeOperation(result.operationId)
    }
    expect(observation.stopReason).toBe("cancelled")
  })

  it("SEC1/DB6: cleanupRun over a REAL spawned process reports confirmed_terminated only once KILL actually reaches the whole process group (leader + its forked descendant) — never inferred from the agent's own cancel acknowledgement or leader exit alone", async () => {
    const command = [process.execPath, join(import.meta.dirname, "fake-acp-agent-with-descendant.ts")]
    const realSessions = new ManagedSessions({
      ...baseDeps({ command: command[0]!, args: command.slice(1), deadlines: { startupMs: 3000, writeMs: 2000, turnMs: 5000, cancelMs: 100, killMs: 300 } }),
      spawner: realAcpProcessSpawner,
    })
    const realPrepared = await realSessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!realPrepared.ok) throw new Error(`prepare failed: ${realPrepared.diagnostic}`)
    const created = await realSessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: realPrepared.reservationId })
    expect(created.id).toBeTruthy()
    // Give the fixture a moment to actually fork its detached descendant
    // before cleanup begins.
    await new Promise(resolve => setTimeout(resolve, 150))

    const evidence = await realSessions.cleanupRun("run", created.id)
    // killMs (300) is long enough for KILL to actually land — the whole
    // group (agent leader AND its forked descendant) is provably gone
    // by the time cleanupRun resolves.
    expect(evidence).toBe("confirmed_terminated")
    await realSessions.stop()
  }, 10000)

  it("SEC1/DB6: cleanupRun reports unconfirmed when the process group cannot be PROVEN absent — never claims confirmed cleanup speculatively (a reparented zombie or a slow-to-reap init are exactly this shape)", async () => {
    // A deterministic fake process whose `groupAbsent()` NEVER reports
    // true (a real reparented zombie / slow-init-reap host is exactly
    // this observable shape) — real OS SIGKILL timing is inherently
    // racy at the sub-10ms polling granularity `terminate()` uses, so
    // this is the fake-spawner half of the pair; the sibling test above
    // proves the REAL confirmed-absence path against an actual process.
    const signalled: string[] = []
    let exitResolve!: (exit: AcpProcessExit) => void
    const exited = new Promise<AcpProcessExit>(resolve => { exitResolve = resolve })
    const { spawner } = fakeSpawner(cooperativeAgent())
    const neverAbsentSpawner: AcpProcessSpawner = {
      spawn(command, options) {
        const inner = spawner.spawn(command, options)
        return {
          ...inner,
          signal(name) { signalled.push(name ?? "SIGTERM"); inner.signal(name) },
          groupAbsent: () => false,
          exited,
        }
      },
    }
    const sessions = new ManagedSessions({ ...baseDeps({ deadlines: { startupMs: 2000, writeMs: 1000, turnMs: 5000, cancelMs: 20, killMs: 20 } }), spawner: neverAbsentSpawner })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })

    const evidence = await sessions.cleanupRun("run", created.id)
    expect(evidence).toBe("unconfirmed")
    // Both TERM and the KILL escalation were actually attempted — this
    // is "unconfirmed", never "never tried".
    expect(signalled).toContain("SIGTERM")
    expect(signalled).toContain("SIGKILL")
    exitResolve({ code: null, signal: "SIGKILL" })
  })

  // ---------------------------------------------------------------------
  // Real finding: OpenCode's shell tool runs a background command via
  // `setsid` — a NEW process group AND session, invisible to a
  // leader-group-only `process.kill(-leaderPid, ...)` probe. After
  // `abandon`, Conductor killed the agent leader's group (opencode +
  // report-mcp died) but the setsid'd `sleep 240` survived as an orphan,
  // and `cleanupRun()` returned `confirmed_terminated` regardless — a
  // false cleanup attestation. These tests exercise the fix end-to-end
  // through `ManagedSessions` + the REAL `realAcpProcessSpawner`.
  // ---------------------------------------------------------------------

  it("(4a) cleanupRun over a REAL spawned process reports confirmed_terminated only once KILL actually reaches a descendant that escaped into its OWN process group via setsid — the exact live gap a leader-group-only probe cannot see", async () => {
    const command = [process.execPath, join(import.meta.dirname, "fake-acp-agent-with-setsid-descendant.ts")]
    const realSessions = new ManagedSessions({
      ...baseDeps({ command: command[0]!, args: command.slice(1), deadlines: { startupMs: 3000, writeMs: 2000, turnMs: 5000, cancelMs: 100, killMs: 300 } }),
      spawner: realAcpProcessSpawner,
    })
    const realPrepared = await realSessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!realPrepared.ok) throw new Error(`prepare failed: ${realPrepared.diagnostic}`)
    const created = await realSessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: realPrepared.reservationId })
    expect(created.id).toBeTruthy()
    // Give the fixture a moment to actually fork+setsid its descendant
    // before cleanup begins.
    await new Promise(resolve => setTimeout(resolve, 150))

    const evidence = await realSessions.cleanupRun("run", created.id)
    // killMs (300) is long enough for KILL to actually land against the
    // descendant's OWN process group — provably gone by the time
    // cleanupRun resolves, never inferred from the leader's own exit.
    expect(evidence).toBe("confirmed_terminated")
    await realSessions.stop()
  }, 10000)

  it("(4b) cleanupRun reports unconfirmed when a setsid'd descendant cannot be reaped within killMs — never claims confirmed cleanup while a former worker's tool is still running (the exact false attestation observed live)", async () => {
    // A fake spawner whose underlying process handle is real (so the
    // leader itself genuinely exits) but whose `groupAbsent()` is
    // stubbed to simulate a descendant KILL that has not yet actually
    // landed within a too-short killMs — deterministic, unlike racing
    // genuine OS SIGKILL timing at a few milliseconds.
    const signalled: string[] = []
    const realHandle = realAcpProcessSpawner
    const stubbornDescendantSpawner: AcpProcessSpawner = {
      spawn(command, options) {
        const inner = realHandle.spawn(command, options)
        let refreshed = false
        return {
          ...inner,
          refreshDescendants() { refreshed = true; inner.refreshDescendants?.() },
          signal(name) { signalled.push(name ?? "SIGTERM"); inner.signal(name) },
          // Reports the descendant as still present regardless of the
          // real probe outcome, as long as a pre-kill snapshot was
          // actually taken — proving `terminate()`/`cleanupRun()` never
          // downgrade to "confirmed" just because the LEADER exited.
          groupAbsent: () => refreshed ? false : inner.groupAbsent?.() ?? false,
        }
      },
    }
    const command = [process.execPath, join(import.meta.dirname, "fake-acp-agent-with-setsid-descendant.ts")]
    const sessions = new ManagedSessions({
      ...baseDeps({ command: command[0]!, args: command.slice(1), deadlines: { startupMs: 3000, writeMs: 2000, turnMs: 5000, cancelMs: 20, killMs: 20 } }),
      spawner: stubbornDescendantSpawner,
    })
    const prepared = await sessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error(`prepare failed: ${prepared.diagnostic}`)
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    await new Promise(resolve => setTimeout(resolve, 150))

    const evidence = await sessions.cleanupRun("run", created.id)
    expect(evidence).toBe("unconfirmed")
    expect(signalled).toContain("SIGTERM")
    expect(signalled).toContain("SIGKILL")
    await sessions.stop()
  }, 10000)

  it("(4c) pid-reuse guard, end to end: repeated refreshDescendants() calls (mirroring terminate()'s pre-kill + post-signal refresh) still let cleanupRun correctly confirm the real setsid'd descendant's termination — the identity check never blocks legitimate evidence", async () => {
    // The pure identity-mismatch routing itself is exhaustively
    // unit-tested in `acp-process.test.ts`
    // (`partitionDescendantsByIdentity`'s dedicated pid-reuse-guard
    // describe block: alive+matching -> signal, gone -> resolved,
    // reused/mismatched starttime -> resolved-never-signalled). This
    // test proves the identity check is wired through the REAL
    // `realAcpProcessSpawner` end to end: an extra manual
    // `refreshDescendants()` call beyond the two `terminate()` already
    // makes must remain a harmless merge, never re-arming a pid whose
    // identity has already moved on, and the genuine setsid'd
    // descendant must still be correctly reached and confirmed gone.
    const command = [process.execPath, join(import.meta.dirname, "fake-acp-agent-with-setsid-descendant.ts")]
    let refreshCount = 0
    const countingSpawner: AcpProcessSpawner = {
      spawn(cmd, options) {
        const inner = realAcpProcessSpawner.spawn(cmd, options)
        return {
          ...inner,
          refreshDescendants() {
            refreshCount += 1
            inner.refreshDescendants?.()
          },
        }
      },
    }
    const realSessions = new ManagedSessions({
      ...baseDeps({ command: command[0]!, args: command.slice(1), deadlines: { startupMs: 3000, writeMs: 2000, turnMs: 5000, cancelMs: 100, killMs: 300 } }),
      spawner: countingSpawner,
    })
    const realPrepared = await realSessions.prepare({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!realPrepared.ok) throw new Error(`prepare failed: ${realPrepared.diagnostic}`)
    const created = await realSessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: realPrepared.reservationId })
    await new Promise(resolve => setTimeout(resolve, 150))

    const evidence = await realSessions.cleanupRun("run", created.id)
    expect(evidence).toBe("confirmed_terminated")
    // terminate() refreshes exactly twice (pre-SIGTERM, post-SIGTERM).
    expect(refreshCount).toBe(2)
    await realSessions.stop()
  }, 10000)
})
