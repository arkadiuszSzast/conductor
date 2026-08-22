/**
 * All concurrent human-attention surfaces for a feature — pure.
 *
 * A feature's `status: "waiting_human"` can mean more than one thing at
 * once: several parallel jobs can each have a step at `waiting_human`
 * (every one of them gets resolved together by a single approve/
 * request-changes call — `engine.ts`'s `resolveGates` iterates every
 * `waiting_human` step), and independently, any number of interactive
 * agent runs in `activeRuns` can be sitting on a `pendingQuestion` that
 * only an answer to THAT run's id will resolve. `selectGateSurface`
 * picked exactly one of these; this module enumerates all of them so the
 * UI can show what a feature-wide decision actually resolves and let an
 * operator navigate between concurrent asking runs.
 */

import type { FeatureDetail, RunAnswerDelivery, RunSummary } from "../api/types.ts"

export interface GateStepSurface {
  readonly jobId: string
  readonly stepId: string
  /** The rendered gate prompt, when the step wrote one. */
  readonly prompt: string | null
}

export interface AskingRunSurface {
  readonly runId: string
  readonly jobId: string
  readonly stepId: string
  readonly prompt: string
  /** Set while a human answer was already accepted for this run and is
   *  still pending/claimed for delivery — harden-interactive-answer-
   *  delivery task 3.1. The answering surface uses this to disable
   *  resubmission without the feature falsely reporting `running`. */
  readonly answerDelivery?: RunAnswerDelivery
}

export interface GateSurfaces {
  /** Every `waiting_human` job/step, in a stable (jobId, then stepId)
   *  order — what a single approve/request-changes call resolves. */
  readonly gates: readonly GateStepSurface[]
  /** Every active run currently sitting on a pending question. */
  readonly askingRuns: readonly AskingRunSurface[]
}

const EMPTY_SURFACES: GateSurfaces = { gates: [], askingRuns: [] }

/** Enumerate every persisted gate and asking run directly. The aggregate
 *  feature status is intentionally not a guard: a stale REST snapshot or
 *  interrupted older writer must not hide durable human-attention state. */
export function deriveGateSurfaces(
  detail: FeatureDetail | null | undefined,
  activeRuns: readonly RunSummary[],
): GateSurfaces {
  if (detail === undefined || detail === null) return EMPTY_SURFACES

  const gates: GateStepSurface[] = []
  for (const jobId of Object.keys(detail.jobs).sort()) {
    const jobRuntime = detail.jobs[jobId]!
    for (const stepId of Object.keys(jobRuntime.steps).sort()) {
      const stepRuntime = jobRuntime.steps[stepId]!
      if (stepRuntime.status === "waiting_human") {
        gates.push({ jobId, stepId, prompt: stepRuntime.prompt ?? null })
      }
    }
  }

  const askingRuns: AskingRunSurface[] = activeRuns
    .filter((run): run is RunSummary & { pendingQuestion: string } => run.pendingQuestion != null)
    .map(run => ({
      runId: run.id,
      jobId: run.jobId,
      stepId: run.stepId,
      prompt: run.pendingQuestion,
      ...(run.answerDelivery !== undefined ? { answerDelivery: run.answerDelivery } : {}),
    }))
    .sort((a, b) => (a.jobId === b.jobId ? a.stepId.localeCompare(b.stepId) : a.jobId.localeCompare(b.jobId)))

  return { gates, askingRuns }
}

/** Total attention surfaces a feature currently exposes — drives the
 *  "N gates" disclosure copy and whether a navigator UI is worth showing. */
export function surfaceCount(surfaces: GateSurfaces): number {
  return surfaces.gates.length + surfaces.askingRuns.length
}

export type GateSurfaceItem =
  | ({ readonly kind: "gate" } & GateStepSurface)
  | ({ readonly kind: "ask" } & AskingRunSurface)

/** Stable identity for a surface item, independent of its position in the
 *  list — used to keep a UI selection pinned across re-derivations. */
export function surfaceItemKey(item: GateSurfaceItem): string {
  return item.kind === "gate" ? `gate:${item.jobId}:${item.stepId}` : `ask:${item.runId}`
}

/** Flatten into one navigable list, gates before asking runs — this
 *  ordering keeps the single-gate case identical to before (a lone gate
 *  is item 0 with nothing else to page through), and only surfaces the
 *  ceremony of a navigator once there is more than one item. */
export function allSurfaceItems(surfaces: GateSurfaces): readonly GateSurfaceItem[] {
  return [
    ...surfaces.gates.map(g => ({ kind: "gate" as const, ...g })),
    ...surfaces.askingRuns.map(r => ({ kind: "ask" as const, ...r })),
  ]
}

/** Keep `currentKey` selected as long as it still names a surface in
 *  `items`; otherwise fall back to the first item (or null when the list
 *  is empty). Mirrors `pickStableDefaultScopeKey`'s "freeze unless gone"
 *  rule so answering one of several concurrent surfaces does not yank
 *  focus away from an operator still reviewing another. */
export function pickSurfaceItem(
  items: readonly GateSurfaceItem[],
  currentKey: string | null,
): GateSurfaceItem | null {
  if (currentKey !== null) {
    const found = items.find(item => surfaceItemKey(item) === currentKey)
    if (found !== undefined) return found
  }
  return items[0] ?? null
}
