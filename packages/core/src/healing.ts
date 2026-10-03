/**
 * Self-healing of uncertain executions — pure classification and backoff.
 *
 * A fenced run is healed automatically only when durable evidence proves
 * the replay is harmless (`no_effect`) or the step explicitly opts in
 * (`replay_safe`). Both require confirmed process termination: without
 * it a replacement attempt could run beside a live orphan on the same
 * worktree. Everything else stays `unsafe` and escalates to a human.
 */

import { applyJitter, baseDelayMs } from "./scheduling.ts"
import type { Random } from "./scheduling.ts"

export type FenceClassification = "no_effect" | "replay_safe" | "unsafe"

export type FenceCleanupEvidence = "confirmed_terminated" | "operator_attested" | "unconfirmed"

export interface FenceEvidence {
  /** A runner session id was ever bound to the run (locally or remotely). */
  readonly sessionBound: boolean
  /** Some prompt/answer/nudge operation for the run left `prepared`
   *  (i.e. may have reached the agent). */
  readonly promptLeftPrepared: boolean
  readonly cleanup: FenceCleanupEvidence
  readonly stepReplaySafe: boolean
  /** An answer delivery was open when the run was fenced. */
  readonly pendingAnswerDelivery: boolean
}

export function classifyFence(evidence: FenceEvidence): FenceClassification {
  // Operator attestation is a human judgement recorded for manual
  // recovery, never machine proof — only confirmed termination qualifies.
  if (evidence.cleanup !== "confirmed_terminated") return "unsafe"
  if (evidence.pendingAnswerDelivery) return "unsafe"
  if (!evidence.sessionBound && !evidence.promptLeftPrepared) return "no_effect"
  if (evidence.stepReplaySafe) return "replay_safe"
  return "unsafe"
}

export function isHealable(classification: FenceClassification): boolean {
  return classification === "no_effect" || classification === "replay_safe"
}

export interface HealingPolicy {
  readonly initialMs: number
  readonly maxMs: number
  /** Consecutive failed healing attempts before the feature shows `attention`. */
  readonly attentionAfter: number
}

export const DEFAULT_HEALING_POLICY: HealingPolicy = {
  initialMs: 60_000,
  maxMs: 30 * 60_000,
  attentionAfter: 3,
}

export function normalizeHealingPolicy(input: Partial<HealingPolicy> = {}): HealingPolicy {
  const initialMs = finitePositive(input.initialMs, DEFAULT_HEALING_POLICY.initialMs)
  const maxMs = Math.max(initialMs, finitePositive(input.maxMs, DEFAULT_HEALING_POLICY.maxMs))
  const attentionAfter = Math.max(1, Math.floor(finitePositive(input.attentionAfter, DEFAULT_HEALING_POLICY.attentionAfter)))
  return { initialMs, maxMs, attentionAfter }
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Delay before healing attempt number `failures` (1 = first heal after the
 * first fence). Exponential ×2 from `initialMs`, capped at `maxMs`, full
 * jitter — but never below a tenth of the base so a stalled host is not
 * hit again almost immediately by an unlucky jitter draw.
 */
export function healingDelayMs(policy: HealingPolicy, failures: number, random: Random): number {
  const base = baseDelayMs(
    { strategy: "exponential", initial: policy.initialMs, multiplier: 2, max: policy.maxMs, jitter: "full" },
    Math.max(1, failures),
  )
  return Math.max(Math.floor(base / 10), applyJitter(base, "full", random))
}

export function needsAttention(policy: HealingPolicy, consecutiveFailures: number): boolean {
  return consecutiveFailures >= policy.attentionAfter
}
