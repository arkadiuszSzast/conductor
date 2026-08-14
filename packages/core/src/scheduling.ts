/**
 * Pure backoff, jitter and budget arithmetic — no clock, no I/O. The engine
 * supplies `now` and a `Random` port; every function here is a plain
 * calculation over numbers so it is exhaustively unit-testable without a
 * database or a timer.
 *
 * All delays and budgets are finite and clamped: `Number.MAX_SAFE_INTEGER`
 * bounds every computation so a runaway `multiplier`/`attempt` can never
 * overflow into `Infinity`/`NaN` and silently produce an unbounded wait.
 */

import type { BackoffDef } from "./types.ts"

/** Injectable random source in [0, 1) — mirrors `Clock` in
 *  `packages/server/src/ports.ts` so tests can supply a deterministic
 *  sequence instead of `Math.random()`. */
export interface Random {
  next(): number
}

export const systemRandom: Random = { next: () => Math.random() }

const MAX_DELAY_MS = Number.MAX_SAFE_INTEGER

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** The un-jittered base delay for `attempt` (1-based: the delay BEFORE
 *  attempt N+1, so attempt=1 is the delay after the first failure). Grows
 *  exponentially until it reaches `max`, then stays capped — never negative,
 *  never exceeding configured bounds, overflow-safe via clamping at every
 *  multiplication step. */
export function baseDelayMs(backoff: BackoffDef, attempt: number): number {
  if (backoff.strategy === "constant") return clamp(backoff.delay, 0, MAX_DELAY_MS)
  const exponent = Math.max(0, attempt - 1)
  // Clamp the multiplier power before multiplying by `initial` — computing
  // `multiplier ** exponent` directly can reach `Infinity` for a handful of
  // attempts at multiplier > 1, and `Infinity * initial` stays `Infinity`
  // instead of the configured cap.
  const growth = clamp(backoff.multiplier ** exponent, 1, MAX_DELAY_MS)
  const delay = clamp(backoff.initial * growth, 0, MAX_DELAY_MS)
  return clamp(delay, 0, backoff.max)
}

/** Applies jitter to a base delay: "none" returns it unchanged, "full"
 *  samples uniformly in [0, base], "equal" samples uniformly in
 *  [base/2, base] (half fixed, half randomized) — the two AWS-documented
 *  jitter shapes. Never negative, never exceeds the base delay. */
export function applyJitter(baseMs: number, jitter: "none" | "full" | "equal" | undefined, random: Random): number {
  const mode = jitter ?? "full"
  if (mode === "none") return baseMs
  const sample = clamp(random.next(), 0, 1)
  if (mode === "full") return baseMs * sample
  return baseMs / 2 + (baseMs / 2) * sample
}

/** The full delay for one retry/observation attempt: base backoff, then
 *  jitter. Deterministic given a `Random` stub. */
export function computeDelayMs(backoff: BackoffDef, attempt: number, random: Random): number {
  const base = baseDelayMs(backoff, attempt)
  const jitter = backoff.strategy === "exponential" ? backoff.jitter : "none"
  return clamp(applyJitter(base, jitter, random), 0, MAX_DELAY_MS)
}

/** Clamps an adapter-supplied `Retry-After` hint into the policy's own
 *  bounds: never below the immediate floor (0), never above the backoff's
 *  configured cap. A hint is a lower bound Conductor CONSIDERS — it never
 *  overrides policy outright. */
export function clampRetryHintMs(hintMs: number, backoff: BackoffDef): number {
  const max = backoff.strategy === "constant" ? backoff.delay : backoff.max
  return clamp(hintMs, 0, max)
}

/** The schedule for one retry: the hint (if present, clamped into policy
 *  bounds) taken as a floor under the computed backoff delay — so a
 *  provider's requested wait is honoured without exceeding configured
 *  bounds and without ever LOWERING backoff below what the hint asks for. */
export function computeScheduledDelayMs(
  backoff: BackoffDef,
  attempt: number,
  random: Random,
  retryHintMs?: number,
): { readonly delayMs: number; readonly source: "backoff" | "retry_hint" } {
  const computed = computeDelayMs(backoff, attempt, random)
  if (retryHintMs === undefined) return { delayMs: computed, source: "backoff" }
  const clampedHint = clampRetryHintMs(retryHintMs, backoff)
  return clampedHint > computed
    ? { delayMs: clampedHint, source: "retry_hint" }
    : { delayMs: computed, source: "backoff" }
}

/** `now + delay`, saturating instead of overflowing past
 *  `Number.MAX_SAFE_INTEGER`. */
export function nextAttemptAt(nowMs: number, delayMs: number): number {
  return clamp(nowMs + delayMs, nowMs, MAX_DELAY_MS)
}

// ---------------------------------------------------------------------------
// Elapsed-budget and pause-time accounting
// ---------------------------------------------------------------------------

export interface ElapsedBudgetState {
  /** When the retry episode's first attempt began. */
  readonly startedAtMs: number
  /** Total ms excluded from elapsed accounting because the feature was
   *  paused during that span (design.md: "budget clocks store accumulated
   *  paused duration"). */
  readonly pausedMs: number
}

/** Elapsed time counted toward `max_elapsed`: wall-clock time since the
 *  episode started, minus accumulated pause time. Never negative. */
export function elapsedBudgetMs(state: ElapsedBudgetState, nowMs: number): number {
  return Math.max(0, nowMs - state.startedAtMs - state.pausedMs)
}

/** Accumulates one pause span (`pausedAtMs` → `resumedAtMs`) into the
 *  running paused-time total. Zero or negative spans (clock skew, or a
 *  resume recorded before its pause) contribute nothing rather than
 *  reducing the total — pause time is monotonic. */
export function accumulatePausedMs(pausedMs: number, pausedAtMs: number, resumedAtMs: number): number {
  return pausedMs + Math.max(0, resumedAtMs - pausedAtMs)
}

export interface BudgetCheckInput {
  readonly attempts: number
  readonly maxAttempts: number
  readonly maxElapsedMs: number
  readonly episodeStartedAtMs: number
  readonly pausedMs: number
  readonly candidateAttemptAtMs: number
}

export type BudgetCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly exhaustedBy: "attempts" | "elapsed" }

/**
 * Whether one more attempt fits the budget. Attempts is checked first (a
 * try-limit exhaustion at the deadline is still an attempts exhaustion, per
 * `retry-budget` spec's "first exhausted bound stops retry"), then whether
 * the candidate attempt's own start time would land past the elapsed
 * deadline — the deadline bounds when an attempt may START, not merely
 * when it was scheduled from.
 */
export function checkRetryBudget(input: BudgetCheckInput): BudgetCheckResult {
  if (input.attempts >= input.maxAttempts) return { ok: false, exhaustedBy: "attempts" }
  const elapsedAtCandidate = Math.max(
    0,
    input.candidateAttemptAtMs - input.episodeStartedAtMs - input.pausedMs,
  )
  if (elapsedAtCandidate > input.maxElapsedMs) return { ok: false, exhaustedBy: "elapsed" }
  return { ok: true }
}
