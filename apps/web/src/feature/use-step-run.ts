/**
 * Step/run resolution + log-tail hooks shared by the workspace inspector.
 * Split out of the inspector component so job/step selection state and
 * tab UI can live one level up while this stays the single place that
 * resolves "which run backs this job/step" and "what log lines has it
 * produced so far" (preserves the sole-step auto-selection contract from
 * `resolveInspectorStepId` and full initial-page log pagination).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useApp } from "../app-context.ts"
import { useFeatureDetail, useRunLogInvalidations, useRuns } from "../api/hooks.ts"
import type { RunSummary, StepRuntimeProjection, WorkflowProjection } from "../api/types.ts"
import { type LogCursor, EMPTY_LOG_CURSOR, loadAllLogPages, resolveInspectorStepId } from "./inspector-logic.ts"
import { LatestGuard } from "../lib/latest-guard.ts"

export interface StepRunResult {
  readonly effectiveStepId: string | null
  readonly step: StepRuntimeProjection | undefined
  readonly run: RunSummary | null
  readonly runId: string | null
}

export function useStepRun(
  featureId: string,
  jobId: string | null,
  stepId: string | null,
  workflow: WorkflowProjection | null,
): StepRunResult {
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const runsState = useRuns(store, featureId)
  const feature = detailState.data?.feature

  const effectiveStepId = jobId !== null ? resolveInspectorStepId(workflow, feature, jobId, stepId) : null
  const step = effectiveStepId !== null && jobId !== null ? feature?.jobs[jobId]?.steps[effectiveStepId] : undefined

  const runs = runsState.data ?? []
  // Latest run for the step, not just any: after nudge/reap/recover a
  // step accumulates runs and the inspector must show the newest story.
  const run =
    effectiveStepId !== null && jobId !== null
      ? runs
          .filter(r => r.jobId === jobId && r.stepId === effectiveStepId)
          .sort((a, b) => b.timeStarted - a.timeStarted)[0] ?? null
      : null
  const runId = run?.id ?? step?.runId ?? null

  return { effectiveStepId, step, run, runId }
}

export interface RunLogResult {
  readonly cursor: LogCursor
}

/**
 * Tails one run's log to completion of every currently-available page,
 * then follows live `run_log` invalidations without duplicating lines.
 *
 * Tied to `runId` via a `LatestGuard`: switching selection to a
 * different run resets the cursor to `EMPTY_LOG_CURSOR` synchronously
 * (so the previous run's lines never flash under the new selection while
 * its first page is in flight) and invalidates any in-flight fetch for
 * the old run — a late-resolving page for a superseded selection can
 * never merge its lines into the new run's cursor.
 */
export function useRunLog(featureId: string, runId: string | null): RunLogResult {
  const { store } = useApp()
  const [cursor, setCursor] = useState<LogCursor>(EMPTY_LOG_CURSOR)
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const guard = useRef(new LatestGuard())
  const runIdRef = useRef(runId)
  runIdRef.current = runId

  const refresh = useCallback(async () => {
    const targetRunId = runIdRef.current
    if (targetRunId === null) return
    const ticket = guard.current.begin()
    try {
      const next = await loadAllLogPages(cursorRef.current, after => store.client.runLogs(targetRunId, after))
      // The selection may have moved on (or reset) while these pages were
      // in flight — a superseded ticket's result is discarded rather than
      // merged into whatever cursor is now current.
      if (!guard.current.isCurrent(ticket)) return
      setCursor(next)
    } catch {
      // 404 when run unknown / pruned — inspector sits idle
    }
  }, [store.client])

  useEffect(() => {
    // Reset and refetch live in one effect, in this order, so the reset
    // is visible to `refresh` synchronously: mutating `cursorRef` directly
    // (rather than only through `setCursor`, which would not be visible
    // until the next render) guarantees `refresh`'s first fetch for a new
    // runId starts from EMPTY_LOG_CURSOR and never carries over the
    // previous run's lines as its "already have" baseline. Fires on every
    // runId change, including to/from null.
    guard.current.invalidate()
    cursorRef.current = EMPTY_LOG_CURSOR
    setCursor(EMPTY_LOG_CURSOR)
    void refresh()
  }, [runId, refresh])

  useRunLogInvalidations(store, featureId, refresh)

  return { cursor }
}
