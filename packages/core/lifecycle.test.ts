import { describe, expect, it } from "bun:test"
import { decideFailureRoute, decidePauseAwareResume, decideRecover, decideResourceWaitRoute } from "./src/lifecycle.ts"
import { normalizeResourceWaitPolicy, normalizeRetryPolicy } from "./src/retry-policy.ts"
import { makeFailureEnvelope } from "./src/failure.ts"
import type { Random } from "./src/scheduling.ts"

function fixedRandom(value: number): Random {
  return { next: () => value }
}

// ---------------------------------------------------------------------------
// decideFailureRoute
// ---------------------------------------------------------------------------

describe("decideFailureRoute", () => {
  it("retries when the budget has room, computing a jittered delay", () => {
    const policy = normalizeRetryPolicy({ perClass: { transient_upstream: { budget: { maxAttempts: 5, maxElapsedMs: 100_000 } } } })
    const envelope = makeFailureEnvelope({ class: "transient_upstream", diagnostic: "503", source: "runner" })
    const decision = decideFailureRoute(
      envelope, policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 1000, fixedRandom(0),
    )
    expect(decision.kind).toBe("retry")
    if (decision.kind === "retry") {
      expect(decision.attempt).toBe(2)
      expect(decision.nextAttemptAtMs).toBeGreaterThanOrEqual(1000)
    }
  })

  it("escalates by attempts once the class's max attempts is reached", () => {
    const policy = normalizeRetryPolicy({ perClass: { deterministic_failure: { budget: { maxAttempts: 1, maxElapsedMs: 100_000 } } } })
    const envelope = makeFailureEnvelope({ class: "deterministic_failure", diagnostic: "exit 1", source: "cmd" })
    const decision = decideFailureRoute(
      envelope, policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 1000, fixedRandom(0),
    )
    expect(decision).toMatchObject({ kind: "escalate", exhaustedBy: "attempts" })
  })

  it("escalates by elapsed when the next attempt would start past the deadline", () => {
    const policy = normalizeRetryPolicy({
      perClass: {
        transient_upstream: {
          budget: { maxAttempts: 100, maxElapsedMs: 500 },
          backoff: { strategy: "constant", delay: 10_000 },
        },
      },
    })
    const envelope = makeFailureEnvelope({ class: "transient_upstream", diagnostic: "503", source: "runner" })
    const decision = decideFailureRoute(
      envelope, policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0),
    )
    expect(decision).toMatchObject({ kind: "escalate", exhaustedBy: "elapsed" })
  })

  it("routes a deterministic failure to immediate escalation by default (does not retry patiently)", () => {
    const policy = normalizeRetryPolicy()
    const envelope = makeFailureEnvelope({ class: "deterministic_failure", diagnostic: "exit 1", source: "cmd" })
    const decision = decideFailureRoute(
      envelope, policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0),
    )
    expect(decision.kind).toBe("escalate")
  })

  it("routes a transient_upstream failure to patient retry by default", () => {
    const policy = normalizeRetryPolicy()
    const envelope = makeFailureEnvelope({ class: "transient_upstream", diagnostic: "503", source: "runner" })
    const decision = decideFailureRoute(
      envelope, policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0),
    )
    expect(decision.kind).toBe("retry")
  })

  it("never inspects the diagnostic text to make its decision — same class, wildly different diagnostic, same route", () => {
    const policy = normalizeRetryPolicy()
    const a = decideFailureRoute(
      makeFailureEnvelope({ class: "transient_upstream", diagnostic: "503 Service Unavailable", source: "runner" }),
      policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0),
    )
    const b = decideFailureRoute(
      makeFailureEnvelope({ class: "transient_upstream", diagnostic: "connection reset by peer, retry after 503ms maybe", source: "runner" }),
      policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0),
    )
    expect(a.kind).toBe(b.kind)
  })

  it("honours a clamped retry hint as the schedule source when it exceeds computed backoff", () => {
    const policy = normalizeRetryPolicy({
      perClass: {
        capacity: {
          budget: { maxAttempts: 5, maxElapsedMs: 1_000_000 },
          backoff: { strategy: "exponential", initial: 100, multiplier: 2, max: 60_000, jitter: "none" },
        },
      },
    })
    const envelope = makeFailureEnvelope({ class: "capacity", diagnostic: "rate limited", source: "runner", retryHintMs: 30_000 })
    const decision = decideFailureRoute(
      envelope, policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0),
    )
    expect(decision.kind).toBe("retry")
    if (decision.kind === "retry") {
      expect(decision.scheduleSource).toBe("retry_hint")
      expect(decision.delayMs).toBe(30_000)
    }
  })

  it("unknown/internal failures use a small finite budget — never infinite, never silently success", () => {
    const policy = normalizeRetryPolicy()
    const envelope = makeFailureEnvelope({ class: "not-a-real-class", diagnostic: "adapter bug", source: "adapter" })
    expect(envelope.class).toBe("internal")
    const first = decideFailureRoute(envelope, policy, { attempts: 1, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0))
    expect(first.kind).toBe("retry")
    const exhausted = decideFailureRoute(envelope, policy, { attempts: 2, startedAtMs: 0, pausedMs: 0 }, 0, fixedRandom(0))
    expect(exhausted.kind).toBe("escalate")
  })
})

// ---------------------------------------------------------------------------
// decideResourceWaitRoute
// ---------------------------------------------------------------------------

describe("decideResourceWaitRoute", () => {
  it("schedules the next observation while the deadline has not passed", () => {
    const policy = normalizeResourceWaitPolicy({ maxWaitMs: 60_000 })
    const decision = decideResourceWaitRoute(
      "runner_unavailable", policy, { firstObservedAtMs: 0, observationCount: 0 }, 1000, fixedRandom(0),
    )
    expect(decision.kind).toBe("wait_resource")
    if (decision.kind === "wait_resource") {
      expect(decision.nextObservationAtMs).toBeGreaterThanOrEqual(1000)
    }
  })

  it("escalates once the finite wait deadline is reached", () => {
    const policy = normalizeResourceWaitPolicy({ maxWaitMs: 1000 })
    const decision = decideResourceWaitRoute(
      "runner_unavailable", policy, { firstObservedAtMs: 0, observationCount: 5 }, 1000, fixedRandom(0),
    )
    expect(decision.kind).toBe("escalate")
  })

  it("observing an unavailable resource never appears in the returned decision as an attempt — the caller's step attempt count is untouched by construction (no attempts field returned)", () => {
    const policy = normalizeResourceWaitPolicy({ maxWaitMs: 60_000 })
    const decision = decideResourceWaitRoute(
      "runner_unavailable", policy, { firstObservedAtMs: 0, observationCount: 3 }, 1000, fixedRandom(0),
    )
    expect(decision).not.toHaveProperty("attempts")
  })

  it("distinguishes every documented resource reason in its escalation message", () => {
    const policy = normalizeResourceWaitPolicy({ maxWaitMs: 0 })
    for (const reason of ["runner_unavailable", "binding_unavailable", "dependency_unavailable"] as const) {
      const decision = decideResourceWaitRoute(reason, policy, { firstObservedAtMs: 0, observationCount: 1 }, 1, fixedRandom(0))
      expect(decision.kind).toBe("escalate")
      if (decision.kind === "escalate") expect(decision.reason).toContain(reason)
    }
  })
})

// ---------------------------------------------------------------------------
// decideRecover
// ---------------------------------------------------------------------------

describe("decideRecover", () => {
  const target = { status: "escalated" as const, currentVersion: 3 }

  it("starts a fresh episode with zero attempts when the target matches and a note is given", () => {
    const decision = decideRecover(
      target, { expectedStatus: "escalated", expectedVersion: 3, note: "provider restored" }, 5000,
    )
    expect(decision).toEqual({ kind: "recovered", episode: { attempts: 0, startedAtMs: 5000, pausedMs: 0 } })
  })

  it("rejects an empty note", () => {
    const decision = decideRecover(target, { expectedStatus: "escalated", expectedVersion: 3, note: "  " }, 5000)
    expect(decision.kind).toBe("rejected")
  })

  it("rejects a mismatched expected status", () => {
    const decision = decideRecover(target, { expectedStatus: "blocked", expectedVersion: 3, note: "x" }, 5000)
    expect(decision.kind).toBe("rejected")
  })

  it("rejects a stale version", () => {
    const decision = decideRecover(target, { expectedStatus: "escalated", expectedVersion: 2, note: "x" }, 5000)
    expect(decision.kind).toBe("rejected")
  })

  it("never falls through to a workflow-start-shaped decision — recovered always carries a fresh episode, never a replay marker", () => {
    const decision = decideRecover(
      target, { expectedStatus: "escalated", expectedVersion: 3, note: "ok" }, 100,
    )
    expect(decision.kind).toBe("recovered")
    if (decision.kind === "recovered") {
      expect(decision.episode.attempts).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// decidePauseAwareResume
// ---------------------------------------------------------------------------

describe("decidePauseAwareResume", () => {
  it("claims immediately when the due time already passed during the pause", () => {
    const decision = decidePauseAwareResume({ kind: "retry", dueAtMs: 1000 }, 5000)
    expect(decision).toEqual({ kind: "claim_now" })
  })

  it("claims immediately when the due time is exactly now", () => {
    const decision = decidePauseAwareResume({ kind: "resource_wait", dueAtMs: 5000 }, 5000)
    expect(decision).toEqual({ kind: "claim_now" })
  })

  it("keeps waiting with the original due time unchanged when not yet due", () => {
    const decision = decidePauseAwareResume({ kind: "retry", dueAtMs: 10_000 }, 5000)
    expect(decision).toEqual({ kind: "still_waiting", dueAtMs: 10_000 })
  })

  it("resuming never shifts a not-yet-due schedule earlier or later", () => {
    const schedule = { kind: "resource_wait" as const, dueAtMs: 20_000 }
    const decision = decidePauseAwareResume(schedule, 5000)
    expect(decision).toEqual({ kind: "still_waiting", dueAtMs: schedule.dueAtMs })
  })
})
