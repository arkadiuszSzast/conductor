import { describe, expect, it } from "bun:test"
import {
  accumulatePausedMs,
  applyJitter,
  baseDelayMs,
  checkRetryBudget,
  clampRetryHintMs,
  computeDelayMs,
  computeScheduledDelayMs,
  elapsedBudgetMs,
  nextAttemptAt,
} from "./src/scheduling.ts"
import type { Random } from "./src/scheduling.ts"
import type { BackoffDef } from "./src/types.ts"

function fixedRandom(value: number): Random {
  return { next: () => value }
}

// ---------------------------------------------------------------------------
// baseDelayMs
// ---------------------------------------------------------------------------

describe("baseDelayMs", () => {
  it("constant strategy returns the configured delay regardless of attempt", () => {
    const backoff: BackoffDef = { strategy: "constant", delay: 5000 }
    expect(baseDelayMs(backoff, 1)).toBe(5000)
    expect(baseDelayMs(backoff, 10)).toBe(5000)
  })

  it("clamps a negative constant delay to zero", () => {
    expect(baseDelayMs({ strategy: "constant", delay: -100 }, 1)).toBe(0)
  })

  it("exponential strategy grows with attempt number", () => {
    const backoff: BackoffDef = { strategy: "exponential", initial: 100, multiplier: 2, max: 100_000 }
    expect(baseDelayMs(backoff, 1)).toBe(100)
    expect(baseDelayMs(backoff, 2)).toBe(200)
    expect(baseDelayMs(backoff, 3)).toBe(400)
    expect(baseDelayMs(backoff, 4)).toBe(800)
  })

  it("caps exponential growth at max", () => {
    const backoff: BackoffDef = { strategy: "exponential", initial: 1000, multiplier: 2, max: 5000 }
    expect(baseDelayMs(backoff, 10)).toBe(5000)
    expect(baseDelayMs(backoff, 50)).toBe(5000)
  })

  it("stays finite and capped for an extreme attempt count (overflow safety)", () => {
    const backoff: BackoffDef = { strategy: "exponential", initial: 1000, multiplier: 3, max: 60_000 }
    const delay = baseDelayMs(backoff, 100_000)
    expect(Number.isFinite(delay)).toBe(true)
    expect(delay).toBe(60_000)
  })

  it("never returns a negative delay for attempt 0 or below", () => {
    const backoff: BackoffDef = { strategy: "exponential", initial: 100, multiplier: 2, max: 10_000 }
    expect(baseDelayMs(backoff, 0)).toBeGreaterThanOrEqual(0)
    expect(baseDelayMs(backoff, -5)).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// applyJitter
// ---------------------------------------------------------------------------

describe("applyJitter", () => {
  it("none leaves the delay unchanged", () => {
    expect(applyJitter(1000, "none", fixedRandom(0.9))).toBe(1000)
  })

  it("full samples in [0, base]", () => {
    expect(applyJitter(1000, "full", fixedRandom(0))).toBe(0)
    expect(applyJitter(1000, "full", fixedRandom(1))).toBe(1000)
    expect(applyJitter(1000, "full", fixedRandom(0.5))).toBe(500)
  })

  it("equal samples in [base/2, base]", () => {
    expect(applyJitter(1000, "equal", fixedRandom(0))).toBe(500)
    expect(applyJitter(1000, "equal", fixedRandom(1))).toBe(1000)
  })

  it("defaults to full jitter when jitter is undefined", () => {
    expect(applyJitter(1000, undefined, fixedRandom(0))).toBe(0)
  })

  it("never produces a negative delay or one exceeding the base", () => {
    for (const mode of ["none", "full", "equal"] as const) {
      const result = applyJitter(2000, mode, fixedRandom(0.37))
      expect(result).toBeGreaterThanOrEqual(0)
      expect(result).toBeLessThanOrEqual(2000)
    }
  })
})

// ---------------------------------------------------------------------------
// computeDelayMs
// ---------------------------------------------------------------------------

describe("computeDelayMs", () => {
  it("constant backoff ignores jitter entirely (no jitter field on constant)", () => {
    const backoff: BackoffDef = { strategy: "constant", delay: 1000 }
    expect(computeDelayMs(backoff, 1, fixedRandom(0))).toBe(1000)
    expect(computeDelayMs(backoff, 1, fixedRandom(1))).toBe(1000)
  })

  it("exponential backoff applies its configured jitter deterministically given a fixed random source", () => {
    const backoff: BackoffDef = { strategy: "exponential", initial: 1000, multiplier: 2, max: 100_000, jitter: "full" }
    expect(computeDelayMs(backoff, 1, fixedRandom(0))).toBe(0)
    expect(computeDelayMs(backoff, 1, fixedRandom(1))).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// clampRetryHintMs / computeScheduledDelayMs
// ---------------------------------------------------------------------------

describe("clampRetryHintMs", () => {
  it("clamps to [0, backoff.max] for exponential backoff", () => {
    const backoff: BackoffDef = { strategy: "exponential", initial: 100, multiplier: 2, max: 10_000 }
    expect(clampRetryHintMs(-500, backoff)).toBe(0)
    expect(clampRetryHintMs(50_000, backoff)).toBe(10_000)
    expect(clampRetryHintMs(5000, backoff)).toBe(5000)
  })

  it("clamps to [0, backoff.delay] for constant backoff", () => {
    const backoff: BackoffDef = { strategy: "constant", delay: 3000 }
    expect(clampRetryHintMs(10_000, backoff)).toBe(3000)
  })
})

describe("computeScheduledDelayMs", () => {
  const backoff: BackoffDef = { strategy: "exponential", initial: 1000, multiplier: 2, max: 100_000, jitter: "none" }

  it("uses the computed backoff delay when no hint is given", () => {
    const result = computeScheduledDelayMs(backoff, 1, fixedRandom(0))
    expect(result.source).toBe("backoff")
    expect(result.delayMs).toBe(1000)
  })

  it("uses the hint when it exceeds the computed delay, clamped into policy bounds", () => {
    const result = computeScheduledDelayMs(backoff, 1, fixedRandom(0), 5000)
    expect(result.source).toBe("retry_hint")
    expect(result.delayMs).toBe(5000)
  })

  it("never lets a hint lower the delay below the computed backoff", () => {
    const result = computeScheduledDelayMs(backoff, 3, fixedRandom(0), 100)
    expect(result.source).toBe("backoff")
    expect(result.delayMs).toBe(baseDelayMs(backoff, 3))
  })

  it("clamps an out-of-bounds hint before comparing it to the computed delay", () => {
    const result = computeScheduledDelayMs(backoff, 1, fixedRandom(0), 999_999_999)
    expect(result.delayMs).toBe(100_000)
    expect(result.source).toBe("retry_hint")
  })
})

// ---------------------------------------------------------------------------
// nextAttemptAt
// ---------------------------------------------------------------------------

describe("nextAttemptAt", () => {
  it("adds the delay to now", () => {
    expect(nextAttemptAt(1000, 500)).toBe(1500)
  })

  it("saturates instead of overflowing past MAX_SAFE_INTEGER", () => {
    const result = nextAttemptAt(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER)
    expect(Number.isFinite(result)).toBe(true)
    expect(result).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
  })

  it("never returns a time before now", () => {
    expect(nextAttemptAt(1000, 0)).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// elapsed budget / pause accounting
// ---------------------------------------------------------------------------

describe("elapsedBudgetMs", () => {
  it("counts plain wall-clock time with no pauses", () => {
    expect(elapsedBudgetMs({ startedAtMs: 1000, pausedMs: 0 }, 5000)).toBe(4000)
  })

  it("excludes accumulated paused time", () => {
    expect(elapsedBudgetMs({ startedAtMs: 1000, pausedMs: 1500 }, 5000)).toBe(2500)
  })

  it("never goes negative when paused time exceeds elapsed wall-clock time", () => {
    expect(elapsedBudgetMs({ startedAtMs: 1000, pausedMs: 10_000 }, 5000)).toBe(0)
  })
})

describe("accumulatePausedMs", () => {
  it("adds a positive pause span to the running total", () => {
    expect(accumulatePausedMs(1000, 2000, 2500)).toBe(1500)
  })

  it("contributes nothing for a non-positive span (clock skew safety)", () => {
    expect(accumulatePausedMs(1000, 2500, 2000)).toBe(1000)
  })

  it("pause time is monotonic — it never decreases the running total", () => {
    const first = accumulatePausedMs(0, 0, 100)
    const second = accumulatePausedMs(first, 200, 150)
    expect(second).toBeGreaterThanOrEqual(first)
  })
})

// ---------------------------------------------------------------------------
// checkRetryBudget
// ---------------------------------------------------------------------------

describe("checkRetryBudget", () => {
  const base = { episodeStartedAtMs: 0, pausedMs: 0, candidateAttemptAtMs: 1000 }

  it("ok while attempts remain and the candidate is within the elapsed deadline", () => {
    const result = checkRetryBudget({ ...base, attempts: 1, maxAttempts: 3, maxElapsedMs: 10_000 })
    expect(result.ok).toBe(true)
  })

  it("exhausts by attempts when the try limit is reached before the elapsed deadline", () => {
    const result = checkRetryBudget({ ...base, attempts: 3, maxAttempts: 3, maxElapsedMs: 1_000_000 })
    expect(result).toEqual({ ok: false, exhaustedBy: "attempts" })
  })

  it("exhausts by elapsed when the candidate attempt would start past the deadline", () => {
    const result = checkRetryBudget({ ...base, attempts: 1, maxAttempts: 100, maxElapsedMs: 500, candidateAttemptAtMs: 1000 })
    expect(result).toEqual({ ok: false, exhaustedBy: "elapsed" })
  })

  it("attempts exhaustion takes priority when both bounds are hit simultaneously", () => {
    const result = checkRetryBudget({ ...base, attempts: 3, maxAttempts: 3, maxElapsedMs: 500, candidateAttemptAtMs: 1000 })
    expect(result).toEqual({ ok: false, exhaustedBy: "attempts" })
  })

  it("excludes paused time from the elapsed check — a candidate that would exceed the deadline in wall-clock time is still ok once pauses are subtracted", () => {
    const result = checkRetryBudget({
      attempts: 1,
      maxAttempts: 5,
      maxElapsedMs: 500,
      episodeStartedAtMs: 0,
      pausedMs: 800,
      candidateAttemptAtMs: 1000,
    })
    expect(result.ok).toBe(true)
  })
})
