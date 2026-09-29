import { describe, expect, it } from "bun:test"
import {
  NATIVE_SESSION_CAPABILITIES,
  RunnerOperationError,
  sessionCapabilitiesOf,
  type SessionClient,
} from "./src/ports.ts"
import {
  deriveOperationLogicalKey,
  isTerminalOperationPhase,
  operationKindForPurpose,
  operationPotentiallyDelivered,
  requiresFence,
} from "./src/runner-execution.ts"
import { createRunnerSessionClient } from "./src/runner-transport.ts"
import { RunnerRegistry } from "./src/runner-registry.ts"

// ---------------------------------------------------------------------------
// 1.1: existing native implementations/type fixtures remain structurally
// compatible with the frozen D4 SessionClient port.
// ---------------------------------------------------------------------------

describe("D4 SessionClient: native structural compatibility", () => {
  it("createRunnerSessionClient (native HTTP transport) satisfies the frozen port unmodified", () => {
    const registry = new RunnerRegistry()
    const client: SessionClient = createRunnerSessionClient({ runners: registry })
    // No `prepare`, `observeOperation` or `capabilities` — the native
    // transport implements none of the D4 additions.
    expect(client.prepare).toBeUndefined()
    expect(client.observeOperation).toBeUndefined()
    expect(client.capabilities).toBeUndefined()
  })

  it("a bare-minimum fixture object (no D4 methods at all) still satisfies SessionClient", () => {
    // This is the exact shape every existing engine.test.ts FakeSessions
    // fixture already provides — if this type-checks, no existing test
    // fixture needed to change for D4.
    const minimal: SessionClient = {
      async createSession(input) {
        return { id: `ses-${input.title}` }
      },
      async prompt() {
        // native contract: resolves void
      },
      async sessionExists() {
        return true
      },
      async status() {
        return "busy"
      },
      async note() {
        // no-op
      },
      async abort() {
        // no-op
      },
    }
    expect(typeof minimal.createSession).toBe("function")
  })

  it("sessionCapabilitiesOf fails closed to the native default when capabilities() is absent", () => {
    const minimal: SessionClient = {
      async createSession(input) {
        return { id: input.title }
      },
      async prompt() {},
      async sessionExists() {
        return true
      },
      async status() {
        return "idle"
      },
      async note() {},
      async abort() {},
    }
    expect(sessionCapabilitiesOf(minimal)).toEqual(NATIVE_SESSION_CAPABILITIES)
  })

  it("sessionCapabilitiesOf reads an implementation's own capabilities() when present", () => {
    const acpLike: SessionClient = {
      async createSession(input) {
        return { id: input.title }
      },
      async prompt() {
        return { kind: "submitted", operationId: "op-1" }
      },
      async sessionExists() {
        return true
      },
      async status() {
        return "unknown"
      },
      async note() {},
      async abort() {},
      capabilities() {
        return { parentSessions: false, nonInferentialNotes: false, promptConfirmation: "submitted" }
      },
    }
    expect(sessionCapabilitiesOf(acpLike)).toEqual({
      parentSessions: false,
      nonInferentialNotes: false,
      promptConfirmation: "submitted",
    })
  })

  it("prompt()'s union return type accepts both the native void contract and ACP's submitted marker", async () => {
    const native: SessionClient["prompt"] = async () => undefined
    const acp: SessionClient["prompt"] = async () => ({ kind: "submitted", operationId: "op-2" })
    expect(await native({ sessionID: "s", text: "x" })).toBeUndefined()
    expect(await acp({ sessionID: "s", text: "x" })).toEqual({ kind: "submitted", operationId: "op-2" })
  })

  it("SessionStatus's new \"unknown\" member is assignable wherever the old four-value union was", async () => {
    const client: SessionClient = {
      async createSession(input) {
        return { id: input.title }
      },
      async prompt() {},
      async sessionExists() {
        return true
      },
      async status() {
        return "unknown"
      },
      async note() {},
      async abort() {},
    }
    expect(await client.status("any")).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// 1.1: unsupported optional operations fail closed
// ---------------------------------------------------------------------------

describe("D4 optional operations: fail closed when unsupported", () => {
  it("prepare() is undefined on a native-only client — callers must treat absence as \"no preparation needed\", never call it blindly", () => {
    const registry = new RunnerRegistry()
    const client = createRunnerSessionClient({ runners: registry })
    expect(client.prepare).toBeUndefined()
    // The fail-closed contract: a caller MUST guard with `sessions.prepare?.(...)`
    // and treat `undefined` as "skip preparation", never crash or assume success.
    const result = client.prepare?.({ projectDir: "/p", directory: "/p", agent: "build" })
    expect(result).toBeUndefined()
  })

  it("observeOperation() absence means the implementation has nothing async to observe", () => {
    const registry = new RunnerRegistry()
    const client = createRunnerSessionClient({ runners: registry })
    expect(client.observeOperation).toBeUndefined()
  })

  it("RunnerOperationError.delivery is exactly not_sent or unknown — no third confirmed-failure shape exists", () => {
    const proven = new RunnerOperationError("write never attempted", { delivery: "not_sent" })
    const uncertain = new RunnerOperationError("response lost", { delivery: "unknown", operationId: "op-3" })
    expect(proven.delivery).toBe("not_sent")
    expect(uncertain.delivery).toBe("unknown")
    expect(uncertain.operationId).toBe("op-3")
    expect(requiresFence(proven.delivery)).toBe(false)
    expect(requiresFence(uncertain.delivery)).toBe(true)
  })

  it("RunnerOperationError defaults diagnostic to the message when omitted", () => {
    const err = new RunnerOperationError("boom", { delivery: "unknown" })
    expect(err.diagnostic).toBe("boom")
  })
})

// ---------------------------------------------------------------------------
// runner-execution.ts pure helpers
// ---------------------------------------------------------------------------

describe("deriveOperationLogicalKey", () => {
  it("keys create and prompt(initial) by run id", () => {
    expect(deriveOperationLogicalKey("create", { runId: "run-1" })).toBe("run-1")
    expect(deriveOperationLogicalKey("prompt", { runId: "run-1" })).toBe("run-1")
  })

  it("keys answer by delivery token, not run id", () => {
    expect(deriveOperationLogicalKey("answer", { runId: "run-1", deliveryToken: "tok-abc" })).toBe("tok-abc")
  })

  it("throws for answer without a delivery token — a programming error, not a soft failure", () => {
    expect(() => deriveOperationLogicalKey("answer", { runId: "run-1" })).toThrow()
  })

  it("keys nudge by a durable ordinal, distinct from the initial prompt", () => {
    expect(deriveOperationLogicalKey("nudge", { runId: "run-1", nudgeOrdinal: 1 })).toBe("nudge:1")
    expect(deriveOperationLogicalKey("nudge", { runId: "run-1", nudgeOrdinal: 2 })).toBe("nudge:2")
    expect(deriveOperationLogicalKey("nudge", { runId: "run-1", nudgeOrdinal: 1 }))
      .not.toBe(deriveOperationLogicalKey("prompt", { runId: "run-1" }))
  })

  it("throws for nudge without an ordinal", () => {
    expect(() => deriveOperationLogicalKey("nudge", { runId: "run-1" })).toThrow()
  })
})

describe("operationKindForPurpose", () => {
  it("maps answer/nudge purposes to their own kinds and everything else to prompt", () => {
    expect(operationKindForPurpose("answer")).toBe("answer")
    expect(operationKindForPurpose("nudge")).toBe("nudge")
    expect(operationKindForPurpose("initial")).toBe("prompt")
    expect(operationKindForPurpose(undefined)).toBe("prompt")
  })
})

describe("operationPotentiallyDelivered / isTerminalOperationPhase", () => {
  it("only not_sent is proven safe to retry", () => {
    expect(operationPotentiallyDelivered("not_sent")).toBe(false)
    for (const phase of ["prepared", "sending", "submitted", "completed", "unknown"] as const) {
      expect(operationPotentiallyDelivered(phase)).toBe(true)
    }
  })

  it("not_sent and unknown are terminal phases; prepared/sending/submitted are not", () => {
    expect(isTerminalOperationPhase("not_sent")).toBe(true)
    expect(isTerminalOperationPhase("unknown")).toBe(true)
    expect(isTerminalOperationPhase("completed")).toBe(true)
    expect(isTerminalOperationPhase("prepared")).toBe(false)
    expect(isTerminalOperationPhase("sending")).toBe(false)
    expect(isTerminalOperationPhase("submitted")).toBe(false)
  })
})
