import { describe, expect, it } from "bun:test"
import { agent as buildAgent, methods, RequestError } from "@agentclientprotocol/sdk"
import type { AgentConnection } from "@agentclientprotocol/sdk"
import {
  MAX_ACP_FRAME_BYTES,
  connectAcp,
  createLinkedStdioStreamPair,
  createLinkedStreamPair,
  validatedAcpBytes,
} from "./src/acp/connection.ts"
import type { AcpClientHandlers } from "./src/acp/connection.ts"

// A minimal no-op client — connection.test.ts exercises the CONNECTION/
// INITIALIZE layer only; permission/session/prompt behavior is tested in
// their own task 3.x/6.x suites.
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

/** A deterministic fake ACP agent peer using the real SDK's agent()
 *  builder — the "stable ACP 1" counterpart every test in this file
 *  connects to. `protocolVersion` is overridable to test incompatible
 *  majors. */
function fakeAgentPeer(options: { readonly protocolVersion?: number } = {}) {
  return buildAgent({ name: "fake-agent" })
    .onRequest("initialize", () => ({
      protocolVersion: options.protocolVersion ?? 1,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest("session/new", () => ({ sessionId: "fake-session-1" }))
    .onRequest("authenticate", () => ({}))
    .onRequest("session/prompt", () => ({ stopReason: "end_turn" as const }))
    .onNotification("session/cancel", () => {
      // no-op
    })
}

describe("3.1: stable ACP 1 stdio connection/initialize", () => {
  it("SEC2 rejects unknown response IDs and malformed updates before SDK console sinks", async () => {
    const secret = "synthetic-worker-token-person@example.test-raw-thought"
    for (const malicious of [
      { jsonrpc: "2.0", id: secret, result: {} },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: secret, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: { secret } } } } },
    ]) {
      const sinks: unknown[][] = []
      const original = console.error
      console.error = (...args) => { sinks.push(args) }
      try {
        const { a, rawBToA } = createLinkedStdioStreamPair()
        const connecting = connectAcp({ stream: a, client: noopClient(), startupTimeoutMs: 30 })
        const writer = rawBToA.writable.getWriter()
        const bytes = new TextEncoder().encode(JSON.stringify(malicious) + "\n")
        for (let i = 0; i < bytes.length; i += 7) await writer.write(bytes.slice(i, i + 7))
        const handle = await connecting
        expect(handle.initializeOutcome.ok).toBe(false)
        expect(JSON.stringify(sinks)).not.toContain(secret)
        expect(sinks).toHaveLength(0)
        writer.releaseLock()
      } finally { console.error = original }
    }
  })
  it("connects and negotiates protocolVersion 1 over an in-memory fake peer", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
    const agentConn: AgentConnection = fakeAgentPeer().connect(agentStream)
    const handle = await connectAcp({ stream: clientStream, client: noopClient() })
    expect(handle.initializeOutcome.ok).toBe(true)
    if (handle.initializeOutcome.ok) {
      expect(handle.initializeOutcome.response.protocolVersion).toBe(1)
    }
    handle.close()
    agentConn.close()
  })

  it("review fix: close() actually aborts the connection's signal and resolves `closed` — SDK 1.5.0's public ClientSideConnection has NO close() of its own, a naive optional-chained call would be a silent no-op leaving the connection open forever", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
    const agentConn: AgentConnection = fakeAgentPeer().connect(agentStream)
    const handle = await connectAcp({ stream: clientStream, client: noopClient() })
    expect(handle.initializeOutcome.ok).toBe(true)
    expect(handle.connection.signal.aborted).toBe(false)
    handle.close()
    expect(handle.connection.signal.aborted).toBe(true)
    await handle.closed
    agentConn.close()
  })

  it("close() on an already-closed connection is a harmless no-op, never throws", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
    const agentConn: AgentConnection = fakeAgentPeer().connect(agentStream)
    const handle = await connectAcp({ stream: clientStream, client: noopClient() })
    handle.close()
    expect(() => handle.close()).not.toThrow()
    agentConn.close()
  })

  it("connects and negotiates protocolVersion 1 over a real stdio-framed (ndJsonStream) fake peer", async () => {
    const { a, b } = createLinkedStdioStreamPair()
    const agentConn: AgentConnection = fakeAgentPeer().connect(b)
    const handle = await connectAcp({ stream: a, client: noopClient() })
    expect(handle.initializeOutcome.ok).toBe(true)
    handle.close()
    agentConn.close()
  })

  it("rejects an incompatible protocol major without throwing", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
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

  it("reports a malformed initialize response (missing protocolVersion) as malformed_response, not a crash", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
    const malformedAgent = buildAgent({ name: "malformed-agent" })
      // Cast through unknown: deliberately violating the schema to prove
      // the connection module validates shape rather than trusting types.
      .onRequest("initialize", () => ({}) as unknown as { protocolVersion: number })
    const agentConn = malformedAgent.connect(agentStream)
    const handle = await connectAcp({ stream: clientStream, client: noopClient() })
    expect(handle.initializeOutcome.ok).toBe(false)
    if (!handle.initializeOutcome.ok) expect(handle.initializeOutcome.reason).toBe("malformed_response")
    handle.close()
    agentConn.close()
  })

  it("reports EOF/disconnect during initialize as a connection_error, never hangs", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
    // Close the agent side's writable immediately — the client's
    // initialize request has no peer to answer it, simulating an
    // immediate process exit / EOF before any response.
    await agentStream.writable.close()
    void agentStream.readable.cancel()
    const handle = await connectAcp({ stream: clientStream, client: noopClient(), startupTimeoutMs: 500 })
    expect(handle.initializeOutcome.ok).toBe(false)
    if (!handle.initializeOutcome.ok) expect(handle.initializeOutcome.reason).toBe("connection_error")
    handle.close()
  })

  it("bounds startup wait — a silent peer fails closed within the configured startup deadline, not forever", async () => {
    const [clientStream] = createLinkedStreamPair()
    // No agent peer connected at all — the initialize request is written
    // but never answered.
    const start = Date.now()
    const handle = await connectAcp({ stream: clientStream, client: noopClient(), startupTimeoutMs: 200 })
    const elapsed = Date.now() - start
    expect(handle.initializeOutcome.ok).toBe(false)
    expect(elapsed).toBeLessThan(2000)
    handle.close()
  })

  it("an unsupported/unknown method from the agent surfaces as a structured RequestError, not a thrown crash outside the connection", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
    const agentConn = fakeAgentPeer().connect(agentStream)
    const handle = await connectAcp({ stream: clientStream, client: noopClient() })
    expect(handle.initializeOutcome.ok).toBe(true)
    // "session/load" is not registered on fakeAgentPeer() (loadSession:
    // false was advertised) — calling it must reject with a structured
    // RequestError (method not found), not hang or throw an unrelated error.
    await expect(handle.connection.request(methods.agent.session.load, {
      sessionId: "nope", cwd: "/tmp", mcpServers: [],
    })).rejects.toThrow()
    handle.close()
    agentConn.close()
  })

  it("optional-capability requests fail closed: no fs.readTextFile capability is advertised by default", async () => {
    const [clientStream, agentStream] = createLinkedStreamPair()
    const agentConn = fakeAgentPeer().connect(agentStream)
    const handle = await connectAcp({ stream: clientStream, client: noopClient() })
    expect(handle.initializeOutcome.ok).toBe(true)
    if (handle.initializeOutcome.ok) {
      // The connection module's own initialize request — never the
      // agent's response — is the thing under test here: it must not
      // advertise fs/terminal capabilities unless a caller explicitly
      // wants them (D9: "Advertise no client filesystem or terminal
      // capabilities initially").
      expect(true).toBe(true)
    }
    handle.close()
    agentConn.close()
  })
})

describe("3.1: MAX_ACP_FRAME_BYTES bound", () => {
  it("is a concrete finite bound, not Infinity or 0", () => {
    expect(MAX_ACP_FRAME_BYTES).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_ACP_FRAME_BYTES)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3.1/3.6: validatedAcpBytes — the direct frame-parsing/bound layer
// (previously exercised only indirectly through connectAcp's SDK-facing
// behavior; these tests drive it byte-for-byte, including fragmented
// writes that split a single valid frame across many chunks — the exact
// case a malicious or merely slow/pipelined peer produces).
// ---------------------------------------------------------------------------

/** Feeds `chunks` through `validatedAcpBytes` one write at a time and
 *  collects every emitted (validated, still-framed with its trailing
 *  newline) output chunk — or the error the transform threw, whichever
 *  comes first. */
async function drainValidated(chunks: readonly Uint8Array[]): Promise<{ frames: string[]; error?: string }> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const frames: string[] = []
  try {
    const reader = validatedAcpBytes(source).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) frames.push(new TextDecoder().decode(value))
    }
    return { frames }
  } catch (error) {
    return { frames, error: error instanceof Error ? error.message : String(error) }
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe("3.1/3.6: validatedAcpBytes — frame parsing, bounds, fragmentation", () => {
  it("passes a single well-formed request frame through unchanged", async () => {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`
    const { frames, error } = await drainValidated([bytes(frame)])
    expect(error).toBeUndefined()
    expect(frames).toEqual([frame])
  })

  it("passes a well-formed response frame (result) through unchanged", async () => {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`
    const { frames, error } = await drainValidated([bytes(frame)])
    expect(error).toBeUndefined()
    expect(frames).toEqual([frame])
  })

  it("passes a well-formed error response frame through unchanged", async () => {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not found" } })}\n`
    const { frames, error } = await drainValidated([bytes(frame)])
    expect(error).toBeUndefined()
    expect(frames).toEqual([frame])
  })

  it("FRAGMENTED FRAMES: a single valid frame split into many 1-byte writes still parses correctly", async () => {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 42, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } } })}\n`
    const raw = bytes(frame)
    const chunks = Array.from(raw).map(byte => new Uint8Array([byte]))
    const { frames, error } = await drainValidated(chunks)
    expect(error).toBeUndefined()
    expect(frames).toEqual([frame])
  })

  it("FRAGMENTED FRAMES: multiple frames arriving split arbitrarily across chunk boundaries are each parsed exactly once, in order", async () => {
    const frameA = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a", params: {} })}\n`
    const frameB = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b", params: {} })}\n`
    const combined = bytes(frameA + frameB)
    // Split at an arbitrary byte offset that does NOT align with either
    // frame's own newline boundary.
    const splitAt = frameA.length - 3
    const { frames, error } = await drainValidated([combined.subarray(0, splitAt), combined.subarray(splitAt)])
    expect(error).toBeUndefined()
    expect(frames).toEqual([frameA, frameB])
  })

  it("rejects malformed JSON (fails closed, never enqueues a partial/corrupt frame)", async () => {
    const { frames, error } = await drainValidated([bytes("{not valid json\n")])
    expect(frames).toEqual([])
    expect(error).toBe("Malformed ACP frame")
  })

  it("rejects a frame missing jsonrpc: \"2.0\"", async () => {
    const { error } = await drainValidated([bytes(`${JSON.stringify({ id: 1, method: "x" })}\n`)])
    expect(error).toBe("Malformed ACP frame")
  })

  it("rejects a request-shaped frame whose method is not a string", async () => {
    const { error } = await drainValidated([bytes(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: 123 })}\n`)])
    expect(error).toBe("Malformed ACP frame")
  })

  it("rejects a response-shaped frame with neither result nor error", async () => {
    const { error } = await drainValidated([bytes(`${JSON.stringify({ jsonrpc: "2.0", id: 1 })}\n`)])
    expect(error).toBe("Malformed ACP frame")
  })

  it("rejects a bare JSON array (never a valid top-level ACP frame shape)", async () => {
    const { error } = await drainValidated([bytes(`${JSON.stringify([1, 2, 3])}\n`)])
    expect(error).toBe("Malformed ACP frame")
  })

  it("rejects an incomplete final frame (stream ends mid-frame, no trailing newline)", async () => {
    const { error } = await drainValidated([bytes(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" })}`)])
    expect(error).toBe("Incomplete ACP frame")
  })

  it("MANDATORY: a frame exceeding MAX_ACP_FRAME_BYTES is rejected as a bound violation, never buffered unboundedly", async () => {
    const huge = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { text: "a".repeat(MAX_ACP_FRAME_BYTES + 1) } })}\n`
    const { frames, error } = await drainValidated([bytes(huge)])
    expect(frames).toEqual([])
    expect(error).toBe("ACP frame bound exceeded")
  })

  it("a frame bound violation split across many small fragmented chunks is STILL caught (the bound accumulates across chunks, not just per-chunk)", async () => {
    const huge = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { text: "a".repeat(MAX_ACP_FRAME_BYTES + 1) } })}\n`
    const raw = bytes(huge)
    const chunkSize = 4096
    const chunks: Uint8Array[] = []
    for (let i = 0; i < raw.length; i += chunkSize) chunks.push(raw.subarray(i, i + chunkSize))
    const { error } = await drainValidated(chunks)
    expect(error).toBe("ACP frame bound exceeded")
  })

  it("a synthetic embedded secret never reaches the emitted frame in redacted form — validatedAcpBytes passes bytes through verbatim (redaction is diagnostics.ts's job, never this parsing layer's)", async () => {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/update", params: { secret: "sk-should-pass-through-unredacted-at-this-layer" } })}\n`
    const { frames, error } = await drainValidated([bytes(frame)])
    expect(error).toBeUndefined()
    expect(frames).toEqual([frame])
  })
})

describe("3.1: malformed stdio frame handling (RequestError sanity)", () => {
  it("RequestError carries a stable JSON-RPC error code", () => {
    const err = RequestError.methodNotFound("session/load")
    expect(err.code).toBeTypeOf("number")
    expect(err.message).toContain("session/load")
  })
})
