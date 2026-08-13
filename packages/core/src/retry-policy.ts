/**
 * Finite, normalized retry and resource-wait policies. Raw configuration
 * (what an operator or workflow author might supply) is optional and
 * partial; normalization fills every field with a conservative finite
 * default, and per-class overrides let deterministic failures fail fast
 * while transient weather retries patiently — all without ever reading a
 * diagnostic string (see `failure.ts`).
 *
 * `BackoffDef` (constant/exponential/jitter) is deliberately reused from
 * `types.ts` — the same sealed shape workflow authors already write in
 * `steps[*].retry.backoff` extends unchanged to per-class overrides here.
 */

import type { FailureClass } from "./failure.ts"
import type { BackoffDef } from "./types.ts"

export interface RetryBudget {
  /** Total attempts including the first. Must be ≥ 1. */
  readonly maxAttempts: number
  /** Wall-clock cap from episode start, in ms. Must be > 0. */
  readonly maxElapsedMs: number
}

export interface RetryClassBehaviour {
  readonly budget: RetryBudget
  readonly backoff: BackoffDef
}

export interface RetryPolicyOverride {
  readonly budget?: Partial<RetryBudget>
  readonly backoff?: BackoffDef
}

export interface RetryPolicyConfig {
  readonly budget?: Partial<RetryBudget>
  readonly backoff?: BackoffDef
  readonly perClass?: Readonly<Partial<Record<FailureClass, RetryPolicyOverride>>>
}

export interface NormalizedRetryPolicy {
  readonly default: RetryClassBehaviour
  readonly perClass: Readonly<Partial<Record<FailureClass, RetryClassBehaviour>>>
}

export interface ResourceWaitPolicyConfig {
  readonly maxWaitMs?: number
  readonly observation?: BackoffDef
}

export interface NormalizedResourceWaitPolicy {
  /** Finite deadline from first observation, in ms. */
  readonly maxWaitMs: number
  readonly observation: BackoffDef
}

// ---------------------------------------------------------------------------
// Conservative finite defaults
// ---------------------------------------------------------------------------

const PATIENT_BUDGET: RetryBudget = { maxAttempts: 5, maxElapsedMs: 10 * 60_000 }
const PATIENT_BACKOFF: BackoffDef = { strategy: "exponential", initial: 1_000, multiplier: 2, max: 60_000, jitter: "full" }

const IMMEDIATE_BUDGET: RetryBudget = { maxAttempts: 1, maxElapsedMs: 60_000 }
const IMMEDIATE_BACKOFF: BackoffDef = { strategy: "constant", delay: 0 }

const INTERNAL_BUDGET: RetryBudget = { maxAttempts: 2, maxElapsedMs: 2 * 60_000 }
const INTERNAL_BACKOFF: BackoffDef = { strategy: "constant", delay: 5_000 }

export const DEFAULT_RETRY_BUDGET: RetryBudget = PATIENT_BUDGET
export const DEFAULT_RETRY_BACKOFF: BackoffDef = PATIENT_BACKOFF

/** Conservative finite defaults by class: patient exponential backoff for
 *  transient weather, immediate (single-attempt) for deterministic/invalid/
 *  cancelled/missing-session failures, and a small finite budget for
 *  unclassified `internal` defects. Never infinite, never silently success. */
const DEFAULT_CLASS_BEHAVIOUR: Readonly<Record<FailureClass, RetryClassBehaviour>> = {
  transient_upstream: { budget: PATIENT_BUDGET, backoff: PATIENT_BACKOFF },
  transient_transport: { budget: PATIENT_BUDGET, backoff: PATIENT_BACKOFF },
  capacity: { budget: PATIENT_BUDGET, backoff: PATIENT_BACKOFF },
  timeout: { budget: PATIENT_BUDGET, backoff: PATIENT_BACKOFF },
  deterministic_failure: { budget: IMMEDIATE_BUDGET, backoff: IMMEDIATE_BACKOFF },
  invalid_config: { budget: IMMEDIATE_BUDGET, backoff: IMMEDIATE_BACKOFF },
  missing_session: { budget: IMMEDIATE_BUDGET, backoff: IMMEDIATE_BACKOFF },
  cancelled: { budget: IMMEDIATE_BUDGET, backoff: IMMEDIATE_BACKOFF },
  internal: { budget: INTERNAL_BUDGET, backoff: INTERNAL_BACKOFF },
}

export const DEFAULT_RESOURCE_WAIT_MAX_MS = 30 * 60_000
export const DEFAULT_RESOURCE_WAIT_OBSERVATION: BackoffDef = {
  strategy: "exponential",
  initial: 5_000,
  multiplier: 2,
  max: 60_000,
  jitter: "full",
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeBudget(base: RetryBudget, override?: Partial<RetryBudget>): RetryBudget {
  return {
    maxAttempts: override?.maxAttempts ?? base.maxAttempts,
    maxElapsedMs: override?.maxElapsedMs ?? base.maxElapsedMs,
  }
}

export function normalizeRetryPolicy(config: RetryPolicyConfig = {}): NormalizedRetryPolicy {
  const defaultBudget = normalizeBudget(DEFAULT_RETRY_BUDGET, config.budget)
  const defaultBackoff = config.backoff ?? DEFAULT_RETRY_BACKOFF
  const defaultBehaviour: RetryClassBehaviour = { budget: defaultBudget, backoff: defaultBackoff }

  const perClass: Record<string, RetryClassBehaviour> = {}
  for (const [failureClass, classDefault] of Object.entries(DEFAULT_CLASS_BEHAVIOUR)) {
    const override = config.perClass?.[failureClass as FailureClass]
    // No explicit config at all for the step: fall back to the class's own
    // conservative default, not the step's generic default — deterministic
    // failures must not inherit a patient generic retry budget by accident.
    if (config.budget === undefined && config.backoff === undefined && override === undefined) {
      perClass[failureClass] = classDefault
      continue
    }
    perClass[failureClass] = {
      budget: normalizeBudget(defaultBudget, override?.budget),
      backoff: override?.backoff ?? defaultBackoff,
    }
  }

  return { default: defaultBehaviour, perClass }
}

export function normalizeResourceWaitPolicy(config: ResourceWaitPolicyConfig = {}): NormalizedResourceWaitPolicy {
  return {
    maxWaitMs: config.maxWaitMs ?? DEFAULT_RESOURCE_WAIT_MAX_MS,
    observation: config.observation ?? DEFAULT_RESOURCE_WAIT_OBSERVATION,
  }
}

/** The behaviour policy applies for one classified failure — per-class
 *  override if configured, else the step's own default. */
export function behaviourForClass(policy: NormalizedRetryPolicy, failureClass: FailureClass): RetryClassBehaviour {
  return policy.perClass[failureClass] ?? policy.default
}

// ---------------------------------------------------------------------------
// Validation — rejected before workflow start, never silently coerced
// ---------------------------------------------------------------------------

export function validateRetryBudget(budget: Partial<RetryBudget>, where: string, errors: string[]): void {
  if (budget.maxAttempts !== undefined && budget.maxAttempts < 1) {
    errors.push(`${where}: maxAttempts must be ≥ 1`)
  }
  if (budget.maxElapsedMs !== undefined && budget.maxElapsedMs <= 0) {
    errors.push(`${where}: maxElapsedMs must be > 0`)
  }
}

export function validateBackoffDef(backoff: BackoffDef, where: string, errors: string[]): void {
  if (backoff.strategy === "constant") {
    if (backoff.delay < 0) errors.push(`${where}: delay must be ≥ 0`)
    return
  }
  if (backoff.initial < 0) errors.push(`${where}: initial must be ≥ 0`)
  if (backoff.multiplier < 1) errors.push(`${where}: multiplier must be ≥ 1`)
  if (backoff.max < 0) errors.push(`${where}: max must be ≥ 0`)
  if (backoff.initial > backoff.max) errors.push(`${where}: initial must not exceed max`)
}

export function validateRetryPolicyConfig(config: RetryPolicyConfig, where = "retry policy"): readonly string[] {
  const errors: string[] = []
  if (config.budget) validateRetryBudget(config.budget, `${where}: budget`, errors)
  if (config.backoff) validateBackoffDef(config.backoff, `${where}: backoff`, errors)
  for (const [failureClass, override] of Object.entries(config.perClass ?? {})) {
    if (!override) continue
    if (override.budget) validateRetryBudget(override.budget, `${where}: perClass["${failureClass}"].budget`, errors)
    if (override.backoff) validateBackoffDef(override.backoff, `${where}: perClass["${failureClass}"].backoff`, errors)
  }
  return errors
}

export function validateResourceWaitPolicyConfig(config: ResourceWaitPolicyConfig, where = "resource-wait policy"): readonly string[] {
  const errors: string[] = []
  if (config.maxWaitMs !== undefined && config.maxWaitMs <= 0) {
    errors.push(`${where}: maxWaitMs must be > 0`)
  }
  if (config.observation) validateBackoffDef(config.observation, `${where}: observation`, errors)
  return errors
}
