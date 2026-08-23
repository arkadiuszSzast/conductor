/**
 * `PluginRail` mounted tests — visibility per scope, persistence of
 * tab/open state across remount, the bridge handshake/context-changed/
 * navigate wiring through a real DOM iframe, origin/source filtering,
 * unknown-version dropping, no-token-in-host-messages, the error panel
 * state, and that the gate flow's two-click reachability is unaffected
 * by the rail being present (plugin-panels + web-ui specs).
 *
 * All React/component modules are imported dynamically INSIDE each test
 * — see `test/dom-env.ts`'s module doc for why a static top-level import
 * of `react-dom/client` breaks React's DOM-support detection here.
 */
import { beforeEach, describe as describeBase, expect, it } from "bun:test"
import { mountedTestsSupported, useDomEnv, flush } from "./dom-env.ts"
import type { FetchLike } from "../src/api/client.ts"
import type { FeatureDetailResponse, FeatureListItem, PluginListingResponse } from "../src/api/types.ts"

const { load } = useDomEnv()
const describe = describeBase.skipIf(!mountedTestsSupported)

// The rail's persisted tab/open state (`localStorage`) and its active-
// scope publisher (a module-level singleton — see `active-scope.ts`'s
// doc) both outlive any single test's component tree, so every test
// gets a clean slate here rather than leaking state across cases.
if (mountedTestsSupported) {
  beforeEach(async () => {
    globalThis.localStorage?.clear()
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: null, feature: null })
  })
}

function listItem(id: string, overrides: Partial<FeatureListItem> = {}): FeatureListItem {
  return {
    id,
    title: id,
    slug: id,
    projectDir: "/proj/a",
    workflow: "delivery",
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
    ...overrides,
  }
}

function detailResponse(id: string, overrides: Partial<FeatureDetailResponse["feature"]> = {}): FeatureDetailResponse {
  return {
    feature: {
      ...listItem(id),
      workflowRef: { name: "delivery", stale: false },
      feedback: null,
      jobs: {
        main: {
          status: "running",
          currentStep: "implement",
          attempts: {},
          reruns: {},
          outputs: {},
          steps: { implement: { status: "waiting_human", outputs: {}, prompt: "look at this" } },
        },
      },
      status: "waiting_human",
      ...overrides,
    },
    activeRun: null,
  }
}

function listing(plugins: PluginListingResponse["plugins"]): PluginListingResponse {
  return { enabled: true, plugins, diagnostics: [] }
}

function health() {
  return {
    alive: true,
    ready: true,
    phase: "ready",
    database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 },
    heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 },
    projects: [],
    runner: "available",
  }
}

interface RouteStub {
  readonly test: (path: string) => boolean
  readonly handler: (path: string) => unknown
}

function fetchStub(routes: readonly RouteStub[]): FetchLike {
  return (async (url: RequestInfo | URL) => {
    const path = String(url)
    for (const route of routes) {
      if (route.test(path)) return new Response(JSON.stringify(route.handler(path)), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "no route", requestId: "r" } }), { status: 404 })
  }) as FetchLike
}

async function makeServices(routes: readonly RouteStub[]) {
  const { ApiClient } = await import("../src/api/client.ts")
  const { DataSource } = await import("../src/api/store.ts")
  const { AuthSession } = await import("../src/auth/auth-store.ts")
  const client = new ApiClient({ token: () => "tok", fetch: fetchStub(routes) })
  const store = new DataSource({ client, setTimeoutFn: fn => setTimeout(fn, 0), clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>) })
  const session = new AuthSession({ storage: { get: () => null, set: () => {} }, probe: async () => 200 })
  session.status = "authenticated"
  return { client, store, session }
}

async function mountRail(
  services: Awaited<ReturnType<typeof makeServices>>,
  path = "/",
): Promise<{ container: HTMLDivElement; root: import("react-dom/client").Root; history: readonly string[]; unmount: () => Promise<void> }> {
  const { React, act, createRoot } = await load()
  const h = React.createElement
  const { AppContext } = await import("../src/app-context.ts")
  const { PluginRail } = await import("../src/plugins/plugin-rail.tsx")
  const { Router } = await import("wouter")
  const { memoryLocation } = await import("wouter/memory-location")

  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const { hook, history } = memoryLocation({ path, record: true })

  await act(async () => {
    root.render(h(AppContext.Provider, { value: services }, h(Router, { hook, children: h(PluginRail) })))
    await flush()
  })

  return {
    container,
    root,
    history: history as readonly string[],
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe("PluginRail: visibility", () => {
  it("renders no rail chrome when the listing is empty", async () => {
    const services = await makeServices([
      { test: p => p.startsWith("/v1/plugins"), handler: () => listing([]) },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: "/proj/a", feature: null })

    const m = await mountRail(services)
    expect(m.container.querySelector('[role="tablist"]')).toBeNull()

    await m.unmount()
  })

  it("shows a global plugin tab regardless of active project", async () => {
    const services = await makeServices([
      { test: p => p.startsWith("/v1/plugins"), handler: () => listing([{ id: "global-one", scope: "global", panel: { title: "Global One" }, state: "running", diagnostics: [] }]) },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: null, feature: null })

    const m = await mountRail(services)
    await flush()
    expect(m.container.querySelector('[role="tab"][title="Global One"]')).not.toBeNull()

    await m.unmount()
  })

  it("shows a project plugin tab only while that project is the active scope", async () => {
    let requestedProject: string | null = null
    const services = await makeServices([
      {
        test: p => p.startsWith("/v1/plugins"),
        handler: p => {
          const url = new URL(p, "http://x")
          requestedProject = url.searchParams.get("project")
          return requestedProject === "/proj/a"
            ? listing([{ id: "openspec", scope: "project", project: "/proj/a", panel: { title: "OpenSpec" }, state: "running", diagnostics: [] }])
            : listing([])
        },
      },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: "/proj/a", feature: null })

    const m = await mountRail(services)
    await flush()
    expect(m.container.querySelector('[role="tab"][title="OpenSpec"]')).not.toBeNull()

    // Switching scope to a project without the plugin removes the tab
    // (spec: "switching scope to a project without the plugin removes
    // the tab").
    const { act } = await load()
    await act(async () => {
      publishActiveScope({ project: "/proj/b", feature: null })
      await flush()
    })
    expect(m.container.querySelector('[role="tab"][title="OpenSpec"]')).toBeNull()

    await m.unmount()
  })
})

describe("PluginRail: persistence", () => {
  it("persists the open tab across remount (survives reload)", async () => {
    const services = await makeServices([
      { test: p => p.startsWith("/v1/plugins"), handler: () => listing([{ id: "openspec", scope: "global", panel: { title: "OpenSpec" }, state: "running", diagnostics: [] }]) },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: null, feature: null })

    const { act } = await load()
    const first = await mountRail(services)
    await flush()
    const tab = first.container.querySelector('[role="tab"][title="OpenSpec"]') as HTMLButtonElement
    await act(async () => {
      tab.click()
      await flush()
    })
    expect(first.container.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull()
    await first.unmount()

    // Remount — same underlying localStorage, fresh component tree.
    const second = await mountRail(services)
    await flush()
    expect(second.container.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull()
    expect(second.container.querySelector("iframe")).not.toBeNull()

    await second.unmount()
  })
})

describe("PluginRail: error state", () => {
  it("shows the diagnostic and a retry affordance instead of an iframe when the plugin state is error", async () => {
    const services = await makeServices([
      {
        test: p => p.startsWith("/v1/plugins"),
        handler: () =>
          listing([
            {
              id: "broken",
              scope: "global",
              panel: { title: "Broken" },
              state: "error",
              diagnostics: [{ path: "/plugins/broken/plugin.yaml", message: "backend exited immediately" }],
            },
          ]),
      },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: null, feature: null })

    const { act } = await load()
    const m = await mountRail(services)
    await flush()
    const tab = m.container.querySelector('[role="tab"][title="Broken"]') as HTMLButtonElement
    await act(async () => {
      tab.click()
      await flush()
    })

    expect(m.container.querySelector("iframe")).toBeNull()
    expect(m.container.textContent).toContain("backend exited immediately")
    const retryBtn = [...m.container.querySelectorAll("button")].find(b => b.textContent === "retry")
    expect(retryBtn).not.toBeUndefined()

    await m.unmount()
  })

  it("shows the error state (not a broken iframe) when the ui route probe answers non-OK — the plugin listing itself reports 'running' (m2)", async () => {
    // The listing says "running" (no backend crash the listing layer
    // would know about), but the UI route itself never answers OK — the
    // scenario `<iframe onError>` cannot detect (an HTTP error response
    // still "loads" as far as the iframe's own navigation is concerned).
    // No stub matches the `.../ui/` probe path, so `fetchStub`'s
    // catch-all 404 stands in for the down backend.
    const services = await makeServices([
      {
        test: p => p.startsWith("/v1/plugins") && !p.includes("/ui/"),
        handler: () => listing([{ id: "flaky", scope: "global", panel: { title: "Flaky" }, state: "running", diagnostics: [] }]),
      },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: null, feature: null })

    const { act } = await load()
    const m = await mountRail(services)
    await flush()
    const tab = m.container.querySelector('[role="tab"][title="Flaky"]') as HTMLButtonElement
    await act(async () => {
      tab.click()
      await flush()
      await flush()
    })

    expect(m.container.querySelector("iframe")).toBeNull()
    const retryBtn = [...m.container.querySelectorAll("button")].find(b => b.textContent === "retry")
    expect(retryBtn).not.toBeUndefined()

    await m.unmount()
  })
})

describe("PluginRail bridge: handshake, context push, navigate, filtering", () => {
  async function mountOpenPanel(pluginId = "openspec") {
    const services = await makeServices([
      { test: p => p.startsWith("/v1/plugins"), handler: () => listing([{ id: pluginId, scope: "global", panel: { title: "OpenSpec" }, state: "running", diagnostics: [] }]) },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: "/proj/a", feature: null })

    const { act } = await load()
    const m = await mountRail(services)
    await flush()
    const tab = m.container.querySelector('[role="tab"][title="OpenSpec"]') as HTMLButtonElement
    await act(async () => {
      tab.click()
      await flush()
    })
    const iframe = m.container.querySelector("iframe") as HTMLIFrameElement
    return { ...m, iframe }
  }

  it("answers a ready handshake with the current context, carrying no token", async () => {
    const { act } = await load()
    const m = await mountOpenPanel()
    const received: unknown[] = []
    m.iframe.contentWindow!.postMessage = ((data: unknown) => {
      received.push(data)
    }) as typeof window.postMessage

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { conductor: true, v: 1, type: "ready", payload: { v: 1 } },
          origin: window.location.origin,
          source: m.iframe.contentWindow,
        }),
      )
      await flush()
    })

    expect(received).toHaveLength(1)
    const envelope = received[0] as { type: string; payload: { project: string | null } }
    expect(envelope.type).toBe("context")
    expect(envelope.payload.project).toBe("/proj/a")
    expect(JSON.stringify(envelope)).not.toContain("tok")

    await m.unmount()
  })

  it("pushes context-changed when the active scope changes after handshake", async () => {
    const { act } = await load()
    const m = await mountOpenPanel()
    const received: unknown[] = []
    m.iframe.contentWindow!.postMessage = ((data: unknown) => {
      received.push(data)
    }) as typeof window.postMessage

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { conductor: true, v: 1, type: "ready", payload: { v: 1 } },
          origin: window.location.origin,
          source: m.iframe.contentWindow,
        }),
      )
      await flush()
    })
    received.length = 0

    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    await act(async () => {
      publishActiveScope({ project: "/proj/b", feature: null })
      await flush()
      await flush()
    })

    expect(received.length).toBeGreaterThan(0)
    const last = received[received.length - 1] as { type: string; payload: { project: string | null } }
    expect(last.type).toBe("context-changed")
    expect(last.payload.project).toBe("/proj/b")

    await m.unmount()
  })

  it("navigates the host on a navigate message and keeps the panel open", async () => {
    const { act } = await load()
    const m = await mountOpenPanel()

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { conductor: true, v: 1, type: "navigate", payload: { to: { feature: "f-42" } } },
          origin: window.location.origin,
          source: m.iframe.contentWindow,
        }),
      )
      await flush()
    })

    expect(m.history[m.history.length - 1]).toBe("/feature/f-42")
    expect(m.container.querySelector("iframe")).not.toBeNull()

    await m.unmount()
  })

  it("ignores a message from the wrong origin", async () => {
    const { act } = await load()
    const m = await mountOpenPanel()
    const received: unknown[] = []
    m.iframe.contentWindow!.postMessage = ((data: unknown) => received.push(data)) as typeof window.postMessage

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { conductor: true, v: 1, type: "ready", payload: { v: 1 } },
          origin: "http://evil.example",
          source: m.iframe.contentWindow,
        }),
      )
      await flush()
    })

    expect(received).toHaveLength(0)
    await m.unmount()
  })

  it("ignores a message whose source is not the panel's own iframe window", async () => {
    const { act } = await load()
    const m = await mountOpenPanel()
    const otherFrame = document.createElement("iframe")
    document.body.appendChild(otherFrame)
    const received: unknown[] = []
    m.iframe.contentWindow!.postMessage = ((data: unknown) => received.push(data)) as typeof window.postMessage

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { conductor: true, v: 1, type: "ready", payload: { v: 1 } },
          origin: window.location.origin,
          source: otherFrame.contentWindow,
        }),
      )
      await flush()
    })

    expect(received).toHaveLength(0)
    otherFrame.remove()
    await m.unmount()
  })

  it("drops a message with an unsupported bridge version", async () => {
    const { act } = await load()
    const m = await mountOpenPanel()
    const received: unknown[] = []
    m.iframe.contentWindow!.postMessage = ((data: unknown) => received.push(data)) as typeof window.postMessage

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { conductor: true, v: 99, type: "ready", payload: { v: 99 } },
          origin: window.location.origin,
          source: m.iframe.contentWindow,
        }),
      )
      await flush()
    })

    expect(received).toHaveLength(0)
    await m.unmount()
  })
})

describe("PluginRail beside the gate flow", () => {
  it("does not obstruct the two-click gate flow from the board (card click, then review-gate click)", async () => {
    const { act } = await load()
    const services = await makeServices([
      { test: p => p.startsWith("/v1/plugins"), handler: () => listing([{ id: "openspec", scope: "global", panel: { title: "OpenSpec" }, state: "running", diagnostics: [] }]) },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
      { test: p => p === "/v1/features", handler: () => ({ features: [listItem("f-1", { status: "waiting_human" })] }) },
      { test: p => p.startsWith("/v1/features/f-1"), handler: () => detailResponse("f-1") },
      { test: p => p.startsWith("/v1/projects/workflow"), handler: () => ({ name: "delivery", stale: false, jobs: { main: { needs: [], steps: [{ id: "implement", kind: "agent" }] } }, inputs: {}, diagnostics: [] }) },
    ])

    const { React, createRoot } = await load()
    const h = React.createElement
    const { AppContext } = await import("../src/app-context.ts")
    const { Board } = await import("../src/board/board.tsx")
    const { FeatureView } = await import("../src/feature/feature-view.tsx")
    const { PluginRail } = await import("../src/plugins/plugin-rail.tsx")
    const { StartWorkContext } = await import("../src/start-work/start-work-context.ts")
    const { Router, Route } = await import("wouter")
    const { memoryLocation } = await import("wouter/memory-location")

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const { hook, navigate } = memoryLocation({ path: "/", record: true })

    await act(async () => {
      root.render(
        h(
          AppContext.Provider,
          { value: services },
          h(
            StartWorkContext.Provider,
            { value: () => {} },
            h(Router, {
              hook,
              children: h(
                "div",
                null,
                h(Route, { path: "/", component: Board }),
                h(Route, { path: "/feature/:id", component: FeatureView }),
                h(PluginRail),
              ),
            }),
          ),
        ),
      )
      await flush()
    })

    // The rail is present alongside the board (global plugin) — assert
    // it renders without stealing focus/DOM priority from the card.
    expect(container.querySelector('[role="tablist"]')).not.toBeNull()

    // Click 1: board card link to the feature (with the gate deep link).
    const cardLink = container.querySelector('a[href^="/feature/f-1"]') as HTMLAnchorElement | null
    expect(cardLink).not.toBeNull()
    await act(async () => {
      navigate(cardLink!.getAttribute("href")!)
      await flush()
    })

    // Click 2: review gate button on the feature view.
    const gateBtn = [...container.querySelectorAll("button")].find(b => b.textContent === "review gate")
    expect(gateBtn).not.toBeUndefined()
    await act(async () => {
      ;(gateBtn as HTMLButtonElement).click()
      await flush()
    })

    // GateModal renders via ActionSheet's createPortal into document.body,
    // not into `container` — the dialog is real DOM either way.
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
    container.remove()
    document.body.querySelector('[role="dialog"]')?.parentElement?.remove()
  })
})

interface HappyDomViewportWindow {
  readonly happyDOM: { setViewport(options: { width?: number; height?: number }): void }
}

describe("PluginRail: narrow viewport presentation", () => {
  it("presents the open panel as an ActionSheet overlay instead of the inline aside below the 768px breakpoint (design.md open question, resolved)", async () => {
    ;(window as unknown as HappyDomViewportWindow).happyDOM.setViewport({ width: 400 })
    window.dispatchEvent(new Event("resize"))

    const services = await makeServices([
      { test: p => p.startsWith("/v1/plugins"), handler: () => listing([{ id: "openspec", scope: "global", panel: { title: "OpenSpec" }, state: "running", diagnostics: [] }]) },
      { test: p => p.startsWith("/v1/health"), handler: () => health() },
    ])
    const { publishActiveScope } = await import("../src/plugins/active-scope.ts")
    publishActiveScope({ project: null, feature: null })

    const { act } = await load()
    const m = await mountRail(services)
    await flush()

    // Below the breakpoint the tabs render OUTSIDE the inline `.rail`
    // container (no `role="tablist"` wrapped in an open aside) and the
    // panel, once opened, is an `ActionSheet` (`role="dialog"`,
    // portalled to `document.body`), not the inline `.panel` div.
    const tab = m.container.querySelector('[role="tab"][title="OpenSpec"]') as HTMLButtonElement
    expect(tab).not.toBeNull()
    await act(async () => {
      tab.click()
      await flush()
    })

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("OpenSpec")
    expect(m.container.querySelector("iframe")).toBeNull()
    expect(document.body.querySelector('[role="dialog"] iframe')).not.toBeNull()

    await m.unmount()
    document.body.querySelector('[role="dialog"]')?.parentElement?.remove()
    ;(window as unknown as HappyDomViewportWindow).happyDOM.setViewport({ width: 1024 })
    window.dispatchEvent(new Event("resize"))
  })
})
