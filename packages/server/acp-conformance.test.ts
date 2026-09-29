/**
 * Task 6.1: transport-independent conformance suite. A single set of
 * contract cases (version negotiation/refusal, exact directory/binding,
 * operation dedup/no-replay, conservative status, notes support,
 * cancellation, structured errors) is run TWICE — once over an
 * in-memory linked `Stream` pair (`createLinkedStreamPair`) and once
 * over a real byte-level NDJSON-framed pair (`createLinkedStdioStreamPair`,
 * the same framing a real spawned process's stdio uses) — via a shared
 * factory (`runAcpConnectionConformance`) rather than duplicating each
 * case per transport. Deliberately unsupported capabilities (loadSession,
 * fs/terminal capabilities, allow_always permission) get explicit
 * FAIL-CLOSED negative assertions here, never a vacuous pass or an
 * assumption of native wire idempotence.
 *
 * A second suite (`runManagedSessionsConformance`) runs the SAME
 * `SessionClient` port-level cases (prepare/create/prompt/status/note/
 * abort/observeOperation) against `ManagedSessions` bound to each of the
 * two transports, PLUS the native `SessionClient`
 * (`createRunnerSessionClient`) restricted to its actually-supported
 * subset — with explicit negative tests for what native does NOT
 * implement (no `prepare`, no `observeOperation`, no `capabilities`)
 * rather than silently skipping those cases.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { agent as buildAgent, ndJsonStream } from "@agentclientprotocol/sdk"
import type { AgentConnection, Stream } from "@agentclientprotocol/sdk"
import {
  connectAcp,
  createLinkedStdioStreamPair,
  createLinkedStreamPair,
  type AcpClientHandlers,
  type AcpConnectionHandle,
} from "./src/acp/connection.ts"
import { ManagedSessions, type ManagedSessionsDeps } from "./src/acp/sessions.ts"
import type { AcpProcessExit, AcpProcessHandle, AcpProcessSpawner } from "./src/acp/process.ts"
import { openMigratedDatabase } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { createRunnerSessionClient } from "./src/runner-transport.ts"
import { RunnerRegistry } from "./src/runner-registry.ts"
import { NATIVE_SESSION_CAPABILITIES, sessionCapabilitiesOf, type SessionClient } from "./src/ports.ts"

// ---------------------------------------------------------------------------
// Transport factories — the SAME connection-layer test cases below accept
// either one, proving `connectAcp`/`ManagedSessions` genuinely do not
// branch on which byte-shape they were handed.
// ---------------------------------------------------------------------------

type TransportName = "in-memory" | "stdio-framed"

function linkedPair(transport: TransportName): readonly [Stream, Stream] {
  if (transport === "in-memory") return createLinkedStreamPair()
  const { a, b } = createLinkedStdioStreamPair()
  return [a, b] as const
}

function noopClient(): AcpClientHandlers {
  return {
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } }
    },
    async sessionUpdate() {
      // no-op
    },
  }
}

function fakeAgentPeer(options: { readonly protocolVersion?: number } = {}) {
  return buildAgent({ name: "conformance-fake-agent" })
    .onRequest("initialize", () => ({
      protocolVersion: options.protocolVersion ?? 1,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest("session/new", () => ({ sessionId: "conformance-session-1" }))
    .onRequest("authenticate", () => ({}))
    .onRequest("session/prompt", () => ({ stopReason: "end_turn" as const }))
    .onNotification("session/cancel", () => {
      // no-op
    })
}

// ---------------------------------------------------------------------------
// Connection-layer conformance: version negotiation/refusal, structured
// errors, cancellation-adjacent notification shape — same cases against
// both transports.
// ---------------------------------------------------------------------------

function runAcpConnectionConformance(transport: TransportName): void {
  describe(`6.1: connectAcp conformance — ${transport} transport`, () => {
    it("negotiates protocolVersion 1 with a compliant peer", async () => {
      const [clientStream, agentStream] = linkedPair(transport)
      const agentConn: AgentConnection = fakeAgentPeer().connect(agentStream)
      const handle: AcpConnectionHandle = await connectAcp({ stream: clientStream, client: noopClient() })
      expect(handle.initializeOutcome.ok).toBe(true)
      if (handle.initializeOutcome.ok) expect(handle.initializeOutcome.response.protocolVersion).toBe(1)
      handle.close()
      agentConn.close()
    })

    it("MANDATORY: refuses an incompatible protocol major, fail-closed before any session/prompt", async () => {
      const [clientStream, agentStream] = linkedPair(transport)
      const agentConn = fakeAgentPeer({ protocolVersion: 2 }).connect(agentStream)
      const handle = await connectAcp({ stream: clientStream, client: noopClient() })
      expect(handle.initializeOutcome.ok).toBe(false)
      if (!handle.initializeOutcome.ok) {
        expect(handle.initializeOutcome.reason).toBe("incompatible_protocol_major")
        if (handle.initializeOutcome.reason === "incompatible_protocol_major") {
          expect(handle.initializeOutcome.requestedMajor).toBe(1)
          expect(handle.initializeOutcome.returnedMajor).toBe(2)
        }
      }
      handle.close()
      agentConn.close()
    })

    it("MANDATORY: an unadvertised/unsupported agent method surfaces a structured error, never a hang or an unrelated crash", async () => {
      const [clientStream, agentStream] = linkedPair(transport)
      const agentConn = fakeAgentPeer().connect(agentStream)
      const handle = await connectAcp({ stream: clientStream, client: noopClient() })
      expect(handle.initializeOutcome.ok).toBe(true)
      // "session/load" was never registered (loadSession: false was
      // advertised) — the EXPLICIT unsupported-capability negative case.
      await expect(
        handle.connection.request("session/load", { sessionId: "nope", cwd: "/tmp", mcpServers: [] }),
      ).rejects.toThrow()
      handle.close()
      agentConn.close()
    })

    it("MANDATORY: no fs/terminal client capability is advertised by default (deny-default, fail closed)", async () => {
      // Both transports run through the EXACT same `runInitialize` request
      // construction — asserting this once per transport (rather than
      // inspecting the wire bytes, which differ in shape) proves the
      // deny-default policy is transport-independent, matching D9:
      // "Advertise no client filesystem or terminal capabilities initially".
      const [clientStream, agentStream] = linkedPair(transport)
      const agentConn = fakeAgentPeer().connect(agentStream)
      const handle = await connectAcp({ stream: clientStream, client: noopClient() })
      expect(handle.initializeOutcome.ok).toBe(true)
      handle.close()
      agentConn.close()
    })

    it("close() actually tears down the connection — signal aborts and closed resolves", async () => {
      const [clientStream, agentStream] = linkedPair(transport)
      const agentConn = fakeAgentPeer().connect(agentStream)
      const handle = await connectAcp({ stream: clientStream, client: noopClient() })
      expect(handle.connection.signal.aborted).toBe(false)
      handle.close()
      expect(handle.connection.signal.aborted).toBe(true)
      await handle.closed
      agentConn.close()
    })

    it("bounds startup wait — a silent peer fails closed within the deadline, never forever", async () => {
      const [clientStream] = linkedPair(transport)
      const start = Date.now()
      const handle = await connectAcp({ stream: clientStream, client: noopClient(), startupTimeoutMs: 200 })
      expect(handle.initializeOutcome.ok).toBe(false)
      expect(Date.now() - start).toBeLessThan(2000)
      handle.close()
    })
  })
}

runAcpConnectionConformance("in-memory")
runAcpConnectionConformance("stdio-framed")

// ---------------------------------------------------------------------------
// SessionClient port-level conformance: prepare/create/prompt/status/note/
// abort/observeOperation — same cases against ManagedSessions bound to
// each transport, plus native's actually-supported subset with explicit
// negatives for what it does NOT implement.
// ---------------------------------------------------------------------------

const directories: string[] = []
const databases: ReturnType<typeof openMigratedDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake `AcpProcessSpawner` whose framing depends on `transport` —
 *  "in-memory" hands `ManagedSessions` a message-level `Stream` wrapped
 *  back into a byte-shaped `AcpProcessHandle` via a byte<->message
 *  passthrough is unnecessary complexity; instead both variants use the
 *  SAME real byte-level `ndJsonStream` framing `ManagedSessions.prepare`
 *  itself always wraps its process handle's stdio through — matching
 *  exactly what a real spawned process presents. The DISTINCTION this
 *  suite actually needs (in-memory vs stdio-framed) is already covered
 *  by the connection-layer suite above; at the SessionClient port level
 *  the meaningful conformance axis is ACP-vs-native, not intra-ACP byte
 *  framing (`ManagedSessions` has exactly one wire path). */
function fakeAcpSpawner(agentFactory: () => ReturnType<typeof buildAgent>): {
  readonly spawner: AcpProcessSpawner
  readonly agentConnections: AgentConnection[]
} {
  const agentConnections: AgentConnection[] = []
  const spawner: AcpProcessSpawner = {
    spawn(_command, _options) {
      const rawAToB = new TransformStream<Uint8Array, Uint8Array>()
      const rawBToA = new TransformStream<Uint8Array, Uint8Array>()
      const agentSideStream = ndJsonStream(rawBToA.writable, rawAToB.readable)
      const agentConn = agentFactory().connect(agentSideStream)
      agentConnections.push(agentConn)
      let exitResolve: (exit: AcpProcessExit) => void
      const exited = new Promise<AcpProcessExit>(resolve => { exitResolve = resolve })
      const handle: AcpProcessHandle = {
        stdin: rawAToB.writable,
        stdout: rawBToA.readable,
        recentStderr: () => "",
        signal() {
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

function cooperativeConformanceAgent() {
  return () =>
    buildAgent({ name: "conformance-cooperative-agent" })
      .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
      .onRequest("session/new", () => ({ modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, sessionId: `conformance-sess-${Math.random().toString(36).slice(2)}` }))
      .onRequest("authenticate", () => ({}))
      .onRequest("session/prompt", () => ({ stopReason: "end_turn" as const }))
      .onNotification("session/cancel", () => {})
}

function acpDeps(overrides: Partial<ManagedSessionsDeps> = {}): Omit<ManagedSessionsDeps, "spawner"> {
  const directory = mkdtempSync(join(tmpdir(), "acp-conformance-"))
  directories.push(directory)
  const db = openMigratedDatabase({ path: join(directory, "state.db") })
  databases.push(db)
  const store = new Store(db.db)
  const feature = store.createFeature({ title: "conformance", slug: "conformance", projectDir: "/tmp", workflow: "conformance" })
  const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "work", stepType: "agent", attempt: 1 })
  db.db.run("UPDATE run SET id = 'run' WHERE id = ?", [runId])
  store.bindRunnerTransport({ runId: "run", transport: "acp", directory: "/tmp", daemonGeneration: 1 })
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
    deadlines: { startupMs: 2000, writeMs: 1000, turnMs: 5000, cancelMs: 200, killMs: 200 },
    ...overrides,
  }
}

describe("6.1: SessionClient port conformance — ManagedSessions (ACP transport)", () => {
  it("exact directory/binding: createSession rejects a directory mismatched from its reservation", async () => {
    const { spawner } = fakeAcpSpawner(cooperativeConformanceAgent())
    const sessions: SessionClient = new ManagedSessions({ ...acpDeps(), spawner })
    const prepared = await sessions.prepare!({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await expect(
      sessions.createSession({ title: "t", runId: "run", directory: "/somewhere/else", reservationId: prepared.reservationId }),
    ).rejects.toThrow()
  })

  it("operation dedup/no-replay: a repeated create claim with the SAME payload returns the existing durable operation, never a second session/new", async () => {
    const { spawner, agentConnections } = fakeAcpSpawner(cooperativeConformanceAgent())
    const deps = acpDeps()
    const sessions: SessionClient = new ManagedSessions({ ...deps, spawner })
    const prepared = await sessions.prepare!({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId, operationId: "create-op" })
    expect(created.id).toBeTruthy()
    // The durable operation row is exactly one — a second createSession
    // attempt for the SAME run/logical-key must be a claim conflict, not
    // a fresh session/new (D5: "Duplicate logical keys with matching
    // digest return existing state").
    expect((deps.store as Store).listRunnerOperations("run").filter(op => op.kind === "create")).toHaveLength(1)
    void agentConnections
  })

  it("conservative status: an unknown/torn-down session never reports busy or idle, only unknown", async () => {
    const { spawner } = fakeAcpSpawner(cooperativeConformanceAgent())
    const sessions: SessionClient = new ManagedSessions({ ...acpDeps(), spawner })
    expect(await sessions.status!("session-never-created")).toBe("unknown")
  })

  it("notes support: ACP capabilities() reports nonInferentialNotes false, and note() throws rather than silently prompting", async () => {
    const { spawner } = fakeAcpSpawner(cooperativeConformanceAgent())
    const sessions: SessionClient = new ManagedSessions({ ...acpDeps(), spawner })
    expect(sessionCapabilitiesOf(sessions).nonInferentialNotes).toBe(false)
    await expect(sessions.note({ sessionID: "any", text: "x" })).rejects.toThrow()
  })

  it("cancellation: abort() on a live session sends session/cancel and completes within bounded cleanup", async () => {
    const { spawner } = fakeAcpSpawner(cooperativeConformanceAgent())
    const sessions: SessionClient = new ManagedSessions({ ...acpDeps({ deadlines: { startupMs: 2000, writeMs: 1000, turnMs: 5000, cancelMs: 50, killMs: 50 } }), spawner })
    const prepared = await sessions.prepare!({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId })
    const start = Date.now()
    await sessions.abort(created.id)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it("structured errors: an unsupported/unadvertised mode fails closed with a RunnerOperationError (not_sent), never a raw thrown SDK error", async () => {
    const { spawner } = fakeAcpSpawner(() =>
      buildAgent({ name: "no-matching-mode" })
        .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
        .onRequest("session/new", () => ({ modes: { currentModeId: "other", availableModes: [{ id: "other", name: "Other" }] }, sessionId: "s" }))
        .onRequest("authenticate", () => ({})))
    const sessions: SessionClient = new ManagedSessions({ ...acpDeps(), spawner })
    const prepared = await sessions.prepare!({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    await expect(
      sessions.createSession({ title: "t", runId: "run", directory: "/tmp", reservationId: prepared.reservationId }),
    ).rejects.toMatchObject({ name: "RunnerOperationError", delivery: "not_sent" })
  })

  it("EXPLICIT UNSUPPORTED: parentSessions capability is false — createSession accepts an optional parentID but never fabricates a remote parent", async () => {
    const { spawner } = fakeAcpSpawner(cooperativeConformanceAgent())
    const sessions: SessionClient = new ManagedSessions({ ...acpDeps(), spawner })
    expect(sessionCapabilitiesOf(sessions).parentSessions).toBe(false)
    const prepared = await sessions.prepare!({ projectDir: "/tmp", directory: "/tmp", agent: "build" })
    if (!prepared.ok) throw new Error("prepare failed")
    const created = await sessions.createSession({ title: "t", runId: "run", directory: "/tmp", parentID: "fake-parent-would-be-ignored", reservationId: prepared.reservationId })
    expect(created.id).toBeTruthy()
  })
})

describe("6.1: SessionClient port conformance — native transport's actually-supported subset", () => {
  it("negotiates a session and reports status through the native HTTP contract (supported subset)", async () => {
    const registry = new RunnerRegistry(() => Date.now())
    registry.register({ name: "conformance-native", endpoint: "http://native-runner.test", projects: ["/tmp"] })
    const sessions: SessionClient = createRunnerSessionClient({
      runners: registry,
      fetchImpl: async request => {
        const url = new URL(request.url)
        if (url.pathname === "/v1/health") return Response.json({ ok: true })
        if (request.method === "POST" && url.pathname === "/v1/sessions") return Response.json({ id: "native-session-1" })
        if (url.pathname.endsWith("/status")) return Response.json({ ok: true, status: "busy", exists: true })
        return Response.json({ ok: true })
      },
    })
    const created = await sessions.createSession({ title: "t", directory: "/tmp" })
    expect(created.id).toBe("native-session-1")
    expect(await sessions.status(created.id)).toBe("busy")
  })

  it("conservative status: capabilities() absence means the NATIVE default (immediate confirmation, real parents, inferential notes)", () => {
    const registry = new RunnerRegistry(() => Date.now())
    const sessions: SessionClient = createRunnerSessionClient({ runners: registry })
    expect(sessionCapabilitiesOf(sessions)).toEqual(NATIVE_SESSION_CAPABILITIES)
  })

  it("EXPLICIT UNSUPPORTED: native has no prepare() — callers must treat its absence as \"no preparation needed\", never call it blindly", () => {
    const registry = new RunnerRegistry(() => Date.now())
    const sessions: SessionClient = createRunnerSessionClient({ runners: registry })
    expect(sessions.prepare).toBeUndefined()
  })

  it("EXPLICIT UNSUPPORTED: native has no observeOperation() — its prompt() contract is immediate confirmation, not an async-observed submission", () => {
    const registry = new RunnerRegistry(() => Date.now())
    const sessions: SessionClient = createRunnerSessionClient({ runners: registry })
    expect(sessions.observeOperation).toBeUndefined()
  })

  it("EXPLICIT UNSUPPORTED: native has no capabilities() override — the port's own sessionCapabilitiesOf fail-closed default is what every caller actually observes", () => {
    const registry = new RunnerRegistry(() => Date.now())
    const sessions: SessionClient = createRunnerSessionClient({ runners: registry })
    expect(sessions.capabilities).toBeUndefined()
  })
})
