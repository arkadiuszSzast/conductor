/**
 * Gate decision logic — note validation mirroring the API's 400 and the
 * error-envelope → UI behavior mapping (409 race → toast + refetch).
 */
import { describe, expect, it } from "bun:test"
import { ApiError } from "../src/api/client.ts"
import { mapGateError, selectGateSurface, validateGateDecision } from "../src/gate/gate-logic.ts"

describe("gate validation", () => {
  it("approve needs no note", () => {
    expect(validateGateDecision({ action: "approve", notes: "" })).toBeNull()
  })

  it("request-changes with an empty note is blocked before any request", () => {
    expect(validateGateDecision({ action: "request-changes", notes: "" })).not.toBeNull()
    expect(validateGateDecision({ action: "request-changes", notes: "   " })).not.toBeNull()
  })

  it("request-changes with a note passes", () => {
    expect(validateGateDecision({ action: "request-changes", notes: "tighten the tests" })).toBeNull()
  })
})

describe("gate error mapping", () => {
  it("409 shows the server's message and demands a refetch", () => {
    const handled = mapGateError(new ApiError(409, "conflict", "feature is not waiting for approval (status: running)", "r-1"))
    expect(handled.toast).toContain("not waiting for approval")
    expect(handled.refetch).toBe(true)
    expect(handled.inline).toBe(false)
  })

  it("400 lands inline, not as a toast", () => {
    const handled = mapGateError(new ApiError(400, "invalid_request", "notes required", "r-2"))
    expect(handled.inline).toBe(true)
    expect(handled.refetch).toBe(false)
  })

  it("404 reads as feature-gone and refetches", () => {
    const handled = mapGateError(new ApiError(404, "not_found", 'unknown feature "x"', "r-3"))
    expect(handled.toast).toContain("gone")
    expect(handled.refetch).toBe(true)
  })

  it("500 carries the requestId for log correlation", () => {
    const handled = mapGateError(new ApiError(500, "internal", "boom", "req-42"))
    expect(handled.toast).toContain("req-42")
  })

  it("non-ApiError failures degrade to a plain toast", () => {
    const handled = mapGateError(new Error("network down"))
    expect(handled.toast).toContain("network down")
    expect(handled.refetch).toBe(true)
  })
})

describe("selectGateSurface", () => {
  const askingRun = { id: "run-1", stepId: "explore", pendingQuestion: "Which storage?" }

  it("returns null when the feature is not waiting", () => {
    expect(selectGateSurface(false, "gate prompt", askingRun)).toBeNull()
  })

  it("a waiting gate step wins over an asking run", () => {
    const surface = selectGateSurface(true, "merge?", askingRun)
    expect(surface).toEqual({ kind: "gate", prompt: "merge?" })
  })

  it("an asking run claims the panel when no gate step waits", () => {
    const surface = selectGateSurface(true, null, askingRun)
    expect(surface).toEqual({ kind: "ask", runId: "run-1", stepId: "explore", prompt: "Which storage?" })
  })

  it("waiting with neither prompt nor question is a bare gate", () => {
    expect(selectGateSurface(true, null, null)).toEqual({ kind: "gate", prompt: null })
    expect(selectGateSurface(true, null, { id: "r", stepId: "s", pendingQuestion: null })).toEqual({ kind: "gate", prompt: null })
  })
})
