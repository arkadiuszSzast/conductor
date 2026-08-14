import { describe, expect, it } from "bun:test"
import {
  DEFAULT_RESOURCE_WAIT_MAX_MS,
  behaviourForClass,
  normalizeResourceWaitPolicy,
  normalizeRetryPolicy,
  validateBackoffDef,
  validateResourceWaitPolicyConfig,
  validateRetryBudget,
  validateRetryPolicyConfig,
} from "./src/retry-policy.ts"
import { FAILURE_CLASSES } from "./src/failure.ts"

describe("normalizeRetryPolicy", () => {
  it("fills a finite default for every class when no config is given at all", () => {
    const policy = normalizeRetryPolicy()
    for (const failureClass of FAILURE_CLASSES) {
      const behaviour = behaviourForClass(policy, failureClass)
      expect(behaviour.budget.maxAttempts).toBeGreaterThanOrEqual(1)
      expect(behaviour.budget.maxElapsedMs).toBeGreaterThan(0)
      expect(Number.isFinite(behaviour.budget.maxAttempts)).toBe(true)
      expect(Number.isFinite(behaviour.budget.maxElapsedMs)).toBe(true)
    }
  })

  it("routes deterministic failures to an immediate (single-attempt) default, unlike patient transient classes", () => {
    const policy = normalizeRetryPolicy()
    const deterministic = behaviourForClass(policy, "deterministic_failure")
    const transient = behaviourForClass(policy, "transient_upstream")
    expect(deterministic.budget.maxAttempts).toBe(1)
    expect(transient.budget.maxAttempts).toBeGreaterThan(1)
  })

  it("gives cancelled, invalid_config and missing_session the same immediate default as deterministic_failure", () => {
    const policy = normalizeRetryPolicy()
    for (const failureClass of ["cancelled", "invalid_config", "missing_session"] as const) {
      expect(behaviourForClass(policy, failureClass).budget.maxAttempts).toBe(1)
    }
  })

  it("gives internal a small finite budget distinct from both immediate and patient", () => {
    const policy = normalizeRetryPolicy()
    const internal = behaviourForClass(policy, "internal")
    expect(internal.budget.maxAttempts).toBeGreaterThan(1)
    expect(internal.budget.maxAttempts).toBeLessThan(behaviourForClass(policy, "transient_upstream").budget.maxAttempts)
  })

  it("a step-level override applies to every class uniformly", () => {
    const policy = normalizeRetryPolicy({ budget: { maxAttempts: 7 } })
    for (const failureClass of FAILURE_CLASSES) {
      expect(behaviourForClass(policy, failureClass).budget.maxAttempts).toBe(7)
    }
  })

  it("a per-class override applies only to that class", () => {
    const policy = normalizeRetryPolicy({
      perClass: { deterministic_failure: { budget: { maxAttempts: 3 } } },
    })
    expect(behaviourForClass(policy, "deterministic_failure").budget.maxAttempts).toBe(3)
    expect(behaviourForClass(policy, "transient_upstream").budget.maxAttempts).not.toBe(3)
  })

  it("a per-class override merges over that class's default budget field-by-field", () => {
    const policy = normalizeRetryPolicy({
      perClass: { transient_upstream: { budget: { maxAttempts: 2 } } },
    })
    const behaviour = behaviourForClass(policy, "transient_upstream")
    expect(behaviour.budget.maxAttempts).toBe(2)
    // maxElapsedMs was not overridden — falls back to the step-level default, which itself defaults finitely.
    expect(behaviour.budget.maxElapsedMs).toBeGreaterThan(0)
  })

  it("unconfigured step falls back to the class's own default policy, not the generic default", () => {
    const policy = normalizeRetryPolicy()
    // deterministic_failure's default must remain "fail fast" even though
    // the generic DEFAULT_RETRY_BUDGET/BACKOFF are patient.
    expect(behaviourForClass(policy, "deterministic_failure").budget.maxAttempts).toBe(1)
  })
})

describe("normalizeResourceWaitPolicy", () => {
  it("fills a finite default deadline and observation backoff", () => {
    const policy = normalizeResourceWaitPolicy()
    expect(policy.maxWaitMs).toBe(DEFAULT_RESOURCE_WAIT_MAX_MS)
    expect(Number.isFinite(policy.maxWaitMs)).toBe(true)
  })

  it("honours an explicit maxWaitMs override", () => {
    expect(normalizeResourceWaitPolicy({ maxWaitMs: 60_000 }).maxWaitMs).toBe(60_000)
  })
})

describe("validateRetryBudget", () => {
  it("rejects maxAttempts below 1", () => {
    const errors: string[] = []
    validateRetryBudget({ maxAttempts: 0 }, "where", errors)
    expect(errors.length).toBe(1)
  })

  it("rejects a non-positive maxElapsedMs", () => {
    const errors: string[] = []
    validateRetryBudget({ maxElapsedMs: 0 }, "where", errors)
    expect(errors.length).toBe(1)
  })

  it("accepts a valid finite budget", () => {
    const errors: string[] = []
    validateRetryBudget({ maxAttempts: 3, maxElapsedMs: 1000 }, "where", errors)
    expect(errors).toEqual([])
  })
})

describe("validateBackoffDef", () => {
  it("rejects a negative constant delay", () => {
    const errors: string[] = []
    validateBackoffDef({ strategy: "constant", delay: -1 }, "where", errors)
    expect(errors.length).toBe(1)
  })

  it("rejects an exponential multiplier below 1", () => {
    const errors: string[] = []
    validateBackoffDef({ strategy: "exponential", initial: 0, multiplier: 0.5, max: 100 }, "where", errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  it("rejects initial exceeding max", () => {
    const errors: string[] = []
    validateBackoffDef({ strategy: "exponential", initial: 200, multiplier: 2, max: 100 }, "where", errors)
    expect(errors.some(e => e.includes("initial must not exceed max"))).toBe(true)
  })

  it("accepts a well-formed exponential backoff", () => {
    const errors: string[] = []
    validateBackoffDef({ strategy: "exponential", initial: 100, multiplier: 2, max: 1000, jitter: "full" }, "where", errors)
    expect(errors).toEqual([])
  })
})

describe("validateRetryPolicyConfig / validateResourceWaitPolicyConfig", () => {
  it("collects nested per-class errors with a locating path", () => {
    const errors = validateRetryPolicyConfig({
      perClass: { deterministic_failure: { budget: { maxAttempts: 0 } } },
    })
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("deterministic_failure")
  })

  it("accepts an empty config", () => {
    expect(validateRetryPolicyConfig({})).toEqual([])
  })

  it("rejects a non-positive resource-wait maxWaitMs", () => {
    expect(validateResourceWaitPolicyConfig({ maxWaitMs: -1 }).length).toBe(1)
  })
})
