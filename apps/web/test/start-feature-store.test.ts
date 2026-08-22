/**
 * `DataSource.startFeature` — non-optimistic, authoritative creation.
 * Covers design.md "Treat creation as a dedicated authoritative store
 * mutation": authority bump against older in-flight loads and early SSE
 * invalidations, echo suppression, list upsert, and best-effort refresh
 * that never turns a successful creation into a failure.
 */
import { describe, expect, it } from "bun:test"
import { ApiClient, ApiError, type FetchLike } from "../src/api/client.ts"
import { DataSource } from "../src/api/store.ts"
import type { FeatureDetailResponse, FeatureListItem, StartFeatureRequest } from "../src/api/types.ts"

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

interface Timer {
  fn: () => void
  ms: number
  id: number
  cleared: boolean
}

/** Deterministic scheduler: run timers by hand (mirrors store.test.ts). */
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
  tick(): void {
    const batch = this.timers.splice(0)
    for (const t of batch) if (!t.cleared) t.fn()
  }
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
  method: string
}

function makeStack(handlers: Record<string, (call: Call) => unknown | Promise<unknown>>): {
  client: ApiClient
  calls: Call[]
  unauthorized: number[]
} {
  const calls: Call[] = []
  const unauthorized: number[] = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    const method = init?.method ?? "GET"
    const call = { path, method }
    calls.push(call)
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) {
        const result = await handler(call)
        if (result instanceof Response) return Promise.resolve(result)
        return Promise.resolve(new Response(JSON.stringify(result), { status: 200 }))
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: "not_found", message: "no route", requestId: "r" } }), { status: 404 }),
    )
  }) as FetchLike
  const client = new ApiClient({ token: () => null, onUnauthorized: () => unauthorized.push(1), fetch: fetchImpl })
  return { client, calls, unauthorized }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const request: StartFeatureRequest = { title: "Add dark mode", project: "/proj/new-1" }

describe("DataSource.startFeature", () => {
  it("posts to /v1/features and applies the returned detail as authoritative", async () => {
    const { client, calls } = makeStack({
      "/v1/features": call => (call.method === "POST" ? { ...detailResponse("new-1") } : { features: [] }),
    })
    const store = new DataSource({ client })
    const payload = await store.startFeature(request)
    expect(payload.feature.id).toBe("new-1")
    expect(store.getFeatureDetail("new-1").data).toEqual(payload)
    expect(store.getFeatureDetail("new-1").status).toBe("ready")
    expect(calls.some(c => c.path === "/v1/features" && c.method === "POST")).toBe(true)
  })

  it("upserts the new feature into an already-loaded list before the follow-up refresh resolves", async () => {
    const listGet = deferred<{ features: FeatureListItem[] }>()
    let listGets = 0
    const { client } = makeStack({
      "/v1/features": call => {
        if (call.method === "POST") return { ...detailResponse("new-1") }
        listGets++
        return listGets === 1 ? { features: [listItem("existing")] } : listGet.promise
      },
    })
    const store = new DataSource({ client })
    store.ensureFeaturesLoaded()
    await settle()
    expect(store.getFeatures().data?.map(f => f.id)).toEqual(["existing"])

    const startPromise = store.startFeature(request)
    await startPromise
    // Upsert happens synchronously with the response, before the
    // best-effort refresh (still in flight) resolves.
    const ids = store.getFeatures().data?.map(f => f.id) ?? []
    expect(ids).toContain("new-1")
    expect(ids).toContain("existing")

    listGet.resolve({ features: [listItem("existing"), listItem("new-1")] })
    await settle()
  })

  it("arms echo suppression for the new feature id", async () => {
    const scheduler = new FakeScheduler()
    const { client, calls } = makeStack({
      "/v1/features": call => (call.method === "POST" ? { ...detailResponse("new-1") } : { features: [] }),
      "/v1/features/new-1": () => detailResponse("new-1"),
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    await store.startFeature(request)
    calls.length = 0
    // A `transition`/`feature` invalidation for the new id right after
    // creation must be treated as an echo, not trigger an immediate
    // extra detail refetch.
    store.setActiveFeature("new-1")
    const anyStore = store as unknown as { queue(change: { kind: string; featureId: string }): void }
    anyStore.queue({ kind: "feature", featureId: "new-1" })
    scheduler.tick()
    await settle()
    expect(calls.some(c => c.path === "/v1/features/new-1")).toBe(false)
  })

  it("guards against an older in-flight features GET landing after a successful start", async () => {
    const staleList = deferred<{ features: FeatureListItem[] }>()
    let listCallCount = 0
    const { client } = makeStack({
      "/v1/features": call => {
        if (call.method === "POST") return { ...detailResponse("new-1") }
        listCallCount++
        // First GET (issued before startFeature) hangs; startFeature's
        // own best-effort refresh is the second call.
        return listCallCount === 1 ? staleList.promise : { features: [listItem("new-1")] }
      },
    })
    const store = new DataSource({ client })
    store.ensureFeaturesLoaded()
    await settle()

    await store.startFeature(request)
    await settle()
    // The stale first GET resolves last, with an outdated (empty) list —
    // its epoch was invalidated by startFeature's authority bump, so it
    // must not overwrite the authoritative post-create list state.
    staleList.resolve({ features: [] })
    await settle()
    expect(store.getFeatures().data?.some(f => f.id === "new-1")).toBe(true)
  })

  it("guards the new detail resource against an early SSE-triggered refetch racing the POST response", async () => {
    const post = deferred<FeatureDetailResponse>()
    const earlyDetailGet = deferred<FeatureDetailResponse>()
    let detailGetCount = 0
    const { client } = makeStack({
      "/v1/features/new-1": () => {
        detailGetCount++
        return earlyDetailGet.promise
      },
      "/v1/features": call => (call.method === "POST" ? post.promise : { features: [] }),
    })
    const store = new DataSource({ client })

    // Simulate an SSE invalidation for the not-yet-created feature id
    // arriving before the POST resolves (the daemon dispatches
    // feature.start before responding) — an operator could only trigger
    // this by knowing the id in advance, but the guard must hold
    // regardless: a refetch started for the same key before startFeature
    // applies its response must not be authoritative afterward.
    store.refetchFeatureDetail("new-1")
    await settle()
    expect(detailGetCount).toBe(1)

    post.resolve(detailResponse("new-1"))
    const payload = await store.startFeature(request)
    expect(store.getFeatureDetail("new-1").data).toEqual(payload)

    // The early GET now resolves with different (stale) data — must not
    // clobber the authoritative response already applied.
    earlyDetailGet.resolve({ ...detailResponse("new-1"), feature: { ...detailResponse("new-1").feature, status: "paused" } })
    await settle()
    expect(store.getFeatureDetail("new-1").data?.feature.status).toBe("running")
  })

  it("a failed post-create list refresh does not turn a successful creation into a failure", async () => {
    let listGets = 0
    const { client } = makeStack({
      "/v1/features": call => {
        if (call.method === "POST") return { ...detailResponse("new-1") }
        listGets++
        if (listGets === 1) return { features: [] }
        return new Response(JSON.stringify({ error: { code: "internal", message: "boom", requestId: "r" } }), { status: 500 })
      },
    })
    const store = new DataSource({ client })
    store.ensureFeaturesLoaded()
    await settle()

    const payload = await store.startFeature(request)
    expect(payload.feature.id).toBe("new-1")
    await settle()
    // Creation succeeded and the upsert still holds even though the
    // background refresh failed.
    expect(store.getFeatureDetail("new-1").status).toBe("ready")
    expect(store.getFeatures().data?.some(f => f.id === "new-1")).toBe(true)
  })

  it("rejects with the typed ApiError on a validation/server failure and mutates no cache", async () => {
    const { client } = makeStack({
      "/v1/features": call =>
        call.method === "POST"
          ? new Response(
              JSON.stringify({
                error: { code: "invalid_input", message: 'input "feature" is required', requestId: "r-1" },
                diagnostics: [{ name: "feature", kind: "missing_required", message: 'input "feature" is required (type: string)' }],
              }),
              { status: 422 },
            )
          : { features: [] },
    })
    const store = new DataSource({ client })
    const before = store.getFeatureDetail("new-1")
    await expect(store.startFeature(request)).rejects.toBeInstanceOf(ApiError)
    expect(store.getFeatureDetail("new-1")).toBe(before)
    try {
      await store.startFeature(request)
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).diagnostics?.[0]?.kind).toBe("missing_required")
    }
  })

  it("fires onUnauthorized on a 401 from the create request", async () => {
    const { client, unauthorized } = makeStack({
      "/v1/features": call =>
        call.method === "POST"
          ? new Response(JSON.stringify({ error: { code: "unauthorized", message: "no", requestId: "r" } }), { status: 401 })
          : { features: [] },
    })
    const store = new DataSource({ client })
    await expect(store.startFeature(request)).rejects.toBeInstanceOf(ApiError)
    expect(unauthorized.length).toBe(1)
  })
})
