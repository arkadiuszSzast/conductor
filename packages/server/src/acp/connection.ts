/**
 * Stable ACP 1 stdio connection/initialize (design.md D2/D4, task 3.1).
 *
 * Uses ONLY the stable root `@agentclientprotocol/sdk` export — no
 * `/experimental/*` import anywhere in this module or its callers.
 * Explicitly negotiates `protocolVersion: PROTOCOL_VERSION` (currently
 * `1`) and REJECTS any other returned major; there is no silent
 * downgrade/upgrade path.
 *
 * `AcpConnectOptions.stream` is normally `ndJsonStream(stdinWritable,
 * stdoutReadable)` over a spawned process's own stdio (task 3.2 owns the
 * spawn); tests pass an in-memory `Stream` (linked `TransformStream`
 * pair) so the SAME connection code exercises both the real stdio path
 * and a deterministic fake peer (task 6.1's contract suite).
 */

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type AnyMessage,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk"
import type * as schema from "@agentclientprotocol/sdk"
import wireSchema from "@agentclientprotocol/sdk/schema/schema.json"
import { RunnerOperationError } from "../ports.ts"
import type { RunnerSafetyStore } from "../runner-execution.ts"

export function journalAcpStream(stream: Stream, store: RunnerSafetyStore, generation: number) {
  let pending: { operationId: string; resolve: () => void; reject: (error: unknown) => void } | undefined
  return {
    track(operationId: string): Promise<void> {
      if (pending) throw new Error("ACP write already pending")
      const submitted = new Promise<void>((resolve, reject) => { pending = { operationId, resolve, reject } })
      void submitted.catch(() => {})
      return submitted
    },
    stream: {
      readable: stream.readable,
      writable: new WritableStream<AnyMessage>({
        async write(message) {
          const execution = !Array.isArray(message) && "method" in message
            && (message.method === "session/new" || message.method === "session/prompt")
          const tracked = execution ? pending : undefined
          let writer: WritableStreamDefaultWriter<AnyMessage> | undefined
          try {
            if (execution) {
              pending = undefined
              const operation = tracked && store.getOperation(tracked.operationId)
              const binding = operation && store.getRunnerBinding(operation.runId)
              if (!tracked || !operation || operation.ownerGeneration !== generation
                || binding?.daemonGeneration !== generation || binding.phase !== "active"
                || binding.transport !== "acp" || store.getFence(operation.runId)
                || !store.transitionOperationPhase(tracked.operationId, "prepared", "sending")) {
                throw new RunnerOperationError("ACP operation cannot enter write boundary", { delivery: "unknown" })
              }
            }
            writer = stream.writable.getWriter()
            await writer.write(message)
            if (tracked) {
              const operation = store.getOperation(tracked.operationId)
              const binding = operation && store.getRunnerBinding(operation.runId)
              if (binding?.phase !== "active" || binding.daemonGeneration !== generation
                || !store.transitionOperationPhase(tracked.operationId, "sending", "submitted")) {
                throw new RunnerOperationError("ACP submission ownership lost", { delivery: "unknown", operationId: tracked.operationId })
              }
              tracked.resolve()
            }
          } catch (error) {
            if (tracked) {
              try {
                store.transitionOperationPhase(tracked.operationId, "sending", "unknown", {
                  diagnosticCode: "write_failed",
                  diagnostic: error instanceof RunnerOperationError ? error.message : "ACP stdin write failed",
                })
              } finally {
                tracked.reject(error)
              }
            }
            throw error
          } finally {
            writer?.releaseLock()
          }
        },
      }),
    } satisfies Stream,
  }
}

/** Bounded frame size — an ACP stdio message longer than this is treated
 *  as a malformed/hostile frame rather than parsed (acp-execution spec:
 *  fail closed on a malformed frame, never buffer unboundedly). */
export const MAX_ACP_FRAME_BYTES = 8 * 1024 * 1024

/** Reject malformed input before SDK diagnostics can print credential-bearing frames. */
export function validatedAcpBytes(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let chunks: Uint8Array[] = []
  let length = 0
  return input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let start = 0
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue
        const part = chunk.subarray(start, i)
        length += part.length
        if (length > MAX_ACP_FRAME_BYTES) throw new Error("ACP frame bound exceeded")
        chunks.push(part)
        const bytes = new Uint8Array(length + 1)
        let offset = 0
        for (const piece of chunks) { bytes.set(piece, offset); offset += piece.length }
        bytes[length] = 10
        let message: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
          message = parsed as Record<string, unknown>
          if (message.jsonrpc !== "2.0") throw new Error()
          if (message.method !== undefined) {
            if (typeof message.method !== "string") throw new Error()
          } else if (!(typeof message.id === "string" || typeof message.id === "number") || !("result" in message || "error" in message)) throw new Error()
        } catch { throw new Error("Malformed ACP frame") }
        controller.enqueue(bytes)
        chunks = []; length = 0; start = i + 1
      }
      const remainder = chunk.subarray(start)
      length += remainder.length
      if (length > MAX_ACP_FRAME_BYTES) throw new Error("ACP frame bound exceeded")
      if (remainder.length) chunks.push(remainder.slice())
    },
    flush() { if (length) throw new Error("Incomplete ACP frame") },
  }))
}

// Validate against the pinned, public stable protocol schema before the
// SDK sees notifications. Error text is deliberately constant, not Zod/JSON
// diagnostics containing values from an untrusted peer.
function matchesWireSchema(value: unknown, raw: unknown, depth = 0): boolean {
  if (depth > 100) return false
  if (typeof raw === "boolean") return raw
  const s = raw as Record<string, unknown>
  if (!s || typeof s !== "object") return false
  const match = (v: unknown, rule: unknown) => matchesWireSchema(v, rule, depth + 1)
  if (s.$ref) {
    const name = String(s.$ref).replace("#/$defs/", "")
    return match(value, (wireSchema.$defs as Record<string, unknown>)[name])
  }
  if (Array.isArray(s.allOf) && !s.allOf.every(rule => match(value, rule))) return false
  if (Array.isArray(s.anyOf) && !s.anyOf.some(rule => match(value, rule))) return false
  if (Array.isArray(s.oneOf) && s.oneOf.filter(rule => match(value, rule)).length !== 1) return false
  if (s.not && match(value, s.not)) return false
  if ("const" in s && value !== s.const) return false
  if (Array.isArray(s.enum) && !s.enum.includes(value)) return false
  if (Array.isArray(s.type)) return s.type.some(type => match(value, { ...s, type }))
  if (s.type === "null" && value !== null) return false
  if (s.type === "string" && (typeof value !== "string" || value.length < Number(s.minLength ?? 0))) return false
  if (s.type === "boolean" && typeof value !== "boolean") return false
  if (s.type === "integer" || s.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (s.type === "integer" && !Number.isInteger(value))
      || value < Number(s.minimum ?? -Infinity) || value > Number(s.maximum ?? Infinity)) return false
  }
  if (s.type === "array") {
    if (!Array.isArray(value) || (s.items && !value.every(v => match(v, s.items)))) return false
  }
  if (s.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const object = value as Record<string, unknown>
    if (Array.isArray(s.required) && !s.required.every(key => String(key) in object)) return false
    const properties = (s.properties ?? {}) as Record<string, unknown>
    for (const [key, v] of Object.entries(object)) {
      if (key in properties) { if (!match(v, properties[key])) return false }
      else if (s.additionalProperties === false) return false
      else if (typeof s.additionalProperties === "object" && !match(v, s.additionalProperties)) return false
    }
  }
  return true
}

function guardedAcpStream(stream: Stream): Stream {
  const pending = new Set<unknown>()
  return {
    writable: new WritableStream<AnyMessage>({ async write(message) {
      if ("method" in message && "id" in message) pending.add(message.id)
      const writer = stream.writable.getWriter()
      try { await writer.write(message) } finally { writer.releaseLock() }
    } }),
    readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({ transform(message, controller) {
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") throw new Error("Malformed ACP frame")
      if ("method" in message) {
        if (!("id" in message)) {
          if (message.method !== "session/update" || !matchesWireSchema(message.params, wireSchema.$defs.SessionNotification)) throw new Error("Invalid ACP notification")
        } else if (typeof message.method !== "string" || !(typeof message.id === "number" || typeof message.id === "string")) throw new Error("Invalid ACP request")
      } else {
        if (!pending.delete(message.id)) throw new Error("Unknown ACP response")
        if (("result" in message) === ("error" in message)) throw new Error("Invalid ACP response")
        if ("error" in message) {
          if (!message.error || typeof message.error.code !== "number") throw new Error("Invalid ACP response")
          controller.enqueue({ jsonrpc: "2.0", id: message.id, error: { code: message.error.code, message: "ACP request failed" } })
          return
        }
      }
      controller.enqueue(message)
    } })),
  }
}

export type AcpInitializeOutcome =
  | { readonly ok: true; readonly response: schema.InitializeResponse }
  | { readonly ok: false; readonly reason: "incompatible_protocol_major"; readonly requestedMajor: number; readonly returnedMajor: number }
  | { readonly ok: false; readonly reason: "malformed_response"; readonly diagnostic: string }
  | { readonly ok: false; readonly reason: "connection_error"; readonly diagnostic: string }

/**
 * The minimal client-side ACP callback surface the connection needs —
 * everything the SDK's `Client` interface requires PLUS the optional
 * capabilities this adapter chooses to support. Kept separate from the
 * full permissions/process modules (tasks 3.2/3.5) so this module stays
 * connection-only.
 */
export type AcpClientHandlers = Client

export interface AcpConnectOptions {
  readonly stream: Stream
  readonly client: AcpClientHandlers
  /** Bounded startup deadline for `initialize` — task 3.4 supplies the
   *  real per-profile value; defaults to a conservative 30s so a caller
   *  that forgets this never hangs forever. */
  readonly startupTimeoutMs?: number
}

export interface AcpConnectionHandle {
  readonly connection: ClientSideConnection
  readonly initializeOutcome: AcpInitializeOutcome
  /** Resolves once the underlying stream closes (peer exit, EOF, or an
   *  explicit `close()`). Never rejects — a transport close is not
   *  itself an error the caller must catch, just a state to observe. */
  readonly closed: Promise<void>
  close(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Validates the SHAPE of an `InitializeResponse` beyond what a thrown
 *  JSON-RPC error already catches — a peer that returns 200-shaped JSON
 *  with a missing/non-numeric `protocolVersion` must fail closed here,
 *  not crash deeper in the adapter on `undefined.something`. */
function validateInitializeResponseShape(value: unknown): value is schema.InitializeResponse {
  return isRecord(value) && typeof value["protocolVersion"] === "number"
}

/**
 * Connects a client-side ACP 1 connection over `stream` and negotiates
 * the protocol. Returns a handle whose `initializeOutcome` the caller
 * MUST check before ever calling `newSession`/`prompt` — an
 * incompatible major or malformed response means "no task prompt is
 * sent" (acp-execution spec: "Unsupported protocol or binding").
 */
export async function connectAcp(options: AcpConnectOptions): Promise<AcpConnectionHandle> {
  const connection = new ClientSideConnection(() => ({ ...options.client,
    sessionUpdate: async notification => {
      // Never allow a callback exception to enter the SDK's raw-message
      // notification diagnostic path.
      try { await options.client.sessionUpdate(notification) } catch { /* connection-local sink containment */ }
    },
  }), guardedAcpStream(options.stream))
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000

  const initializeOutcome = await runInitialize(connection, startupTimeoutMs)

  return {
    connection,
    initializeOutcome,
    closed: connection.closed.catch(() => undefined),
    close() {
      // `ClientSideConnection` (the SDK's own LEGACY, still-supported
      // surface this module deliberately uses per D2) exposes `signal`/
      // `closed` publicly but does NOT itself expose a `close()` method
      // at all — verified against the pinned 1.5.0 package's own type
      // declarations and runtime prototype, not merely undocumented.
      // The PRIVATE `connection` field it wraps (the raw jsonrpc
      // `Connection`) is what actually implements `close(error?)` and
      // is what its OWN internal `connectConnection` helpers call to
      // tear down a peer. Calling a nonexistent `.close` on the public
      // wrapper (a bare optional-chained no-op) would silently leave
      // the stream/process connection open forever — reach into the
      // private field explicitly instead of guessing at an API this
      // SDK version does not have.
      if (connection.signal.aborted) return
      const raw = (connection as unknown as { connection?: { close?: (error?: unknown) => void } }).connection
      raw?.close?.()
    },
  }
}

async function runInitialize(connection: ClientSideConnection, timeoutMs: number): Promise<AcpInitializeOutcome> {
  const request: schema.InitializeRequest = {
    protocolVersion: 1,
    clientCapabilities: {
      // Deny-default: no fs/terminal capability advertised until D9's
      // permission module explicitly grants one. Advertising a
      // capability here means the AGENT may call back for it — a bare
      // connection module must never advertise anything on its own.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  }
  let response: schema.InitializeResponse
  try {
    response = await withTimeout(connection.initialize(request), timeoutMs, "initialize")
  } catch (error) {
    if (error instanceof RequestError) {
      return { ok: false, reason: "connection_error", diagnostic: `initialize failed (code ${error.code})` }
    }
    return { ok: false, reason: "connection_error", diagnostic: `initialize failed: ${errorMessage(error)}` }
  }
  if (!validateInitializeResponseShape(response)) {
    return { ok: false, reason: "malformed_response", diagnostic: "initialize response missing a numeric protocolVersion" }
  }
  // Explicit major-only comparison — never trust a moving constant
  // without asserting it is exactly what was requested (D2: "explicitly
  // negotiate protocolVersion: 1 and reject any different response").
  if (PROTOCOL_VERSION !== 1 || response.protocolVersion !== 1) {
    return {
      ok: false,
      reason: "incompatible_protocol_major",
      requestedMajor: 1,
      returnedMajor: response.protocolVersion,
    }
  }
  return { ok: true, response }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms startup deadline`)), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function errorMessage(_error: unknown): string {
  return "transport failure or startup deadline exceeded"
}

/**
 * Builds an in-memory message-level `Stream` pair for deterministic
 * tests — bypasses NDJSON byte framing entirely (each side's `writable`
 * feeds the other's `readable` as already-parsed `AnyMessage` values).
 * Fast, and exercises exactly the same `ClientSideConnection`/`Agent`
 * contract real stdio does; use `createLinkedStdioStreamPair` below when
 * a test specifically needs to exercise NDJSON byte framing (malformed
 * frames, frame-size bounds, split/fragmented writes).
 */
export function createLinkedStreamPair(): readonly [Stream, Stream] {
  const aToB = new TransformStream<AnyMessage, AnyMessage>()
  const bToA = new TransformStream<AnyMessage, AnyMessage>()
  return [
    { writable: aToB.writable, readable: bToA.readable },
    { writable: bToA.writable, readable: aToB.readable },
  ]
}

/**
 * Builds a BYTE-level linked pair wrapped through the SDK's own
 * `ndJsonStream` — the stdio fake peer (task 6.1: "both in-memory and
 * stdio fake peers pass the same applicable contract cases"). A test can
 * write raw malformed bytes directly into the underlying byte transform
 * (via the returned raw writers) to exercise malformed-frame/EOF/frame-
 * bound handling that the message-level pair above cannot express.
 */
export function createLinkedStdioStreamPair(): {
  readonly a: Stream
  readonly b: Stream
  readonly rawAToB: TransformStream<Uint8Array, Uint8Array>
  readonly rawBToA: TransformStream<Uint8Array, Uint8Array>
} {
  const rawAToB = new TransformStream<Uint8Array, Uint8Array>()
  const rawBToA = new TransformStream<Uint8Array, Uint8Array>()
  return {
    a: ndJsonStream(rawAToB.writable, rawBToA.readable),
    b: ndJsonStream(rawBToA.writable, rawAToB.readable),
    rawAToB,
    rawBToA,
  }
}
