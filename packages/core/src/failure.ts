/**
 * The stable, machine-readable failure vocabulary shared by commands,
 * actions, runners, the engine and persistence — the taxonomy `retry-policy`
 * classifies every executable failure into, independent of adapter message
 * text. Policy (`retry-policy.ts`, `lifecycle.ts`) reads only `class`; the
 * diagnostic is for humans and is never inspected by routing.
 */

export type FailureClass =
  | "transient_upstream"
  | "transient_transport"
  | "capacity"
  | "timeout"
  | "deterministic_failure"
  | "invalid_config"
  | "missing_session"
  | "cancelled"
  | "internal"

export const FAILURE_CLASSES: readonly FailureClass[] = [
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

/** Why an execution could not even start — distinct from an attempt
 *  failure because no executable attempt began and no retry budget is
 *  spent observing it. */
export type ResourceReason = "runner_unavailable" | "binding_unavailable" | "dependency_unavailable"

export const RESOURCE_REASONS: readonly ResourceReason[] = [
  "runner_unavailable",
  "binding_unavailable",
  "dependency_unavailable",
]

/** Matches the tail bound `engine.ts` already applies to command failure
 *  output — one shared bound for "human diagnostic, not a log dump". */
const MAX_DIAGNOSTIC_LENGTH = 4000

export interface FailureEnvelope {
  readonly class: FailureClass
  readonly diagnostic: string
  readonly source: string
  /** Bounded upper hint from the adapter (e.g. a provider `Retry-After`).
   *  Policy clamps it — never trusted as-is. */
  readonly retryHintMs?: number
}

export function boundDiagnostic(text: string): string {
  return text.length > MAX_DIAGNOSTIC_LENGTH ? text.slice(0, MAX_DIAGNOSTIC_LENGTH) : text
}

/** An adapter that omits or invents a class defaults to `internal` — never
 *  silently success, never infinitely retried. */
export function normalizeFailureClass(value: unknown): FailureClass {
  return typeof value === "string" && (FAILURE_CLASSES as readonly string[]).includes(value)
    ? (value as FailureClass)
    : "internal"
}

export interface MakeFailureEnvelopeInput {
  readonly class?: unknown
  readonly diagnostic: string
  readonly source: string
  readonly retryHintMs?: number
}

export function makeFailureEnvelope(input: MakeFailureEnvelopeInput): FailureEnvelope {
  return {
    class: normalizeFailureClass(input.class),
    diagnostic: boundDiagnostic(input.diagnostic),
    source: input.source,
    ...(input.retryHintMs !== undefined ? { retryHintMs: Math.max(0, input.retryHintMs) } : {}),
  }
}
