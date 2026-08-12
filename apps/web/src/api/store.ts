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
  ChangeEvent,
  CommandResponse,
  DaemonHealth,
  FeatureDetailResponse,
  FeatureListItem,
  FindingView,
  RunSummary,
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

export interface DataSourceInput {
  readonly client: ApiClient
  /** Base URL for the SSE stream, e.g. "/v1/events". */
  readonly eventsUrl?: string
  readonly now?: () => number
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown
  readonly clearTimeoutFn?: (handle: unknown) => void
}

interface Inflight {
  readonly id: number
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

  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly runLogListeners = new Map<string, Set<() => void>>()
  private readonly inflight = new Map<string, Inflight>()
  private readonly retryHandles = new Map<string, unknown>()
  private readonly echo = new Map<string, number>()

  private readonly pending = new Map<string, ChangeEvent>()
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
    return this.details.get(featureId) ?? { status: "loading", data: null, error: null, version: 0 }
  }

  getRuns(featureId: string): RunsState {
    return this.runs.get(featureId) ?? { status: "loading", data: null, error: null, version: 0 }
  }

  getFindings(featureId: string): FindingsState {
    return this.findings.get(featureId) ?? { status: "loading", data: null, error: null, version: 0 }
  }

  getTimeline(featureId: string): TimelineState {
    return this.timelines.get(featureId) ?? { status: "loading", data: null, error: null, version: 0 }
  }

  getWorkflow(projectDir: string): WorkflowResourceState {
    return this.workflows.get(projectDir) ?? { status: "loading", data: null, error: null, version: 0 }
  }

  getHealth(): HealthState {
    return this.health
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

  ensureHealthLoaded(): void {
    this.ensure("health", () => this.client.health())
  }

  refreshHealth(): void {
    this.ensure("health", () => this.client.health(), true)
  }

  /** Force-refetch the feature detail (e.g. after a 409 race). */
  refetchFeatureDetail(featureId: string): void {
    this.ensure(`detail:${featureId}`, () => this.client.featureDetail(featureId), true)
  }

  refetchRuns(featureId: string): void {
    this.ensure(`runs:${featureId}`, () => this.client.runs(featureId), true)
  }

  refetchFindings(featureId: string): void {
    this.ensure(`findings:${featureId}`, () => this.client.findings(featureId), true)
  }

  refetchTimeline(featureId: string): void {
    this.ensure(`timeline:${featureId}`, () => this.client.timeline(featureId), true)
  }

  private ensure(key: string, loader: () => Promise<unknown>, force = false): void {
    const existing = this.inflight.get(key)
    if (existing !== undefined && !force) return
    // "Ensure" means load-once: a resource that already settled (ready or
    // error) is only refetched by an explicit force (SSE invalidation,
    // refresh, retry). Without this check every React render re-triggers
    // a fetch — fetch → emit → render → ensure → fetch, a hot loop.
    if (!force && this.statusOf(key) !== "loading") return
    this.load(key, loader, force ? LOAD_RETRY_MAX_ATTEMPTS : 0)
  }

  private load(key: string, loader: () => Promise<unknown>, attempt: number): void {
    const requestId = (this.inflight.get(key)?.id ?? 0) + 1
    this.inflight.set(key, { id: requestId })
    loader()
      .then(data => {
        if (this.inflight.get(key)?.id !== requestId) return
        this.inflight.delete(key)
        this.setResource(key, { status: "ready", data, error: null })
      })
      .catch((err: unknown) => {
        if (this.inflight.get(key)?.id !== requestId) return
        const error = err instanceof ApiError ? err : new ApiError(0, "internal", String(err), null)
        if (error.status === 401) {
          this.inflight.delete(key)
          this.client.onUnauthorized?.()
          this.setResource(key, { status: "error", data: this.dataOf(key), error })
          return
        }
        // Transient failures on the initial (non-forced) load get a small
        // bounded retry: without it a single blip would strand resources
        // with no other refetch trigger (workflow: has no SSE kind) in a
        // permanent error state. Forced refetches carry attempt 1+ and
        // rely on their own trigger repeating instead.
        if (attempt < LOAD_RETRY_MAX_ATTEMPTS) {
          const handle = this.setTimeoutFn(() => {
            this.retryHandles.delete(key)
            if (this.inflight.get(key)?.id !== requestId) return
            this.load(key, loader, attempt + 1)
          }, LOAD_RETRY_BASE_MS * 2 ** attempt)
          this.retryHandles.set(key, handle)
          return
        }
        this.inflight.delete(key)
        this.setResource(key, { status: "error", data: this.dataOf(key), error })
      })
  }

  private dataOf(key: string): unknown {
    if (key === "features") return this.features.data
    if (key === "health") return this.health.data
    if (key.startsWith("detail:")) return this.details.get(key.slice(7))?.data ?? null
    if (key.startsWith("runs:")) return this.runs.get(key.slice(5))?.data ?? null
    if (key.startsWith("findings:")) return this.findings.get(key.slice(9))?.data ?? null
    if (key.startsWith("timeline:")) return this.timelines.get(key.slice(9))?.data ?? null
    if (key.startsWith("workflow:")) return this.workflows.get(key.slice(9))?.data ?? null
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
    return 0
  }

  // ------------------------------------------------------------ commands

  /**
   * Run a command, apply the fresh payload the server returned, suppress
   * the echo invalidation for the feature, and refresh the board list.
   * The promise rejects with the typed ApiError on failure.
   */
  async command(
    featureId: string,
    run: (client: ApiClient) => Promise<FeatureDetailResponse | CommandResponse>,
  ): Promise<void> {
    const payload = await run(this.client)
    this.echo.set(featureId, this.now())
    this.applyDetail(featureId, payload)
    this.refreshFeatures()
  }

  applyDetail(featureId: string, payload: FeatureDetailResponse): void {
    const prev = this.details.get(featureId)
    this.details.set(featureId, {
      status: "ready",
      data: payload,
      error: null,
      version: (prev?.version ?? 0) + 1,
    })
    this.emit(`detail:${featureId}`)
  }

  private refreshFeatures(): void {
    this.ensure("features", () => this.client.listFeatures(), true)
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

  private queue(change: ChangeEvent): void {
    this.pending.set(`${change.kind}:${change.featureId}`, change)
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
    for (const change of changes) this.collectTargets(change, targets)
    for (const target of targets) this.executeTarget(target)
  }

  private collectTargets(change: ChangeEvent, targets: Set<string>): void {
    // A command response was applied for this feature moments ago: every
    // invalidation kind echoing that write inside the window is suppressed
    // (a transition+run burst is one echo, not one echo plus a refetch).
    // The entry expires by time, never by first match.
    const echoedAt = this.echo.get(change.featureId)
    if (echoedAt !== undefined) {
      if (this.now() - echoedAt < ECHO_WINDOW_MS) return
      this.echo.delete(change.featureId)
    }
    const onScreen = this.activeFeatureId !== null && change.featureId === this.activeFeatureId
    switch (change.kind) {
      case "feature":
        targets.add("features")
        if (onScreen) targets.add(`detail:${change.featureId}`)
        break
      case "transition":
        if (onScreen) {
          targets.add(`detail:${change.featureId}`)
          targets.add(`timeline:${change.featureId}`)
        }
        targets.add("features")
        break
      case "run":
        if (onScreen) {
          targets.add(`detail:${change.featureId}`)
          targets.add(`runs:${change.featureId}`)
        }
        targets.add("features")
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
  }
}
