/**
 * Invalidation store — the app's single source of live state.
 *
 * One SSE connection per app (`GET /v1/events`), fanned out to typed
 * resources surfaced via `useSyncExternalStore`. Invalidations are
 * coalesced over a ~150 ms window so a burst (`transition`+`run`+`feature`)
 * for one feature triggers one refetch pass. Refetch scope follows the
 * kind and what is on screen (brief rule 3). Command responses carry
 * fresh state and are applied directly; the echo invalidation for the
 * same feature is ignored within a short window. No polling in normal
 * operation: when the stream drops, the store shows a disconnected flag
 * and polls `GET /v1/health` every 5 s until the stream returns.
 */

import { ApiClient, ApiError, readSseStream, SseHttpError, type SseFrame } from "./client.ts"
import type {
  AnswerRunResponse,
  ChangeEvent,
  CommandResponse,
  DaemonHealth,
  FeatureDetail,
  FeatureDetailResponse,
  FeatureListItem,
  FindingView,
  PluginListingResponse,
  PluginsChangeEvent,
  RunSummary,
  StartFeatureRequest,
  TransitionEntry,
  WorkflowProjection,
} from "./types.ts"

export type ResourceStatus = "loading" | "ready" | "error"

export interface ResourceState<T> {
  readonly status: ResourceStatus
  readonly data: T | null
  readonly error: ApiError | null
  /** Monotonic bump; components can compare to detect refresh. */
  readonly version: number
}

export type FeaturesState = ResourceState<FeatureListItem[]>
export type FeatureDetailState = ResourceState<FeatureDetailResponse>
export type RunsState = ResourceState<RunSummary[]>
export type FindingsState = ResourceState<FindingView[]>
export type TimelineState = ResourceState<TransitionEntry[]>
export type HealthState = ResourceState<DaemonHealth>

export type WorkflowState =
  | { readonly ok: true; readonly workflow: WorkflowProjection }
  | { readonly ok: false; readonly state: "unregistered" | "invalid"; readonly message: string }

export type WorkflowResourceState = ResourceState<WorkflowState>

export type PluginsState = ResourceState<PluginListingResponse>

/** Coalescing window for SSE invalidations (brief rule 2). */
const COALESCE_WINDOW_MS = 150
/** Echo-skip window for the app's own command responses (brief rule 4). */
const ECHO_WINDOW_MS = 2_000
/** Health poll interval while the SSE stream is down (brief rule 7). */
const RECONNECT_HEALTH_POLL_MS = 5_000
/** Cap on the reconnect backoff (brief rule 6). */
const RECONNECT_BACKOFF_CAP_MS = 30_000
/** Bounded retry for transient load failures (base delay, doubling). */
const LOAD_RETRY_BASE_MS = 1_000
const LOAD_RETRY_MAX_ATTEMPTS = 3

/**
 * The not-yet-loaded snapshot MUST be one stable reference: getSnapshot
 * runs on every render, and useSyncExternalStore treats a fresh object
 * as "the store changed" — a per-call literal makes React re-render in
 * a loop and, under StrictMode's double render, blank the page.
 */
const EMPTY_RESOURCE = { status: "loading", data: null, error: null, version: 0 } as const

export interface DataSourceInput {
  readonly client: ApiClient
  /** Base URL for the SSE stream, e.g. "/v1/events". */
  readonly eventsUrl?: string
  readonly now?: () => number
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown
  readonly clearTimeoutFn?: (handle: unknown) => void
}

interface Inflight {
  readonly epoch: number
  readonly promise: Promise<void>
}

interface EchoState {
  at: number
  readonly deferred: Set<string>
  handle: unknown | null
}

export class DataSource {
  readonly client: ApiClient
  private readonly now: () => number
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void
  private readonly eventsUrl: string

  private features: FeaturesState = { status: "loading", data: null, error: null, version: 0 }
  private details = new Map<string, FeatureDetailState>()
  private runs = new Map<string, RunsState>()
  private findings = new Map<string, FindingsState>()
  private timelines = new Map<string, TimelineState>()
  private workflows = new Map<string, WorkflowResourceState>()
  private health: HealthState = { status: "loading", data: null, error: null, version: 0 }
  /** Keyed by the active scope's project dir, or "" for the no-scope
   *  (global-only) listing — mirrors `workflows`. */
  private plugins = new Map<string, PluginsState>()

  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly runLogListeners = new Map<string, Set<() => void>>()
  private readonly inflight = new Map<string, Inflight>()
  private readonly authority = new Map<string, number>()
  private readonly retryHandles = new Map<string, unknown>()
  private readonly echo = new Map<string, EchoState>()
  private readonly commandChains = new Map<string, Promise<void>>()

  private readonly pending = new Map<string, ChangeEvent | PluginsChangeEvent>()
  private coalesceTimer: unknown | null = null

  private streamConnected = false
  private streamStopped = false
  private streamRunning = false
  private reconnectHandle: unknown | null = null
  private healthPollHandle: unknown | null = null
  private readonly reconnectDelay = { ms: 2_000 }

  private activeFeatureId: string | null = null

  constructor(input: DataSourceInput) {
    this.client = input.client
    this.eventsUrl = input.eventsUrl ?? "/v1/events"
    this.now = input.now ?? (() => Date.now())
    this.setTimeoutFn = input.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = input.clearTimeoutFn ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  // ------------------------------------------------------------ resources

  /** Whether the SSE stream is currently open — drives the reconnecting chip. */
  isStreamConnected(): boolean {
    return this.streamConnected
  }

  getFeatures(): FeaturesState {
    return this.features
  }

  getFeatureDetail(featureId: string): FeatureDetailState {
    return this.details.get(featureId) ?? EMPTY_RESOURCE
  }

  getRuns(featureId: string): RunsState {
    return this.runs.get(featureId) ?? EMPTY_RESOURCE
  }

  getFindings(featureId: string): FindingsState {
    return this.findings.get(featureId) ?? EMPTY_RESOURCE
  }

  getTimeline(featureId: string): TimelineState {
    return this.timelines.get(featureId) ?? EMPTY_RESOURCE
  }

  getWorkflow(projectDir: string): WorkflowResourceState {
    return this.workflows.get(projectDir) ?? EMPTY_RESOURCE
  }

  getHealth(): HealthState {
    return this.health
  }

  getPlugins(project: string): PluginsState {
    return this.plugins.get(project) ?? EMPTY_RESOURCE
  }

  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  private emit(key: string): void {
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener()
  }

  // ------------------------------------------------------------ loading

  ensureFeaturesLoaded(): void {
    this.ensure("features", () => this.client.listFeatures())
  }

  ensureFeatureDetailLoaded(featureId: string): void {
    this.ensure(`detail:${featureId}`, () => this.client.featureDetail(featureId))
  }

  ensureRunsLoaded(featureId: string): void {
    this.ensure(`runs:${featureId}`, () => this.client.runs(featureId))
  }

  ensureFindingsLoaded(featureId: string): void {
    this.ensure(`findings:${featureId}`, () => this.client.findings(featureId))
  }

  ensureTimelineLoaded(featureId: string): void {
    this.ensure(`timeline:${featureId}`, () => this.client.timeline(featureId))
  }

  ensureWorkflowLoaded(projectDir: string): void {
    if (projectDir === "") return
    this.ensure(`workflow:${projectDir}`, () => this.client.workflowState(projectDir))
  }

  /** Force-refetch one project's workflow projection — used after a
   *  `unknown_workflow`/`invalid_input` start rejection so the start
   *  surface's target metadata reflects whatever changed underneath it. */
  refetchWorkflow(projectDir: string): Promise<void> {
    if (projectDir === "") return Promise.resolve()
    return this.ensure(`workflow:${projectDir}`, () => this.client.workflowState(projectDir), true)
  }

  ensureHealthLoaded(): void {
    this.ensure("health", () => this.client.health())
  }

  refreshHealth(): Promise<void> {
    return this.ensure("health", () => this.client.health(), true)
  }

  ensurePluginsLoaded(project: string): void {
    this.ensure(`plugins:${project}`, () => this.client.plugins(project === "" ? undefined : project))
  }

  /** Force-refetch the plugin listing for a scope — used on a `plugins`
   *  SSE invalidation and on board scope change. */
  refetchPlugins(project: string): Promise<void> {
    return this.ensure(`plugins:${project}`, () => this.client.plugins(project === "" ? undefined : project), true)
  }

  /** Force-refetch the feature detail (e.g. after a 409 race). */
  refetchFeatureDetail(featureId: string): Promise<void> {
    return this.ensure(`detail:${featureId}`, () => this.client.featureDetail(featureId), true)
  }

  refetchRuns(featureId: string): Promise<void> {
    return this.ensure(`runs:${featureId}`, () => this.client.runs(featureId), true)
  }

  refetchFindings(featureId: string): Promise<void> {
    return this.ensure(`findings:${featureId}`, () => this.client.findings(featureId), true)
  }

  refetchTimeline(featureId: string): Promise<void> {
    return this.ensure(`timeline:${featureId}`, () => this.client.timeline(featureId), true)
  }

  private ensure(key: string, loader: () => Promise<unknown>, force = false): Promise<void> {
    const existing = this.inflight.get(key)
    if (existing !== undefined && !force) return existing.promise
    // "Ensure" means load-once: a resource that already settled (ready or
    // error) is only refetched by an explicit force (SSE invalidation,
    // refresh, retry). Without this check every React render re-triggers
    // a fetch — fetch → emit → render → ensure → fetch, a hot loop.
    if (!force && this.statusOf(key) !== "loading") return Promise.resolve()
    return this.load(key, loader, force ? LOAD_RETRY_MAX_ATTEMPTS : 0)
  }

  private load(key: string, loader: () => Promise<unknown>, attempt: number): Promise<void> {
    const epoch = this.bumpAuthority(key)
    const promise = loader()
      .then(data => {
        if (!this.isAuthoritative(key, epoch)) return
        this.inflight.delete(key)
        this.setResource(key, { status: "ready", data, error: null })
      })
      .catch((err: unknown) => {
        if (!this.isAuthoritative(key, epoch)) return
        const error = err instanceof ApiError ? err : new ApiError(0, "internal", String(err), null)
        if (error.status === 401) {
          // `ApiClient.request` already invoked `onUnauthorized` — the
          // central 401 handler for every read and mutation — so this
          // branch only needs to stop the retry loop and record the error.
          this.inflight.delete(key)
          this.setResource(key, { status: "error", data: this.dataOf(key), error })
          // The plugin listing itself is bearer-authorized; a 401 here
          // means the bearer token is still valid (or `onUnauthorized`
          // would already be resetting the app) but the plugin-session
          // cookie panels rely on may have lapsed (daemon restart) —
          // best-effort re-exchange so the NEXT panel load works.
          if (key.startsWith("plugins:")) void this.client.exchangePluginSession().catch(() => {})
          return
        }
        // Transient failures on the initial (non-forced) load get a small
        // bounded retry: without it a single blip would strand resources
        // with no other refetch trigger (workflow: has no SSE kind) in a
        // permanent error state. Forced refetches carry attempt 1+ and
        // rely on their own trigger repeating instead.
        if (attempt < LOAD_RETRY_MAX_ATTEMPTS) {
          return new Promise<void>(resolve => {
            const handle = this.setTimeoutFn(() => {
              this.retryHandles.delete(key)
              if (!this.isAuthoritative(key, epoch)) {
                resolve()
                return
              }
              void this.load(key, loader, attempt + 1).then(resolve)
            }, LOAD_RETRY_BASE_MS * 2 ** attempt)
            this.retryHandles.set(key, handle)
          })
        }
        this.inflight.delete(key)
        this.setResource(key, { status: "error", data: this.dataOf(key), error })
      })
    this.inflight.set(key, { epoch, promise })
    return promise
  }

  private bumpAuthority(key: string): number {
    const epoch = (this.authority.get(key) ?? 0) + 1
    this.authority.set(key, epoch)
    return epoch
  }

  private isAuthoritative(key: string, epoch: number): boolean {
    return this.authority.get(key) === epoch && this.inflight.get(key)?.epoch === epoch
  }

  private dataOf(key: string): unknown {
    if (key === "features") return this.features.data
    if (key === "health") return this.health.data
    if (key.startsWith("detail:")) return this.details.get(key.slice(7))?.data ?? null
    if (key.startsWith("runs:")) return this.runs.get(key.slice(5))?.data ?? null
    if (key.startsWith("findings:")) return this.findings.get(key.slice(9))?.data ?? null
    if (key.startsWith("timeline:")) return this.timelines.get(key.slice(9))?.data ?? null
    if (key.startsWith("workflow:")) return this.workflows.get(key.slice(9))?.data ?? null
    if (key.startsWith("plugins:")) return this.plugins.get(key.slice(8))?.data ?? null
    return null
  }

  private setResource(key: string, state: { status: ResourceStatus; data: unknown; error: ApiError | null }): void {
    const isFeatures = key === "features"
    const isHealth = key === "health"
    const isDetail = key.startsWith("detail:")
    const isRuns = key.startsWith("runs:")
    const isFindings = key.startsWith("findings:")
    const isTimeline = key.startsWith("timeline:")
    const isWorkflow = key.startsWith("workflow:")
    const isPlugins = key.startsWith("plugins:")

    const version = this.versionOf(key) + 1
    const next = { ...state, version }
    if (isFeatures) {
      this.features = next as FeaturesState
    } else if (isHealth) {
      this.health = next as HealthState
    } else if (isDetail) {
      const id = key.slice("detail:".length)
      this.details.set(id, next as FeatureDetailState)
    } else if (isRuns) {
      this.runs.set(key.slice("runs:".length), next as RunsState)
    } else if (isFindings) {
      this.findings.set(key.slice("findings:".length), next as FindingsState)
    } else if (isTimeline) {
      this.timelines.set(key.slice("timeline:".length), next as TimelineState)
    } else if (isWorkflow) {
      this.workflows.set(key.slice("workflow:".length), next as WorkflowResourceState)
    } else if (isPlugins) {
      this.plugins.set(key.slice("plugins:".length), next as PluginsState)
    }
    this.emit(key)
  }

  private statusOf(key: string): ResourceStatus {
    if (key === "features") return this.features.status
    if (key === "health") return this.health.status
    if (key.startsWith("detail:")) return this.details.get(key.slice(7))?.status ?? "loading"
    if (key.startsWith("runs:")) return this.runs.get(key.slice(5))?.status ?? "loading"
    if (key.startsWith("findings:")) return this.findings.get(key.slice(9))?.status ?? "loading"
    if (key.startsWith("timeline:")) return this.timelines.get(key.slice(9))?.status ?? "loading"
    if (key.startsWith("workflow:")) return this.workflows.get(key.slice(9))?.status ?? "loading"
    if (key.startsWith("plugins:")) return this.plugins.get(key.slice(8))?.status ?? "loading"
    return "loading"
  }

  private versionOf(key: string): number {
    if (key === "features") return this.features.version
    if (key === "health") return this.health.version
    if (key.startsWith("detail:")) return this.details.get(key.slice(7))?.version ?? 0
    if (key.startsWith("runs:")) return this.runs.get(key.slice(5))?.version ?? 0
    if (key.startsWith("findings:")) return this.findings.get(key.slice(9))?.version ?? 0
    if (key.startsWith("timeline:")) return this.timelines.get(key.slice(9))?.version ?? 0
    if (key.startsWith("workflow:")) return this.workflows.get(key.slice(9))?.version ?? 0
    if (key.startsWith("plugins:")) return this.plugins.get(key.slice(8))?.version ?? 0
    return 0
  }

  // ------------------------------------------------------------ commands

  /**
   * Run a command, apply the fresh payload the server returned, suppress
   * the echo invalidation for the feature, and refresh the board list.
   * The promise rejects with the typed ApiError on failure.
   */
  async command<T extends FeatureDetailResponse | CommandResponse>(
    featureId: string,
    run: (client: ApiClient) => Promise<T>,
  ): Promise<T> {
    return this.enqueueCommand(featureId, async () => {
      const payload = await run(this.client)
      this.armEcho(featureId)
      this.applyDetail(featureId, payload)
      await this.refreshFeatures()
      return payload
    })
  }

  /**
   * Answer a run's pending question. Unlike `command`, the server's
   * response (`{result, run}`) is NOT a feature detail payload — it must
   * never reach `applyDetail`. The feature's authoritative post-answer
   * state (status flips back to `running`, the question clears) is only
   * known through a real refetch, so this forces fresh detail and runs
   * for the feature and still arms the echo suppression window: the
   * server's own `transition`/`run`/`feature` invalidations for this
   * answer would otherwise trigger a second, redundant refetch pass
   * moments after the one this method already performed.
   */
  async answerRun(featureId: string, run: (client: ApiClient) => Promise<AnswerRunResponse>): Promise<AnswerRunResponse> {
    return this.enqueueCommand(featureId, async () => {
      const payload = await run(this.client)
      this.armEcho(featureId)
      await Promise.all([
        this.refetchFeatureDetail(featureId),
        this.refetchRuns(featureId),
        this.refreshFeatures(),
      ])
      return payload
    })
  }

  applyDetail(featureId: string, payload: FeatureDetailResponse): void {
    const key = `detail:${featureId}`
    this.bumpAuthority(key)
    this.inflight.delete(key)
    const prev = this.details.get(featureId)
    this.details.set(featureId, {
      status: "ready",
      data: payload,
      error: null,
      version: (prev?.version ?? 0) + 1,
    })
    this.emit(`detail:${featureId}`)
  }

  private refreshFeatures(): Promise<void> {
    return this.ensure("features", () => this.client.listFeatures(), true)
  }

  /**
   * Start a feature — non-optimistic: there is no feature id, and
   * therefore no cache entry, until the daemon's 201 response arrives.
   * On success the response is applied as immediately-authoritative
   * detail/list state:
   *
   *  1. authority for both the new detail resource and the feature list
   *     is bumped BEFORE the request even starts, so any older in-flight
   *     load for either — including one an early SSE `feature`
   *     invalidation kicks off while this POST is still pending — cannot
   *     land after and clobber the response;
   *  2. the returned detail is applied directly (`applyDetail`) and, if
   *     the list is already loaded, upserted into its projection so the
   *     new feature appears without waiting for a refetch;
   *  3. the echo-suppression window is armed for the new feature id,
   *     same as any other command, so its own `feature`/`transition`
   *     invalidation from the initial dispatch doesn't trigger a
   *     redundant refetch moments later;
   *  4. a list refresh is started best-effort — its failure is swallowed
   *     and never turns a successful creation into a failed one (design.md
   *     "Post-create list refresh fails").
   *
   * Rejects with the typed `ApiError` on failure; the cache is untouched
   * on a rejected POST.
   */
  async startFeature(request: StartFeatureRequest): Promise<FeatureDetailResponse> {
    const payload = await this.client.startFeature(request)
    const featureId = payload.feature.id
    // Bump list authority now, right as the response lands, before any
    // further await: an older in-flight `features` GET — including one
    // an early SSE `feature` invalidation kicked off while this POST was
    // still pending (the daemon dispatches `feature.start` before
    // responding) — carries an epoch this bump invalidates, so it can
    // never land afterward and silently drop the feature this response
    // just proved exists. `applyDetail` performs the equivalent bump for
    // the detail resource itself.
    this.bumpAuthority("features")
    this.applyDetail(featureId, payload)
    this.armEcho(featureId)
    this.upsertFeatureListItem(payload.feature)
    void this.refreshFeatures().catch(() => {
      // Best-effort: a failed post-create list refresh never turns a
      // successful creation into a failure. The list stays on whatever
      // it already had (including the upsert above) until a later
      // trigger (SSE, manual refresh) succeeds.
    })
    return payload
  }

  /** Insert or replace the new feature's row in the already-loaded list
   *  projection, without waiting for `refreshFeatures`'s real refetch —
   *  keeps the board/board-empty-state view honest immediately after a
   *  browser-initiated start even if the follow-up list GET is slow or
   *  fails. A no-op while the list has never loaded (its own `ensure`
   *  will fetch the authoritative set once requested). */
  private upsertFeatureListItem(feature: FeatureDetail): void {
    if (this.features.status !== "ready" || this.features.data === null) return
    const jobs: Record<string, { status: FeatureListItem["jobs"][string]["status"]; currentStep: string | null }> = {}
    for (const [jobId, job] of Object.entries(feature.jobs)) {
      jobs[jobId] = { status: job.status, currentStep: job.currentStep }
    }
    const item: FeatureListItem = {
      id: feature.id,
      title: feature.title,
      slug: feature.slug,
      projectDir: feature.projectDir,
      workflow: feature.workflow,
      description: feature.description,
      status: feature.status,
      sessionId: feature.sessionId,
      worktree: feature.worktree,
      branch: feature.branch,
      pr: feature.pr,
      escalation: feature.escalation,
      currentStep: feature.currentStep,
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt,
      findingCounts: feature.findingCounts,
      jobs,
    }
    const existing = this.features.data
    const next = existing.some(f => f.id === item.id) ? existing.map(f => (f.id === item.id ? item : f)) : [item, ...existing]
    this.features = { ...this.features, data: next, version: this.features.version + 1 }
    this.emit("features")
  }

  private enqueueCommand<T>(featureId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.commandChains.get(featureId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(run)
    const settled = current.then(() => {}, () => {})
    this.commandChains.set(featureId, settled)
    void settled.then(() => {
      if (this.commandChains.get(featureId) === settled) this.commandChains.delete(featureId)
    })
    return current
  }

  private armEcho(featureId: string): void {
    const existing = this.echo.get(featureId)
    if (existing !== undefined) {
      existing.at = this.now()
      return
    }
    this.echo.set(featureId, { at: this.now(), deferred: new Set(), handle: null })
  }

  // ------------------------------------------------------------ SSE

  /** The store decides which feature is on screen for refetch scoping. */
  setActiveFeature(featureId: string | null): void {
    this.activeFeatureId = featureId
  }

  async start(): Promise<void> {
    // stop() is a pause, not a terminal state: re-auth restarts the stream.
    this.streamStopped = false
    this.reconnectDelay.ms = 2_000
    this.ensureHealthLoaded()
    void this.connectStream()
  }

  private async connectStream(): Promise<void> {
    if (this.streamStopped || this.streamRunning) return
    this.streamRunning = true
    try {
      await readSseStream({
        url: this.eventsUrl,
        token: () => this.client.getToken(),
        onFrame: frame => this.onFrame(frame),
        onRetryDelay: ms => {
          this.reconnectDelay.ms = ms
        },
      })
      this.streamRunning = false
      if (this.streamStopped) return
      this.drop()
    } catch (err) {
      this.streamRunning = false
      if (this.streamStopped) return
      if (err instanceof SseHttpError && err.status === 401) {
        this.streamConnected = false
        this.emit("connection")
        this.client.onUnauthorized?.()
        return
      }
      this.drop()
    }
  }

  private drop(): void {
    this.streamConnected = false
    this.emit("connection")
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.streamStopped || this.reconnectHandle !== null) return
    const delay = Math.min(this.reconnectDelay.ms, RECONNECT_BACKOFF_CAP_MS)
    this.reconnectDelay.ms = this.reconnectDelay.ms * 2
    this.reconnectHandle = this.setTimeoutFn(() => {
      this.reconnectHandle = null
      void this.connectStream()
    }, delay)
    this.startHealthPolling()
  }

  private startHealthPolling(): void {
    if (this.healthPollHandle !== null) return
    const poll = () => {
      if (this.streamConnected || this.streamStopped) {
        this.healthPollHandle = null
        return
      }
      this.refreshHealth()
      this.healthPollHandle = this.setTimeoutFn(poll, RECONNECT_HEALTH_POLL_MS)
    }
    this.healthPollHandle = this.setTimeoutFn(poll, RECONNECT_HEALTH_POLL_MS)
  }

  private onFrame(frame: SseFrame): void {
    if (frame.type === "hello") {
      this.streamConnected = true
      this.reconnectDelay.ms = 2_000
      if (this.healthPollHandle !== null) {
        this.clearTimeoutFn(this.healthPollHandle)
        this.healthPollHandle = null
      }
      this.emit("connection")
      this.refreshHealth()
      return
    }
    this.queue(frame.change)
  }

  private queue(change: ChangeEvent | PluginsChangeEvent): void {
    const key = change.kind === "plugins" ? "plugins" : `${change.kind}:${change.featureId}`
    this.pending.set(key, change)
    if (this.coalesceTimer === null) {
      this.coalesceTimer = this.setTimeoutFn(() => {
        this.coalesceTimer = null
        this.flush()
      }, COALESCE_WINDOW_MS)
    }
  }

  private flush(): void {
    if (this.pending.size === 0) return
    const changes = [...this.pending.values()]
    this.pending.clear()
    this.refreshHealth()
    // One refetch pass: collect targets as a set so a burst
    // (transition+run+feature for one feature) hits each endpoint once.
    const targets = new Set<string>()
    for (const change of changes) {
      if (change.kind === "plugins") {
        targets.add("plugins")
        continue
      }
      this.collectTargets(change, targets)
    }
    for (const target of targets) this.executeTarget(target)
  }

  private collectTargets(change: ChangeEvent, targets: Set<string>): void {
    const echoed = this.echo.get(change.featureId)
    const inEchoWindow = echoed !== undefined && this.now() - echoed.at < ECHO_WINDOW_MS
    if (echoed !== undefined && !inEchoWindow) this.releaseEcho(change.featureId, echoed)
    const onScreen = this.activeFeatureId !== null && change.featureId === this.activeFeatureId
    switch (change.kind) {
      case "feature":
        this.addCoveredTarget(change.featureId, "features", inEchoWindow, targets)
        if (onScreen) this.addCoveredTarget(change.featureId, `detail:${change.featureId}`, inEchoWindow, targets)
        break
      case "transition":
        if (onScreen) {
          this.addCoveredTarget(change.featureId, `detail:${change.featureId}`, inEchoWindow, targets)
          targets.add(`timeline:${change.featureId}`)
        }
        this.addCoveredTarget(change.featureId, "features", inEchoWindow, targets)
        break
      case "run":
        if (onScreen) {
          this.addCoveredTarget(change.featureId, `detail:${change.featureId}`, inEchoWindow, targets)
          targets.add(`runs:${change.featureId}`)
        }
        this.addCoveredTarget(change.featureId, "features", inEchoWindow, targets)
        break
      case "finding":
        if (onScreen) targets.add(`findings:${change.featureId}`)
        targets.add("features")
        break
      case "run_log":
        targets.add(`run_log:${change.featureId}`)
        break
    }
  }

  private addCoveredTarget(featureId: string, target: string, defer: boolean, targets: Set<string>): void {
    if (!defer) {
      targets.add(target)
      return
    }
    const echo = this.echo.get(featureId)
    if (echo === undefined) {
      targets.add(target)
      return
    }
    echo.deferred.add(target)
    this.scheduleEchoRelease(featureId, echo)
  }

  private scheduleEchoRelease(featureId: string, echo: EchoState): void {
    if (echo.handle !== null) return
    const delay = Math.max(0, ECHO_WINDOW_MS - (this.now() - echo.at))
    echo.handle = this.setTimeoutFn(() => {
      echo.handle = null
      if (this.echo.get(featureId) !== echo) return
      if (this.now() - echo.at < ECHO_WINDOW_MS) {
        this.scheduleEchoRelease(featureId, echo)
        return
      }
      this.releaseEcho(featureId, echo)
    }, delay)
  }

  private releaseEcho(featureId: string, echo: EchoState): void {
    if (echo.handle !== null) this.clearTimeoutFn(echo.handle)
    this.echo.delete(featureId)
    for (const target of echo.deferred) this.executeTarget(target)
  }

  private executeTarget(target: string): void {
    if (target === "features") {
      this.refreshFeatures()
    } else if (target.startsWith("detail:")) {
      this.refetchFeatureDetail(target.slice(7))
    } else if (target.startsWith("timeline:")) {
      this.refetchTimeline(target.slice(9))
    } else if (target.startsWith("runs:")) {
      this.refetchRuns(target.slice(5))
    } else if (target.startsWith("findings:")) {
      this.refetchFindings(target.slice(9))
    } else if (target.startsWith("run_log:")) {
      this.emitRunLog(target.slice(8))
    } else if (target === "plugins") {
      // No single "active scope" concept lives in the store (unlike
      // `activeFeatureId`) — refetch every scope a rail has ever loaded.
      for (const scope of this.plugins.keys()) this.refetchPlugins(scope)
    }
  }

  // ------------------------------------------------------ run_log fan-out

  subscribeRunLog(featureId: string, listener: () => void): () => void {
    let set = this.runLogListeners.get(featureId)
    if (set === undefined) {
      set = new Set()
      this.runLogListeners.set(featureId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  private emitRunLog(featureId: string): void {
    for (const listener of [...(this.runLogListeners.get(featureId) ?? [])]) listener()
  }

  // ------------------------------------------------------------ lifecycle

  stop(): void {
    this.streamStopped = true
    if (this.coalesceTimer !== null) {
      this.clearTimeoutFn(this.coalesceTimer)
      this.coalesceTimer = null
    }
    if (this.reconnectHandle !== null) {
      this.clearTimeoutFn(this.reconnectHandle)
      this.reconnectHandle = null
    }
    if (this.healthPollHandle !== null) {
      this.clearTimeoutFn(this.healthPollHandle)
      this.healthPollHandle = null
    }
    for (const handle of this.retryHandles.values()) this.clearTimeoutFn(handle)
    this.retryHandles.clear()
    for (const echo of this.echo.values()) {
      if (echo.handle !== null) this.clearTimeoutFn(echo.handle)
    }
    this.echo.clear()
  }
}
