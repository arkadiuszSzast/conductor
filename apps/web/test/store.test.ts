/**
 * Invalidation store — the SSE→refetch contract from the brief:
 * coalescing (burst → one refetch pass), targeted refetch by kind,
 * own-command echo skip, and the 401 → auth-fail path.
 */
import { describe, expect, it } from "bun:test"
import { ApiClient, ApiError, type FetchLike } from "../src/api/client.ts"
import { DataSource } from "../src/api/store.ts"
import type { FeatureDetailResponse, FeatureListItem } from "../src/api/types.ts"

interface Timer {
  fn: () => void
  ms: number
  id: number
  cleared: boolean
}

/** Deterministic scheduler: run timers by hand. */
class FakeScheduler {
  timers: Timer[] = []
  private nextId = 1
  set = (fn: () => void, ms: number): unknown => {
    const timer: Timer = { fn, ms, id: this.nextId++, cleared: false }
    this.timers.push(timer)
    return timer
  }
  clear = (handle: unknown): void => {
    const t = handle as Timer
    t.cleared = true
  }
  /** Fire every pending timer once (not newly scheduled ones). */
  tick(): void {
    const batch = this.timers.splice(0)
    for (const t of batch) if (!t.cleared) t.fn()
  }
}

function listItem(id: string): FeatureListItem {
  return {
    id,
    title: id,
    slug: id,
    projectDir: `/proj/${id}`,
    workflow: "default",
    description: null,
    status: "running",
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    escalation: null,
    currentStep: "implement",
    createdAt: 1,
    updatedAt: 2,
    findingCounts: { new: 0, fixed: 0, dismissed: 0, reopened: 0 },
    jobs: { main: { status: "running", currentStep: "implement" } },
  }
}

function detailResponse(id: string): FeatureDetailResponse {
  return {
    feature: {
      ...listItem(id),
      workflowRef: { name: "default", stale: false },
      feedback: null,
      jobs: {
        main: {
          status: "running",
          currentStep: "implement",
          attempts: {},
          reruns: {},
          outputs: {},
          steps: { implement: { status: "running", outputs: {} } },
        },
      },
    },
    activeRun: null,
  }
}

function detailWithStatus(id: string, status: FeatureDetailResponse["feature"]["status"]): FeatureDetailResponse {
  const detail = detailResponse(id)
  return { ...detail, feature: { ...detail.feature, status } }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Call {
  path: string
}

function makeStack(handlers: Record<string, () => unknown | Promise<unknown>>): { client: ApiClient; calls: Call[]; unauthorized: number[] } {
  const calls: Call[] = []
  const unauthorized: number[] = []
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const path = String(url)
    calls.push({ path })
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) {
        const result = await handler()
        if (result instanceof Response) return Promise.resolve(result)
        return Promise.resolve(new Response(JSON.stringify(result), { status: 200 }))
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: "not_found", message: "no route", requestId: "r" } }), { status: 404 }),
    )
  }) as FetchLike
  const client = new ApiClient({
    token: () => null,
    onUnauthorized: () => unauthorized.push(1),
    fetch: fetchImpl,
  })
  return { client, calls, unauthorized }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe("invalidation store: coalescing", () => {
  it("a burst of invalidations for one feature triggers one refetch pass", async () => {
    const scheduler = new FakeScheduler()
    const { client, calls } = makeStack({
      "/v1/features/f-1": () => detailResponse("f-1"),
      "/v1/features": () => ({ features: [listItem("f-1")] }),
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({
      client,
      setTimeoutFn: scheduler.set,
      clearTimeoutFn: scheduler.clear,
    })
    store.setActiveFeature("f-1")

    // Simulate the burst arriving from the stream.
    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "transition", featureId: "f-1" })
    anyStore.queue({ kind: "run", featureId: "f-1" })
    anyStore.queue({ kind: "feature", featureId: "f-1" })

    calls.length = 0
    scheduler.tick() // fire the coalescing window once
    await settle()

    const detailCalls = calls.filter(c => c.path === "/v1/features/f-1").length
    const listCalls = calls.filter(c => c.path === "/v1/features").length
    expect(detailCalls).toBe(1)
    expect(listCalls).toBe(1)
  })

  it("kinds map to targeted refetches: finding refreshes findings for the on-screen feature", async () => {
    const scheduler = new FakeScheduler()
    const { client, calls } = makeStack({
      "/v1/features/f-1/findings": () => ({ findings: [] }),
      "/v1/features/f-1": () => detailResponse("f-1"),
      "/v1/features": () => ({ features: [] }),
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.setActiveFeature("f-1")

    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "finding", featureId: "f-1" })
    calls.length = 0
    scheduler.tick()
    await settle()

    expect(calls.some(c => c.path === "/v1/features/f-1/findings")).toBe(true)
    expect(calls.some(c => c.path === "/v1/features/f-1/runs")).toBe(false)
  })

  it("events for features not on screen only refresh the board list", async () => {
    const scheduler = new FakeScheduler()
    const { client, calls } = makeStack({
      "/v1/features/other": () => detailResponse("other"),
      "/v1/features": () => ({ features: [] }),
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.setActiveFeature("f-1")

    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "transition", featureId: "other" })
    calls.length = 0
    scheduler.tick()
    await settle()

    expect(calls.filter(c => c.path === "/v1/features").length).toBe(1)
    expect(calls.some(c => c.path === "/v1/features/other")).toBe(false)
  })
})

describe("invalidation store: own-command echo skip", () => {
  it("applies the command response directly and ignores the echo invalidation", async () => {
    const scheduler = new FakeScheduler()
    let approves = 0
    const { client, calls } = makeStack({
      "/v1/features/f-1/approve": () => {
        approves++
        return { result: "Approved", ...detailResponse("f-1") }
      },
      "/v1/features/f-1": () => detailResponse("f-1"),
      "/v1/features": () => ({ features: [listItem("f-1")] }),
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.setActiveFeature("f-1")

    await store.command("f-1", c => c.approve("f-1"))
    expect(approves).toBe(1)
    expect(store.getFeatureDetail("f-1").data?.feature.id).toBe("f-1")
    await settle()

    // The echo invalidation for the same feature arrives shortly after.
    calls.length = 0
    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "transition", featureId: "f-1" })
    scheduler.tick()
    await settle()

    // Echo suppressed: no detail/timeline refetch for f-1.
    expect(calls.some(c => c.path === "/v1/features/f-1")).toBe(false)
  })

  it("a multi-kind echo burst for one feature is fully suppressed", async () => {
    const scheduler = new FakeScheduler()
    const { client, calls } = makeStack({
      "/v1/features/f-1/approve": () => ({ result: "Approved", ...detailResponse("f-1") }),
      "/v1/features/f-1": () => detailResponse("f-1"),
      "/v1/features": () => ({ features: [listItem("f-1")] }),
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.setActiveFeature("f-1")
    await store.command("f-1", c => c.approve("f-1"))
    await settle()

    // An approve legitimately echoes as transition+run+feature in one
    // coalesce window — every kind must be swallowed, not just the first.
    calls.length = 0
    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "transition", featureId: "f-1" })
    anyStore.queue({ kind: "run", featureId: "f-1" })
    anyStore.queue({ kind: "feature", featureId: "f-1" })
    scheduler.tick()
    await settle()

    expect(calls.some(c => c.path === "/v1/features/f-1")).toBe(false)
    expect(calls.some(c => c.path === "/v1/features/f-1/runs")).toBe(true)
    expect(calls.some(c => c.path === "/v1/features")).toBe(false)
  })

  it("processes auxiliary invalidations during the echo window and defers covered reconciliation", async () => {
    const scheduler = new FakeScheduler()
    let nowValue = 1_000
    let runLogSignals = 0
    const { client, calls } = makeStack({
      "/v1/features/f-1/approve": () => ({ result: "Approved", ...detailResponse("f-1") }),
      "/v1/features/f-1/findings": () => ({ findings: [] }),
      "/v1/features/f-1/timeline": () => ({ transitions: [] }),
      "/v1/features/f-1/runs": () => ({ runs: [] }),
      "/v1/features/f-1": () => detailResponse("f-1"),
      "/v1/features": () => ({ features: [listItem("f-1")] }),
      "/v1/health": () => ({ alive: true }),
    })
    const store = new DataSource({
      client,
      setTimeoutFn: scheduler.set,
      clearTimeoutFn: scheduler.clear,
      now: () => nowValue,
    })
    store.setActiveFeature("f-1")
    store.subscribeRunLog("f-1", () => runLogSignals++)
    await store.command("f-1", c => c.approve("f-1"))
    await settle()
    calls.length = 0

    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "feature", featureId: "f-1" })
    anyStore.queue({ kind: "transition", featureId: "f-1" })
    anyStore.queue({ kind: "run", featureId: "f-1" })
    anyStore.queue({ kind: "finding", featureId: "f-1" })
    anyStore.queue({ kind: "run_log", featureId: "f-1" })
    scheduler.tick()
    await settle()

    expect(calls.some(c => c.path === "/v1/features/f-1/findings")).toBe(true)
    expect(calls.some(c => c.path === "/v1/features/f-1/timeline")).toBe(true)
    expect(calls.some(c => c.path === "/v1/features/f-1/runs")).toBe(true)
    expect(runLogSignals).toBe(1)
    expect(calls.some(c => c.path === "/v1/features/f-1")).toBe(false)
    const listCallsBeforeRelease = calls.filter(c => c.path === "/v1/features").length
    expect(listCallsBeforeRelease).toBe(1)

    nowValue += 2_000
    scheduler.tick()
    await settle()
    expect(calls.some(c => c.path === "/v1/features/f-1")).toBe(true)
    expect(calls.filter(c => c.path === "/v1/features").length).toBeGreaterThan(listCallsBeforeRelease)
  })

  it("an older detail GET cannot overwrite a direct command response", async () => {
    const stale = deferred<FeatureDetailResponse>()
    const { client } = makeStack({
      "/v1/features/f-1/approve": () => ({ result: "Approved", ...detailWithStatus("f-1", "running") }),
      "/v1/features/f-1": () => stale.promise,
      "/v1/features": () => ({ features: [listItem("f-1")] }),
    })
    const store = new DataSource({ client })
    store.ensureFeatureDetailLoaded("f-1")

    await store.command("f-1", c => c.approve("f-1"))
    stale.resolve(detailWithStatus("f-1", "waiting_human"))
    await settle()

    expect(store.getFeatureDetail("f-1").data?.feature.status).toBe("running")
  })

  it("serializes commands for the same feature", async () => {
    const first = deferred<unknown>()
    let secondStarted = false
    const { client } = makeStack({
      "/v1/features/f-1/pause": () => first.promise,
      "/v1/features/f-1/resume": () => {
        secondStarted = true
        return { result: "Resumed", ...detailWithStatus("f-1", "running") }
      },
      "/v1/features": () => ({ features: [listItem("f-1")] }),
    })
    const store = new DataSource({ client })

    const pause = store.command("f-1", c => c.pause("f-1"))
    const resume = store.command("f-1", c => c.resume("f-1"))
    await settle()
    expect(secondStarted).toBe(false)

    first.resolve({ result: "Paused", ...detailWithStatus("f-1", "paused") })
    await pause
    await resume
    expect(secondStarted).toBe(true)
    expect(store.getFeatureDetail("f-1").data?.feature.status).toBe("running")
  })

  it("a second, non-echo invalidation after the window does refetch", async () => {
    const scheduler = new FakeScheduler()
    let nowValue = 1_000
    const { client, calls } = makeStack({
      "/v1/features/f-1/approve": () => ({ result: "Approved", ...detailResponse("f-1") }),
      "/v1/features/f-1": () => detailResponse("f-1"),
      "/v1/features": () => ({ features: [] }),
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({
      client,
      setTimeoutFn: scheduler.set,
      clearTimeoutFn: scheduler.clear,
      now: () => nowValue,
    })
    store.setActiveFeature("f-1")
    await store.command("f-1", c => c.approve("f-1"))
    await settle()

    nowValue += 10_000 // well past the echo window
    calls.length = 0
    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "transition", featureId: "f-1" })
    scheduler.tick()
    await settle()

    expect(calls.some(c => c.path === "/v1/features/f-1")).toBe(true)
  })
})

describe("ApiClient: answerRun", () => {
  it("resolves the exact {result, run} shape the server sends — never a CommandResponse", async () => {
    const { client } = makeStack({
      "/v1/runs/run-1/answer": () => ({
        result: "Answer delivered to step \"explore\". Feature is now: running.",
        run: { id: "run-1", featureId: "f-1", jobId: "explore", stepId: "investigate", stepType: "agent", attempt: 1, status: "running", sessionId: "ses-1", outputs: {}, reason: null, nudges: 0, pendingQuestion: null, timeStarted: 1, timeFinished: null },
      }),
    })
    const response = await client.answerRun("run-1", "Q: Storage?\nA: SQLite")
    expect(response.result).toContain("Answer delivered")
    expect(response.run?.id).toBe("run-1")
    expect((response as unknown as { feature?: unknown }).feature).toBeUndefined()
    expect((response as unknown as { activeRun?: unknown }).activeRun).toBeUndefined()
  })

  it("sends the notes body and surfaces a 409 as ApiError", async () => {
    const { client } = makeStack({
      "/v1/runs/run-1/answer": () =>
        new Response(JSON.stringify({ error: { code: "no_pending_question", message: "no pending question", requestId: "r-1" } }), {
          status: 409,
        }),
    })
    await expect(client.answerRun("run-1", "late answer")).rejects.toBeInstanceOf(ApiError)
  })
})

describe("invalidation store: answerRun contract", () => {
  it("never applies the answer payload as feature detail and awaits detail, runs, and list reconciliation", async () => {
    const scheduler = new FakeScheduler()
    const detailLoad = deferred<FeatureDetailResponse>()
    const runsLoad = deferred<{ runs: never[] }>()
    const listLoad = deferred<{ features: FeatureListItem[] }>()
    const { client, calls } = makeStack({
      "/v1/runs/run-1/answer": () => ({ result: "Answer delivered to step \"explore\". Feature is now: running.", run: null }),
      "/v1/features/f-1/runs": () => runsLoad.promise,
      "/v1/features/f-1": () => detailLoad.promise,
      "/v1/features": () => listLoad.promise,
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.setActiveFeature("f-1")

    const detailBefore = store.getFeatureDetail("f-1")
    let resolved = false
    const answer = store.answerRun("f-1", c => c.answerRun("run-1", "Q: Storage?\nA: SQLite")).then(response => {
      resolved = true
      return response
    })
    await settle()
    expect(resolved).toBe(false)
    detailLoad.resolve(detailResponse("f-1"))
    runsLoad.resolve({ runs: [] })
    await settle()
    expect(resolved).toBe(false)
    listLoad.resolve({ features: [listItem("f-1")] })
    const response = await answer

    // The response has no `feature`/`activeRun` — applying it as detail
    // would blow up or silently corrupt the resource; instead a real
    // detail/runs refetch is triggered.
    expect(response).toEqual({ result: "Answer delivered to step \"explore\". Feature is now: running.", run: null })
    expect(calls.some(c => c.path === "/v1/features/f-1")).toBe(true)
    expect(calls.some(c => c.path === "/v1/features/f-1/runs")).toBe(true)
    // The detail resource, once the refetch settles, is a genuine
    // feature-detail shape (not the answer payload).
    const detailAfter = store.getFeatureDetail("f-1")
    expect(detailAfter.data?.feature.id).toBe("f-1")
    expect(detailAfter.version).toBeGreaterThan(detailBefore.version)
  })

  it("defers covered answer echoes while still refreshing runs immediately", async () => {
    const scheduler = new FakeScheduler()
    const { client, calls } = makeStack({
      "/v1/runs/run-1/answer": () => ({ result: "ok", run: null }),
      "/v1/features/f-1/runs": () => ({ runs: [] }),
      "/v1/features/f-1": () => detailResponse("f-1"),
      "/v1/features": () => ({ features: [listItem("f-1")] }),
      "/v1/health": () => ({ alive: true, ready: true, phase: "ready", database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 }, heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 }, projects: [], runner: "available" }),
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.setActiveFeature("f-1")

    await store.answerRun("f-1", c => c.answerRun("run-1", "answer text"))
    await settle()

    calls.length = 0
    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "transition", featureId: "f-1" })
    anyStore.queue({ kind: "run", featureId: "f-1" })
    anyStore.queue({ kind: "feature", featureId: "f-1" })
    scheduler.tick()
    await settle()

    expect(calls.some(c => c.path === "/v1/features/f-1")).toBe(false)
    expect(calls.some(c => c.path === "/v1/features/f-1/runs")).toBe(true)
    expect(calls.some(c => c.path === "/v1/features")).toBe(false)
  })

  it("rejects with the typed ApiError on failure and never touches the detail resource", async () => {
    const { client } = makeStack({
      "/v1/runs/run-1/answer": () =>
        new Response(JSON.stringify({ error: { code: "no_pending_question", message: "no pending question", requestId: "r-1" } }), {
          status: 409,
        }),
    })
    const store = new DataSource({ client })
    const before = store.getFeatureDetail("f-1")

    await expect(store.answerRun("f-1", c => c.answerRun("run-1", "too late"))).rejects.toBeInstanceOf(ApiError)
    expect(store.getFeatureDetail("f-1")).toBe(before)
  })
})

describe("invalidation store: error handling", () => {
  it("maps the error envelope onto the resource state", async () => {
    const { client } = makeStack({
      "/v1/features": () =>
        new Response(JSON.stringify({ error: { code: "internal", message: "boom", requestId: "req-9" } }), { status: 500 }),
    })
    const scheduler = new FakeScheduler()
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.ensureFeaturesLoaded()
    for (let i = 0; i < 4; i++) {
      await settle()
      scheduler.tick()
    }
    await settle()
    const state = store.getFeatures()
    expect(state.status).toBe("error")
    expect(state.error).toBeInstanceOf(ApiError)
    expect(state.error?.code).toBe("internal")
    expect(state.error?.requestId).toBe("req-9")
  })

  it("fires onUnauthorized when a resource load returns 401", async () => {
    const { client, unauthorized } = makeStack({
      "/v1/features": () =>
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "no", requestId: "r" } }), { status: 401 }),
    })
    const store = new DataSource({ client })
    store.ensureFeaturesLoaded()
    await settle()
    expect(unauthorized.length).toBe(1)
  })
})

describe("invalidation store: ensure is load-once", () => {
  it("repeated ensure calls after settle do not refetch (render loop guard)", async () => {
    const { client, calls } = makeStack({
      "/v1/features": () => ({ features: [listItem("f-1")] }),
      "/v1/health": () => ({ status: "ok" }),
    })
    const store = new DataSource({ client })
    store.ensureFeaturesLoaded()
    store.ensureHealthLoaded()
    await settle()
    for (let i = 0; i < 50; i++) {
      store.ensureFeaturesLoaded()
      store.ensureHealthLoaded()
    }
    await settle()
    expect(calls.filter(c => c.path.startsWith("/v1/features")).length).toBe(1)
    expect(calls.filter(c => c.path.startsWith("/v1/health")).length).toBe(1)
  })

  it("ensure after a settled error does not hot-loop the fetch", async () => {
    const { client, calls } = makeStack({
      "/v1/features": () =>
        new Response(JSON.stringify({ error: { code: "internal", message: "boom", requestId: "r" } }), { status: 500 }),
    })
    const scheduler = new FakeScheduler()
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.ensureFeaturesLoaded()
    for (let i = 0; i < 4; i++) {
      await settle()
      scheduler.tick()
    }
    await settle()
    const afterRetries = calls.filter(c => c.path.startsWith("/v1/features")).length
    expect(store.getFeatures().status).toBe("error")
    store.ensureFeaturesLoaded()
    store.ensureFeaturesLoaded()
    await settle()
    expect(calls.filter(c => c.path.startsWith("/v1/features")).length).toBe(afterRetries)
  })

  it("a transient failure on the initial load is retried to success", async () => {
    let attempts = 0
    const { client, calls } = makeStack({
      "/v1/features": () => {
        attempts += 1
        if (attempts === 1)
          return new Response(JSON.stringify({ error: { code: "internal", message: "blip", requestId: "r" } }), { status: 500 })
        return { features: [listItem("f-1")] }
      },
    })
    const scheduler = new FakeScheduler()
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.ensureFeaturesLoaded()
    await settle()
    expect(store.getFeatures().status).toBe("loading")
    scheduler.tick()
    await settle()
    expect(store.getFeatures().status).toBe("ready")
    expect(calls.filter(c => c.path.startsWith("/v1/features")).length).toBe(2)
  })

  it("a 401 fails immediately without retrying", async () => {
    const { client, calls, unauthorized } = makeStack({
      "/v1/features": () =>
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "no", requestId: "r" } }), { status: 401 }),
    })
    const scheduler = new FakeScheduler()
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.ensureFeaturesLoaded()
    await settle()
    expect(store.getFeatures().status).toBe("error")
    expect(unauthorized.length).toBe(1)
    expect(calls.filter(c => c.path.startsWith("/v1/features")).length).toBe(1)
    expect(scheduler.timers.length).toBe(0)
  })

  it("forced refresh still refetches a settled resource", async () => {
    const { client, calls } = makeStack({
      "/v1/health": () => ({ status: "ok" }),
    })
    const store = new DataSource({ client })
    store.ensureHealthLoaded()
    await settle()
    store.refreshHealth()
    await settle()
    expect(calls.filter(c => c.path.startsWith("/v1/health")).length).toBe(2)
  })

  it("forced reads use monotonic epochs and reject an ABA completion", async () => {
    const first = deferred<FeatureDetailResponse>()
    const second = deferred<FeatureDetailResponse>()
    let reads = 0
    const { client } = makeStack({
      "/v1/features/f-1": () => (++reads === 1 ? first.promise : second.promise),
    })
    const store = new DataSource({ client })

    store.refetchFeatureDetail("f-1")
    store.refetchFeatureDetail("f-1")
    second.resolve(detailWithStatus("f-1", "running"))
    await settle()
    first.resolve(detailWithStatus("f-1", "waiting_human"))
    await settle()

    expect(store.getFeatureDetail("f-1").data?.feature.status).toBe("running")
  })
})

describe("invalidation store: retry timers are cancelled by stop()", () => {
  it("stop() clears a pending load retry so it never fires", async () => {
    const { client, calls } = makeStack({
      "/v1/features": () =>
        new Response(JSON.stringify({ error: { code: "internal", message: "blip", requestId: "r" } }), { status: 500 }),
    })
    const scheduler = new FakeScheduler()
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.ensureFeaturesLoaded()
    await settle()
    expect(scheduler.timers.some(t => !t.cleared)).toBe(true)
    store.stop()
    expect(scheduler.timers.every(t => t.cleared)).toBe(true)
    scheduler.tick()
    await settle()
    expect(calls.filter(c => c.path.startsWith("/v1/features")).length).toBe(1)
  })
})

describe("invalidation store: snapshot stability", () => {
  it("the not-yet-loaded snapshot is one stable reference across getters and calls", () => {
    const { client } = makeStack({})
    const store = new DataSource({ client, setTimeoutFn: () => 0, clearTimeoutFn: () => {} })

    // useSyncExternalStore compares snapshots by reference on EVERY
    // render: a fresh `{status:"loading"}` literal per call is an
    // infinite re-render loop (and a blank page) for any component that
    // reads a resource before it loads.
    expect(store.getFeatureDetail("nope")).toBe(store.getFeatureDetail("nope"))
    expect(store.getRuns("nope")).toBe(store.getRuns("nope"))
    expect(store.getFindings("nope")).toBe(store.getFindings("nope"))
    expect(store.getTimeline("nope")).toBe(store.getTimeline("nope"))
    expect(store.getWorkflow("/some/dir")).toBe(store.getWorkflow("/other/dir"))
    expect(store.getFeatureDetail("a") as unknown).toBe(store.getRuns("b") as unknown)
  })
})
