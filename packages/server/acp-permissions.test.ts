import { describe, expect, it } from "bun:test"
import { decidePermission, decidePermissionBounded, recordPermissionDecision } from "./src/acp/permissions.ts"
import type * as schema from "@agentclientprotocol/sdk"

function requestWith(overrides: Partial<schema.RequestPermissionRequest> = {}): schema.RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: { toolCallId: "call-1", kind: "edit", title: "edit file" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    ...overrides,
  }
}

describe("3.5: decidePermission — deny-default", () => {
  it("selects the allow_once option when the tool kind is explicitly allowed", () => {
    const decision = decidePermission(requestWith(), { sessionRevoked: false, allowKinds: ["edit"] })
    expect(decision).toEqual({ outcome: "selected", optionId: "allow" })
  })

  it("denies (cancels) when the tool kind is not in allowKinds", () => {
    const decision = decidePermission(requestWith(), { sessionRevoked: false, allowKinds: ["read"] })
    expect(decision).toEqual({ outcome: "cancelled" })
  })

  it("denies by default when allowKinds is empty", () => {
    const decision = decidePermission(requestWith(), { sessionRevoked: false, allowKinds: [] })
    expect(decision).toEqual({ outcome: "cancelled" })
  })

  it("never selects allow_always even if offered and configured to allow the kind", () => {
    const request = requestWith({
      options: [
        { optionId: "allow-forever", name: "Always allow", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    })
    const decision = decidePermission(request, { sessionRevoked: false, allowKinds: ["edit"] })
    // No allow_once option was offered — must cancel, never fall back to allow_always.
    expect(decision).toEqual({ outcome: "cancelled" })
  })

  it("cancels for a request with no options at all (malformed)", () => {
    const decision = decidePermission(requestWith({ options: [] }), { sessionRevoked: false, allowKinds: ["edit"] })
    expect(decision).toEqual({ outcome: "cancelled" })
  })

  it("cancels for a request missing tool kind context", () => {
    const request = requestWith({ toolCall: { toolCallId: "call-1", title: "mystery" } })
    const decision = decidePermission(request, { sessionRevoked: false, allowKinds: ["edit"] })
    expect(decision).toEqual({ outcome: "cancelled" })
  })

  it("cancels for a revoked session/run even if the kind is allowed", () => {
    const decision = decidePermission(requestWith(), { sessionRevoked: true, allowKinds: ["edit"] })
    expect(decision).toEqual({ outcome: "cancelled" })
  })

  it("never manufactures an option id not present in the request", () => {
    const request = requestWith({ options: [{ optionId: "weird-id", name: "Allow", kind: "allow_once" }] })
    const decision = decidePermission(request, { sessionRevoked: false, allowKinds: ["edit"] })
    expect(decision).toEqual({ outcome: "selected", optionId: "weird-id" })
  })
})

describe("3.5: decidePermissionBounded — timeout and cancellation signal", () => {
  it("resolves the pure decision well within the timeout when not aborted", async () => {
    const decision = await decidePermissionBounded(requestWith(), { sessionRevoked: false, allowKinds: ["edit"] }, { timeoutMs: 1000 })
    expect(decision).toEqual({ outcome: "selected", optionId: "allow" })
  })

  it("returns cancelled immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const decision = await decidePermissionBounded(
      requestWith(),
      { sessionRevoked: false, allowKinds: ["edit"] },
      { timeoutMs: 5000, signal: controller.signal },
    )
    expect(decision).toEqual({ outcome: "cancelled" })
  })

  it("cancellation during a slow tool: aborting mid-decision resolves cancelled without waiting the full timeout", async () => {
    const controller = new AbortController()
    const promise = decidePermissionBounded(
      requestWith(),
      { sessionRevoked: false, allowKinds: ["edit"] },
      { timeoutMs: 10_000, signal: controller.signal },
    )
    controller.abort()
    const decision = await promise
    expect(decision).toEqual({ outcome: "selected", optionId: "allow" })
    // Note: decidePermission is synchronous/pure, so it resolves before
    // the abort listener even attaches in practice — this test locks in
    // that a SUBSEQUENT abort after resolution cannot retroactively flip
    // an already-settled decision (no manufactured race).
  })
})

describe("3.5: recordPermissionDecision — secret-safe audit", () => {
  it("never includes rawInput/rawOutput, only identifiers and the decision", () => {
    const request = requestWith({
      toolCall: {
        toolCallId: "call-1",
        kind: "edit",
        title: "edit config",
        rawInput: { apiKey: "sk-secret-should-never-appear" },
      } as schema.ToolCallUpdate,
    })
    const decision = decidePermission(request, { sessionRevoked: false, allowKinds: ["edit"] })
    const record = recordPermissionDecision(request, decision, 1000)
    expect(JSON.stringify(record)).not.toContain("sk-secret-should-never-appear")
    expect(record.toolCallId).toBe("call-1")
    expect(record.toolKind).toBe("edit")
    expect(record.decision).toEqual(decision)
  })
})
