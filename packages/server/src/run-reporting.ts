/**
 * `run-reporting.ts` — shared report/ask request validation and
 * projection logic (design.md D8, task 4.2). Both the ordinary
 * bearer-authenticated `/v1/runs/:id/report` route (api.ts, existing)
 * and the restricted `/v1/worker/report` route (task 4.1/4.2, scoped by
 * run credential) funnel through the SAME validation here before
 * calling the SAME `engine.report`/`engine.answer` methods — there is no
 * separate, weaker validation path for a worker credential, and no
 * parallel outcome ledger (run-scoped-reporting spec: "The bridge SHALL
 * not persist a parallel outcome ledger").
 */

export type ParsedReportBody =
  | { readonly ok: true; readonly outcome?: "succeeded" | "failed"; readonly verdict?: string; readonly notes?: string; readonly ask?: string; readonly review?: unknown }
  | { readonly ok: false; readonly message: string }

/**
 * Validates a report request body — the EXACT rules `reportRun` (api.ts)
 * already enforces, extracted so a second caller (the restricted worker
 * route) can apply them identically instead of re-implementing (and
 * inevitably drifting from) them.
 */
export function parseReportBody(body: Readonly<Record<string, unknown>>): ParsedReportBody {
  const { outcome, verdict, notes, ask, review } = body
  if (outcome !== undefined && outcome !== "succeeded" && outcome !== "failed") {
    return { ok: false, message: '"outcome" must be "succeeded" or "failed"' }
  }
  if (verdict !== undefined && (typeof verdict !== "string" || verdict.trim() === "")) {
    return { ok: false, message: '"verdict" must be a non-empty string' }
  }
  if (notes !== undefined && typeof notes !== "string") {
    return { ok: false, message: '"notes" must be a string' }
  }
  if (ask !== undefined && (typeof ask !== "string" || ask.trim() === "")) {
    return { ok: false, message: '"ask" must be a non-empty string' }
  }
  const shapes = [outcome !== undefined, verdict !== undefined, ask !== undefined].filter(Boolean).length
  if (shapes === 0) {
    return { ok: false, message: 'one of "outcome", "verdict" or "ask" is required' }
  }
  if (ask !== undefined && shapes > 1) {
    return { ok: false, message: '"ask" cannot be combined with "outcome" or "verdict"' }
  }
  if (outcome === "failed" && verdict !== undefined) {
    return { ok: false, message: '"outcome": "failed" and "verdict" are contradictory — a verdict implies successful completion' }
  }
  return {
    ok: true,
    ...(outcome !== undefined ? { outcome: outcome as "succeeded" | "failed" } : {}),
    ...(verdict !== undefined ? { verdict: verdict as string } : {}),
    ...(notes !== undefined ? { notes: notes as string } : {}),
    ...(ask !== undefined ? { ask: ask as string } : {}),
    ...(review !== undefined ? { review } : {}),
  }
}

/** The stable text prefix `Engine.report` uses for an already-concluded
 *  run — matched EXACTLY here so both callers recognize the duplicate
 *  disposition identically (D8: "terminal duplicate-report disposition"). */
export function isAlreadyConcludedMessage(message: string, runId: string): boolean {
  return message.startsWith(`Run ${runId} already concluded`)
}

/** A minimal own-run status projection (D8: "own-status returns a
 *  minimal own-run projection") — never another attempt's data, never
 *  admin fields (transport/profile/config digests, credentials). */
export interface OwnRunStatusProjection {
  readonly runId: string
  readonly status: string
  readonly pendingQuestion: string | null
  readonly outputsReported: boolean
}

export function ownRunStatusProjection(run: {
  readonly id: string
  readonly status: string
  readonly pendingQuestion: string | null
  readonly outputs: Readonly<Record<string, string>>
}): OwnRunStatusProjection {
  return {
    runId: run.id,
    status: run.status,
    pendingQuestion: run.pendingQuestion,
    outputsReported: Object.keys(run.outputs).length > 0,
  }
}

// ------------------------------------------------------- ask invocation dedup

export type AskDedupOutcome =
  | { readonly kind: "fresh" }
  /** The SAME invocation id was already recorded for the CURRENT question
   *  generation — a bounded HTTP retry of the exact same ask, safe to
   *  treat as a no-op success without creating a new question. */
  | { readonly kind: "duplicate_current_generation" }
  /** The invocation id belongs to an OLDER question generation that has
   *  since been superseded by a newer ask — a late replay that must
   *  never overwrite the newer accepted question. */
  | { readonly kind: "stale_generation" }

export interface AskDedupStore {
  findAskInvocation(runId: string, invocationId: string): { readonly questionGeneration: number } | null
  recordAskInvocation(runId: string, invocationId: string, questionGeneration: number): void
}

/**
 * Pure dedup decision given the store's lookup result and the run's
 * CURRENT question generation (its `askedAt` at the moment this ask is
 * being processed) — D8: "Different late replay must not replace a
 * newer accepted question; use current generation checks".
 */
export function decideAskDedup(
  existing: { readonly questionGeneration: number } | null,
  currentGeneration: number,
): AskDedupOutcome {
  if (!existing) return { kind: "fresh" }
  if (existing.questionGeneration === currentGeneration) return { kind: "duplicate_current_generation" }
  return { kind: "stale_generation" }
}
