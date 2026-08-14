import { describe, expect, it } from "bun:test"
import { NO_EXTERNAL_ANCHORS, allJobsTerminalStatus, checkActiveStateInvariant, progressAnchors } from "./src/invariant.ts"
import type { AnchorState } from "./src/invariant.ts"
import { featureState, jobRuntime } from "./testing.ts"

const runningAnchor: AnchorState = { ...NO_EXTERNAL_ANCHORS, hasActiveRun: true }

describe("allJobsTerminalStatus", () => {
  it("false when a feature has no jobs at all", () => {
    expect(allJobsTerminalStatus(featureState({}))).toBe(false)
  })

  it("false while any job is non-terminal", () => {
    const state = featureState({
      a: jobRuntime({ status: "succeeded" }),
      b: jobRuntime({ status: "running" }),
    })
    expect(allJobsTerminalStatus(state)).toBe(false)
  })

  it("true once every job is succeeded/failed/skipped", () => {
    const state = featureState({
      a: jobRuntime({ status: "succeeded" }),
      b: jobRuntime({ status: "failed" }),
      c: jobRuntime({ status: "skipped" }),
    })
    expect(allJobsTerminalStatus(state)).toBe(true)
  })
})

describe("progressAnchors", () => {
  it("empty when nothing anchors the feature", () => {
    const state = featureState({ a: jobRuntime({ status: "pending" }) }, { status: "running" })
    expect(progressAnchors(state, NO_EXTERNAL_ANCHORS)).toEqual([])
  })

  it("reports active_run from the external anchor state", () => {
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "running" })
    expect(progressAnchors(state, runningAnchor)).toContain("active_run")
  })

  it("reports human_gate purely from waiting_human step status", () => {
    const state = featureState(
      { a: jobRuntime({ status: "running", steps: { s: { status: "waiting_human", outputs: {} } } }) },
      { status: "waiting_human" },
    )
    expect(progressAnchors(state, NO_EXTERNAL_ANCHORS)).toEqual(["human_gate"])
  })

  it("reports paused_pending_work purely from feature status", () => {
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "paused" })
    expect(progressAnchors(state, NO_EXTERNAL_ANCHORS)).toEqual(["paused_pending_work"])
  })

  it("reports every external anchor kind when present", () => {
    const external: AnchorState = {
      hasActiveRun: true,
      hasDueRetry: true,
      hasResourceWait: true,
      hasUnhandledOutboxDecision: true,
    }
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "running" })
    expect(progressAnchors(state, external)).toEqual(
      expect.arrayContaining(["active_run", "due_retry", "resource_wait", "unhandled_outbox_decision"]),
    )
  })
})

describe("checkActiveStateInvariant", () => {
  it("done is unconditionally terminal — no anchor required", () => {
    const state = featureState({}, { status: "done" })
    expect(checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)).toEqual({ kind: "terminal" })
  })

  it("abandoned is unconditionally terminal", () => {
    const state = featureState({}, { status: "abandoned" })
    expect(checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)).toEqual({ kind: "terminal" })
  })

  it("escalated is terminal — it already explains its own halt, no anchor required", () => {
    const state = featureState({ a: jobRuntime({ status: "failed" }) }, { status: "escalated" })
    expect(checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)).toEqual({ kind: "terminal" })
  })

  it("a running feature with an active run is ok", () => {
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "running" })
    expect(checkActiveStateInvariant(state, runningAnchor)).toEqual({ kind: "ok" })
  })

  it("flags the legacy stranded shape: running with all jobs terminal and at least one failed", () => {
    const state = featureState(
      { a: jobRuntime({ status: "failed" }), b: jobRuntime({ status: "skipped" }) },
      { status: "running" },
    )
    const result = checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)
    expect(result.kind).toBe("stranded_legacy_failure")
  })

  it("does NOT flag legacy-stranded when all jobs are terminal but none failed (should have reached done)", () => {
    const state = featureState({ a: jobRuntime({ status: "succeeded" }) }, { status: "running" })
    const result = checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)
    expect(result.kind).toBe("stranded_no_anchor")
  })

  it("flags a running feature with no anchor and no all-terminal-failed shape as stranded_no_anchor", () => {
    const state = featureState({ a: jobRuntime({ status: "pending" }) }, { status: "running" })
    const result = checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)
    expect(result).toMatchObject({ kind: "stranded_no_anchor", anchors: [] })
  })

  it("a waiting_human feature with an armed gate is ok even with no external anchors", () => {
    const state = featureState(
      { a: jobRuntime({ status: "running", steps: { s: { status: "waiting_human", outputs: {} } } }) },
      { status: "waiting_human" },
    )
    expect(checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)).toEqual({ kind: "ok" })
  })

  it("a paused feature is ok purely from its own status, with no other anchor", () => {
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "paused" })
    expect(checkActiveStateInvariant(state, NO_EXTERNAL_ANCHORS)).toEqual({ kind: "ok" })
  })

  it("a running feature anchored only by a due retry is ok", () => {
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "running" })
    expect(checkActiveStateInvariant(state, { ...NO_EXTERNAL_ANCHORS, hasDueRetry: true })).toEqual({ kind: "ok" })
  })

  it("a running feature anchored only by a resource wait is ok", () => {
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "running" })
    expect(checkActiveStateInvariant(state, { ...NO_EXTERNAL_ANCHORS, hasResourceWait: true })).toEqual({ kind: "ok" })
  })

  it("a running feature anchored only by an unhandled outbox decision is ok", () => {
    const state = featureState({ a: jobRuntime({ status: "running" }) }, { status: "running" })
    expect(checkActiveStateInvariant(state, { ...NO_EXTERNAL_ANCHORS, hasUnhandledOutboxDecision: true })).toEqual({ kind: "ok" })
  })
})
