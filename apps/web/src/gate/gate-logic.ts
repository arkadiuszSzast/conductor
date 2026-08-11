/**
 * Human-gate decision logic — pure. The UI enforces the same contract the
 * API does (request-changes needs a non-empty note; approve takes none),
 * and maps gate errors per the envelope: 409 = a racing decision, show the
 * server's message and refetch; 400 = inline; 404 = feature gone; 500 =
 * correlate by requestId.
 */

import { ApiError } from "../api/client.ts"

export type GateAction = "approve" | "request-changes"

export interface GateDecision {
  readonly action: GateAction
  readonly notes: string
}

/** Returns an inline error when the decision is invalid, else null. */
export function validateGateDecision(decision: GateDecision): string | null {
  if (decision.action === "approve") return null
  if (decision.notes.trim() === "") return "a note is required when requesting changes"
  return null
}

export function isGateAction(value: string): value is GateAction {
  return value === "approve" || value === "request-changes"
}

export interface GateErrorHandling {
  /** What to surface to the operator. */
  readonly toast: string
  /** Whether the failure means the feature state went stale underneath us. */
  readonly refetch: boolean
  /** Whether the error belongs in the inline form slot instead of a toast. */
  readonly inline: boolean
}

export function mapGateError(err: unknown): GateErrorHandling {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 409:
        return { toast: err.message, refetch: true, inline: false }
      case 400:
        return { toast: "", refetch: false, inline: true }
      case 404:
        return { toast: `feature is gone: ${err.message}`, refetch: true, inline: false }
      case 401:
        return { toast: err.message, refetch: true, inline: false }
      default:
        return {
          toast: err.requestId !== null ? `${err.message} (request ${err.requestId})` : err.message,
          refetch: true,
          inline: false,
        }
    }
  }
  return { toast: String(err), refetch: true, inline: false }
}
