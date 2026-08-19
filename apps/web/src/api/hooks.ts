/**
 * React bindings over the invalidation store, via `useSyncExternalStore`.
 * Each hook subscribes to a typed resource and ensures it is loaded;
 * the snapshot reference is stable until the resource actually changes.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { ApiClient } from "./client.ts"
import type { AnswerRunResponse, CommandResponse, FeatureDetailResponse, StartFeatureRequest } from "./types.ts"
import type {
  DataSource,
  FeaturesState,
  FeatureDetailState,
  FindingsState,
  HealthState,
  RunsState,
  TimelineState,
  WorkflowResourceState,
} from "./store.ts"

function useStore<T>(
  store: DataSource,
  key: string,
  get: (s: DataSource) => T,
  ensure: (s: DataSource) => void,
): T {
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key])
  const getSnapshot = useCallback(() => get(store), [store, get])
  const ensureKey = useCallback(() => ensure(store), [store, ensure])
  useEffect(() => {
    ensureKey()
  }, [ensureKey])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useFeatures(store: DataSource): FeaturesState {
  return useStore(store, "features", s => s.getFeatures(), s => s.ensureFeaturesLoaded())
}

export function useFeatureDetail(store: DataSource, featureId: string): FeatureDetailState {
  return useStore(
    store,
    `detail:${featureId}`,
    s => s.getFeatureDetail(featureId),
    s => s.ensureFeatureDetailLoaded(featureId),
  )
}

export function useRuns(store: DataSource, featureId: string): RunsState {
  return useStore(store, `runs:${featureId}`, s => s.getRuns(featureId), s => s.ensureRunsLoaded(featureId))
}

export function useFindings(store: DataSource, featureId: string): FindingsState {
  return useStore(
    store,
    `findings:${featureId}`,
    s => s.getFindings(featureId),
    s => s.ensureFindingsLoaded(featureId),
  )
}

export function useTimeline(store: DataSource, featureId: string): TimelineState {
  return useStore(
    store,
    `timeline:${featureId}`,
    s => s.getTimeline(featureId),
    s => s.ensureTimelineLoaded(featureId),
  )
}

export function useWorkflow(store: DataSource, projectDir: string): WorkflowResourceState {
  return useStore(
    store,
    `workflow:${projectDir}`,
    s => s.getWorkflow(projectDir),
    s => s.ensureWorkflowLoaded(projectDir),
  )
}

export function useHealth(store: DataSource): HealthState {
  return useStore(store, "health", s => s.getHealth(), s => s.ensureHealthLoaded())
}

export function useStreamConnected(store: DataSource): boolean {
  return useStore(store, "connection", s => s.isStreamConnected(), () => {})
}

/** Subscribe to `run_log` invalidations for a feature (no snapshot). */
export function useRunLogInvalidations(store: DataSource, featureId: string, listener: () => void): void {
  useEffect(() => store.subscribeRunLog(featureId, listener), [store, featureId, listener])
}

/** Command runner bound to the store — applies fresh state, skips echo. */
export function useCommand(
  store: DataSource,
): <T extends CommandResponse | FeatureDetailResponse>(featureId: string, run: (client: ApiClient) => Promise<T>) => Promise<T> {
  return useCallback((featureId, run) => store.command(featureId, run), [store])
}

/** Bound `answerRun` runner — refetches detail/runs instead of treating
 *  the response as a feature detail payload (see `DataSource.answerRun`). */
export function useAnswerRun(
  store: DataSource,
): (featureId: string, run: (client: ApiClient) => Promise<AnswerRunResponse>) => Promise<AnswerRunResponse> {
  return useCallback((featureId, run) => store.answerRun(featureId, run), [store])
}

/** Bound `startFeature` runner — non-optimistic authoritative creation
 *  (see `DataSource.startFeature`). */
export function useStartFeature(store: DataSource): (request: StartFeatureRequest) => Promise<FeatureDetailResponse> {
  return useCallback((request: StartFeatureRequest) => store.startFeature(request), [store])
}
