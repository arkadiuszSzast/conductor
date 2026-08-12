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

interface Call {
  path: string
}

function makeStack(handlers: Record<string, () => unknown>): { client: ApiClient; calls: Call[]; unauthorized: number[] } {
  const calls: Call[] = []
  const unauthorized: number[] = []
  const fetchImpl = ((url: RequestInfo | URL) => {
    const path = String(url)
    calls.push({ path })
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) {
        const result = handler()
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
    expect(calls.some(c => c.path === "/v1/features/f-1/runs")).toBe(false)
    expect(calls.some(c => c.path === "/v1/features")).toBe(false)
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
