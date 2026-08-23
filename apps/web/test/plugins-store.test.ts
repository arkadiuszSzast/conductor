/**
 * Plugin listing store wiring — `GET /v1/plugins?project=` loading,
 * and refetch on the plugin subsystem's own SSE `{kind:"plugins"}`
 * invalidation (task 5.4), which carries no `featureId` unlike every
 * other `ChangeEvent` kind.
 */
import { describe, expect, it } from "bun:test"
import { ApiClient, type FetchLike } from "../src/api/client.ts"
import { DataSource } from "../src/api/store.ts"
import type { PluginListingResponse } from "../src/api/types.ts"

interface Timer {
  fn: () => void
  ms: number
  id: number
  cleared: boolean
}

class FakeScheduler {
  timers: Timer[] = []
  private nextId = 1
  set = (fn: () => void, ms: number): unknown => {
    const timer: Timer = { fn, ms, id: this.nextId++, cleared: false }
    this.timers.push(timer)
    return timer
  }
  clear = (handle: unknown): void => {
    ;(handle as Timer).cleared = true
  }
  tick(): void {
    const batch = this.timers.splice(0)
    for (const t of batch) if (!t.cleared) t.fn()
  }
}

function listingResponse(ids: readonly string[]): PluginListingResponse {
  return {
    enabled: true,
    plugins: ids.map(id => ({ id, scope: "global", panel: { title: id }, state: "running", diagnostics: [] })),
    diagnostics: [],
  }
}

interface Call {
  path: string
}

function makeStack(handlers: Record<string, () => unknown>): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const path = String(url)
    calls.push({ path })
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) return new Response(JSON.stringify(handler()), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "no route", requestId: "r" } }), { status: 404 })
  }) as FetchLike
  const client = new ApiClient({ token: () => null, fetch: fetchImpl })
  return { client, calls }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const HEALTH = {
  alive: true,
  ready: true,
  phase: "ready",
  database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 },
  heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 },
  projects: [],
  runner: "available",
}

describe("DataSource: plugin listing", () => {
  it("loads the listing scoped by project via ensurePluginsLoaded", async () => {
    const { client, calls } = makeStack({
      "/v1/plugins": () => listingResponse(["openspec"]),
      "/v1/health": () => HEALTH,
    })
    const store = new DataSource({ client })
    store.ensurePluginsLoaded("/proj/a")
    await settle()

    expect(calls.some(c => c.path === "/v1/plugins?project=%2Fproj%2Fa")).toBe(true)
    expect(store.getPlugins("/proj/a").data?.plugins.map(p => p.id)).toEqual(["openspec"])
  })

  it("omits the project query param for the global-only (no scope) listing", async () => {
    const { client, calls } = makeStack({
      "/v1/plugins": () => listingResponse(["global-only"]),
      "/v1/health": () => HEALTH,
    })
    const store = new DataSource({ client })
    store.ensurePluginsLoaded("")
    await settle()

    expect(calls.some(c => c.path === "/v1/plugins")).toBe(true)
    expect(calls.some(c => c.path.includes("project="))).toBe(false)
  })

  it("a `plugins` SSE invalidation refetches every scope the rail has loaded", async () => {
    const scheduler = new FakeScheduler()
    let version = 0
    const { client, calls } = makeStack({
      "/v1/plugins": () => listingResponse(version === 0 ? ["openspec"] : ["openspec", "new-plugin"]),
      "/v1/health": () => HEALTH,
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })
    store.ensurePluginsLoaded("/proj/a")
    await settle()
    expect(store.getPlugins("/proj/a").data?.plugins).toHaveLength(1)

    version = 1
    calls.length = 0
    const anyStore = store as unknown as { queue(change: { kind: string }): void }
    anyStore.queue({ kind: "plugins" })
    scheduler.tick()
    await settle()

    expect(calls.some(c => c.path.startsWith("/v1/plugins"))).toBe(true)
    expect(store.getPlugins("/proj/a").data?.plugins).toHaveLength(2)
  })

  it("does not refetch a scope the rail has never loaded", async () => {
    const scheduler = new FakeScheduler()
    const { client, calls } = makeStack({
      "/v1/plugins": () => listingResponse(["openspec"]),
      "/v1/health": () => HEALTH,
    })
    const store = new DataSource({ client, setTimeoutFn: scheduler.set, clearTimeoutFn: scheduler.clear })

    const anyStore = store as unknown as { queue(change: { kind: string }): void }
    anyStore.queue({ kind: "plugins" })
    scheduler.tick()
    await settle()

    expect(calls.some(c => c.path.startsWith("/v1/plugins"))).toBe(false)
  })

  it("re-exchanges the plugin session on a 401 from the plugin listing", async () => {
    let sessionExchanges = 0
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const path = String(url)
      if (path === "/v1/plugins/session") {
        sessionExchanges++
        return new Response(null, { status: 204 })
      }
      if (path.startsWith("/v1/plugins")) {
        return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no", requestId: "r" } }), { status: 401 })
      }
      if (path.startsWith("/v1/health")) return new Response(JSON.stringify(HEALTH), { status: 200 })
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no route", requestId: "r" } }), { status: 404 })
    }) as FetchLike
    const client = new ApiClient({ token: () => "tok", fetch: fetchImpl })
    const store = new DataSource({ client })
    store.ensurePluginsLoaded("/proj/a")
    await settle()

    expect(store.getPlugins("/proj/a").status).toBe("error")
    expect(sessionExchanges).toBe(1)
  })

  it("refetchPlugins force-reloads even when a resource already settled", async () => {
    let calls = 0
    const { client } = makeStack({
      "/v1/plugins": () => {
        calls++
        return listingResponse(["openspec"])
      },
      "/v1/health": () => HEALTH,
    })
    const store = new DataSource({ client })
    store.ensurePluginsLoaded("/proj/a")
    await settle()
    expect(calls).toBe(1)

    await store.refetchPlugins("/proj/a")
    expect(calls).toBe(2)
  })
})
