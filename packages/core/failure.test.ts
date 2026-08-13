import { describe, expect, it } from "bun:test"
import { FAILURE_CLASSES, RESOURCE_REASONS, boundDiagnostic, makeFailureEnvelope, normalizeFailureClass } from "./src/failure.ts"

describe("normalizeFailureClass", () => {
  it("passes through every known class unchanged", () => {
    for (const failureClass of FAILURE_CLASSES) {
      expect(normalizeFailureClass(failureClass)).toBe(failureClass)
    }
  })

  it("defaults an unknown string to internal", () => {
    expect(normalizeFailureClass("totally_made_up")).toBe("internal")
  })

  it("defaults a missing/non-string value to internal — never silently success", () => {
    expect(normalizeFailureClass(undefined)).toBe("internal")
    expect(normalizeFailureClass(null)).toBe("internal")
    expect(normalizeFailureClass(42)).toBe("internal")
    expect(normalizeFailureClass({})).toBe("internal")
  })
})

describe("boundDiagnostic", () => {
  it("leaves short text untouched", () => {
    expect(boundDiagnostic("exit 1")).toBe("exit 1")
  })

  it("truncates diagnostics past the bound rather than leaking a log dump", () => {
    const huge = "x".repeat(10_000)
    const bounded = boundDiagnostic(huge)
    expect(bounded.length).toBeLessThan(huge.length)
    expect(bounded.length).toBe(4000)
  })
})

describe("makeFailureEnvelope", () => {
  it("never parses the diagnostic text to decide class — a malformed adapter payload still normalizes safely", () => {
    const envelope = makeFailureEnvelope({
      class: undefined,
      diagnostic: "HTTP 503 from provider — looks transient but adapter forgot to classify it",
      source: "runner:opencode",
    })
    expect(envelope.class).toBe("internal")
    expect(envelope.diagnostic).toContain("503")
  })

  it("carries a valid class through unchanged", () => {
    const envelope = makeFailureEnvelope({ class: "transient_upstream", diagnostic: "503", source: "runner" })
    expect(envelope.class).toBe("transient_upstream")
  })

  it("clamps a negative retry hint to zero and preserves a positive one", () => {
    expect(makeFailureEnvelope({ diagnostic: "d", source: "s", retryHintMs: -100 }).retryHintMs).toBe(0)
    expect(makeFailureEnvelope({ diagnostic: "d", source: "s", retryHintMs: 5000 }).retryHintMs).toBe(5000)
  })

  it("omits retryHintMs when not supplied", () => {
    expect(makeFailureEnvelope({ diagnostic: "d", source: "s" }).retryHintMs).toBeUndefined()
  })
})

describe("taxonomy completeness", () => {
  it("declares every documented resource-unavailability reason", () => {
    expect(RESOURCE_REASONS).toEqual(["runner_unavailable", "binding_unavailable", "dependency_unavailable"])
  })

  it("declares the full closed v1 class vocabulary", () => {
    const expected: readonly string[] = [
      "transient_upstream",
      "transient_transport",
      "capacity",
      "timeout",
      "deterministic_failure",
      "invalid_config",
      "missing_session",
      "cancelled",
      "internal",
    ]
    const actual: readonly string[] = FAILURE_CLASSES
    expect([...actual].sort()).toEqual([...expected].sort())
  })
})
