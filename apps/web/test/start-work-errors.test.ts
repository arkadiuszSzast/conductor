/**
 * `mapStartFeatureError` — maps `POST /v1/features` failures to inline
 * copy, per-input errors, and whether the selected target's workflow
 * metadata should be refreshed (design.md "Server rejection preserves
 * the form" / "refreshes affected target metadata").
 */
import { describe, expect, it } from "bun:test"
import { ApiError } from "../src/api/client.ts"
import { mapStartFeatureError } from "../src/start-work/errors.ts"

describe("mapStartFeatureError", () => {
  it("an invalid_input rejection maps diagnostics to per-input errors and refreshes the target", () => {
    const err = new ApiError(422, "invalid_input", 'input "feature" is required', "r-1", [
      { name: "feature", kind: "missing_required", message: 'input "feature" is required (type: string)' },
      { name: "count", kind: "wrong_type", message: '"count" must be a number' },
    ])
    const handled = mapStartFeatureError(err)
    expect(handled.refreshTarget).toBe(true)
    expect(handled.inputErrors).toEqual({
      feature: 'input "feature" is required (type: string)',
      count: '"count" must be a number',
    })
  })

  it("an invalid_payload diagnostic (no name) is not attributed to any single input", () => {
    const err = new ApiError(422, "invalid_input", "inputs must be an object", "r-2", [
      { kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" },
    ])
    const handled = mapStartFeatureError(err)
    expect(handled.inputErrors).toEqual({})
    expect(handled.message).toBe("inputs must be an object")
  })

  it("project_not_configured refreshes target metadata with no per-input errors", () => {
    const err = new ApiError(422, "project_not_configured", 'no valid conductor.yaml registered for "/p"', "r-3")
    const handled = mapStartFeatureError(err)
    expect(handled.refreshTarget).toBe(true)
    expect(handled.inputErrors).toEqual({})
  })

  it("unknown_workflow (a configuration race) also refreshes target metadata", () => {
    const err = new ApiError(422, "unknown_workflow", 'unknown workflow "old" (available: new)', "r-4")
    const handled = mapStartFeatureError(err)
    expect(handled.refreshTarget).toBe(true)
  })

  it("a 401 surfaces an inline message but does not request a target refresh", () => {
    const err = new ApiError(401, "unauthorized", "missing or invalid bearer token", "r-5")
    const handled = mapStartFeatureError(err)
    expect(handled.refreshTarget).toBe(false)
    expect(handled.message).toContain("bearer")
  })

  it("a generic server error carries the requestId for correlation", () => {
    const err = new ApiError(500, "internal", "boom", "req-42")
    const handled = mapStartFeatureError(err)
    expect(handled.message).toContain("req-42")
    expect(handled.refreshTarget).toBe(false)
  })

  it("non-ApiError failures degrade to a plain message", () => {
    const handled = mapStartFeatureError(new Error("network down"))
    expect(handled.message).toContain("network down")
    expect(handled.refreshTarget).toBe(false)
  })
})
