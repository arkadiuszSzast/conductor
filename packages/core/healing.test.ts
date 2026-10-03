import { describe, expect, it } from "bun:test"
import {
  DEFAULT_HEALING_POLICY,
  classifyFence,
  healingDelayMs,
  needsAttention,
  normalizeHealingPolicy,
} from "./src/healing.ts"
import type { FenceCleanupEvidence, FenceEvidence } from "./src/healing.ts"

const fixed = (value: number) => ({ next: () => value })

describe("classifyFence", () => {
  const cleanups: FenceCleanupEvidence[] = ["confirmed_terminated", "operator_attested", "unconfirmed"]
  const bools = [false, true]

  it("is exhaustive over the evidence truth table", () => {
    for (const cleanup of cleanups) for (const sessionBound of bools) for (const promptLeftPrepared of bools)
      for (const stepReplaySafe of bools) for (const pendingAnswerDelivery of bools) {
        const evidence: FenceEvidence = { cleanup, sessionBound, promptLeftPrepared, stepReplaySafe, pendingAnswerDelivery }
        const expected = cleanup !== "confirmed_terminated" || pendingAnswerDelivery
          ? "unsafe"
          : !sessionBound && !promptLeftPrepared
            ? "no_effect"
            : stepReplaySafe ? "replay_safe" : "unsafe"
        expect(classifyFence(evidence)).toBe(expected)
      }
  })

  it("classifies a lost session/new with confirmed cleanup as no_effect", () => {
    expect(classifyFence({ cleanup: "confirmed_terminated", sessionBound: false, promptLeftPrepared: false, stepReplaySafe: false, pendingAnswerDelivery: false })).toBe("no_effect")
  })

  it("never heals on unconfirmed or merely attested cleanup", () => {
    for (const cleanup of ["unconfirmed", "operator_attested"] as const) {
      expect(classifyFence({ cleanup, sessionBound: false, promptLeftPrepared: false, stepReplaySafe: true, pendingAnswerDelivery: false })).toBe("unsafe")
    }
  })

  it("treats a pending answer delivery as unsafe even on a replay-safe step", () => {
    expect(classifyFence({ cleanup: "confirmed_terminated", sessionBound: true, promptLeftPrepared: true, stepReplaySafe: true, pendingAnswerDelivery: true })).toBe("unsafe")
  })
})

describe("healingDelayMs", () => {
  it("grows exponentially from 1 minute and caps at 30 minutes without jitter", () => {
    const policy = DEFAULT_HEALING_POLICY
    const delays = [1, 2, 3, 4, 5, 6, 7, 10].map(n => healingDelayMs(policy, n, fixed(0.999999)))
    expect(delays.map(d => Math.round(d / 1000))).toEqual([60, 120, 240, 480, 960, 1800, 1800, 1800])
  })

  it("applies full jitter but keeps a floor of a tenth of the base", () => {
    expect(healingDelayMs(DEFAULT_HEALING_POLICY, 1, fixed(0))).toBe(6_000)
    expect(healingDelayMs(DEFAULT_HEALING_POLICY, 1, fixed(0.5))).toBe(30_000)
  })
})

describe("healing policy", () => {
  it("normalizes invalid values to defaults and keeps max ≥ initial", () => {
    expect(normalizeHealingPolicy({ initialMs: -1, maxMs: Number.NaN, attentionAfter: 0 })).toEqual(DEFAULT_HEALING_POLICY)
    expect(normalizeHealingPolicy({ initialMs: 120_000, maxMs: 60_000 }).maxMs).toBe(120_000)
  })

  it("needs attention from the configured number of consecutive failures", () => {
    expect(needsAttention(DEFAULT_HEALING_POLICY, 2)).toBe(false)
    expect(needsAttention(DEFAULT_HEALING_POLICY, 3)).toBe(true)
  })
})
