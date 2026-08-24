/**
 * React bindings over the invalidation store, via `useSyncExternalStore`.
 * Each hook subscribes to a typed resource and ensures it is loaded;
 * the snapshot reference is stable until the resource actually changes.
 */

import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from "react"
import type { ApiClient } from "./client.ts"
import type { AnswerRunResponse, CommandResponse, FeatureDetailResponse, StartFeatureRequest } from "./types.ts"
import type {
  DataSource,
  FeaturesState,
  FeatureDetailState,
  FindingsState,
  HealthState,
  PluginsState,
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

/**
 * Per-project workflow *name* lookup for scope derivation (design.md D4):
 * ensures each project's workflow resource is loaded and subscribes to
 * every one, returning `projectDir -> name` (`null` while loading or when
 * the workflow is unregistered/invalid — callers fall back to the
 * `"default"` sentinel, same convention as a feature's null `workflow`).
 * Not built on `useStore`, which is keyed to a single resource: the
 * project set is dynamic (driven by health), so this subscribes to one
 * key per project directly and re-renders on any of their changes.
 */
export function useWorkflowNames(store: DataSource, projectDirs: readonly string[]): Readonly<Record<string, string | null>> {
  const [version, bump] = useReducer((c: number) => c + 1, 0)
  const dirsKey = projectDirs.join("\u0000")

  useEffect(() => {
    const dirs = dirsKey === "" ? [] : dirsKey.split("\u0000")
    const unsubs = dirs.map(dir => store.subscribe(`workflow:${dir}`, bump))
    for (const dir of dirs) store.ensureWorkflowLoaded(dir)
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [store, dirsKey])

  return useMemo(() => {
    const dirs = dirsKey === "" ? [] : dirsKey.split("\u0000")
    const map: Record<string, string | null> = {}
    for (const dir of dirs) {
      const state = store.getWorkflow(dir).data
      map[dir] = state !== null && state.ok ? state.workflow.name : null
    }
    return map
    // `version` is read only to force recompute on any subscribed
    // workflow change (the actual data comes from `store.getWorkflow`,
    // not from `version` itself).
  }, [store, dirsKey, version])
}

export function useStreamConnected(store: DataSource): boolean {
  return useStore(store, "connection", s => s.isStreamConnected(), () => {})
}

/** `project` is the active board scope's project dir, or "" for the
 *  global-only listing (no scope selected yet). */
export function usePlugins(store: DataSource, project: string): PluginsState {
  return useStore(
    store,
    `plugins:${project}`,
    s => s.getPlugins(project),
    s => s.ensurePluginsLoaded(project),
  )
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
