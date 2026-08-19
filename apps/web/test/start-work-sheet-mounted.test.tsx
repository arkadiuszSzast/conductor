/**
 * `StartWorkSheet`/`useStartWorkForm` mounted interaction tests — the
 * behaviors `renderToStaticMarkup` (used by `start-work-form-fields.
 * test.tsx`) cannot exercise: typed field entry, submit, duplicate-
 * submit/dismiss prevention while pending, error-preserving retries
 * across client/server/network/configuration-race failures, metadata
 * refetch/reconciliation after a race, 401 → auth-callback routing, and
 * success navigation without waiting for SSE (spec: "Add meaningful
 * mounted interaction tests for useStartWorkForm/StartWorkSheet/
 * ActionSheet behavior").
 *
 * All React/component modules are imported dynamically INSIDE each test
 * (never statically at module top level) — see `test/dom-env.ts`'s
 * module doc: a static top-level `import` of `react-dom/client` runs
 * before `beforeAll` registers the DOM, and React's `canUseDOM`/
 * `isInputEventSupported` detection (module-load-time only) then
 * silently disables real `onChange` firing for every controlled input —
 * a false-positive trap where `input.value` looks updated but the
 * component's actual React state never advances.
 *
 * DOM LIMITATION (documented per task instructions rather than silently
 * skipped): happy-dom does not implement CSS `@media` matching or real
 * layout, so pixel-geometry assertions (sticky footer visibility, safe-
 * area padding effect) are NOT exercised here; `viewport-contracts.
 * test.ts` covers those declaratively (asserting the CSS itself
 * contains the right rules) since no real layout engine is available.
 * What IS exercised here is everything DOM/JS-observable: focus,
 * keyboard events, disabled state, ARIA attributes, controlled-input
 * values via React state (not raw DOM `.value`), and navigation.
 *
 * Requires `NODE_ENV=development` (`bun run test:mounted`) — every
 * `describe` below is skipped entirely otherwise, see `test/dom-env.ts`.
 */
import { describe as describeBase, expect, it } from "bun:test"
import { mountedTestsSupported, useDomEnv, flush } from "./dom-env.ts"
import type { DaemonHealth, FeatureDetailResponse, WorkflowProjection } from "../src/api/types.ts"
import type { FetchLike } from "../src/api/client.ts"

const { load } = useDomEnv()
const describe = describeBase.skipIf(!mountedTestsSupported)

// ---------------------------------------------------------------- fixtures

function health(partial: Partial<DaemonHealth> = {}): DaemonHealth {
  return {
    alive: true,
    ready: true,
    phase: "ready",
    database: { path: "", migrated: true, appliedNow: [], knownMigrations: 0 },
    heartbeat: { intervalMs: 0, running: true, inFlight: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, cycles: 0 },
    projects: [{ projectDir: "/proj/app", state: "valid", diagnostics: [] }],
    runner: "available",
    ...partial,
  }
}

function workflow(partial: Partial<WorkflowProjection> = {}): WorkflowProjection {
  return { name: "delivery", stale: false, jobs: {}, inputs: {}, diagnostics: [], ...partial }
}

function detailResponse(id: string, overrides: Partial<FeatureDetailResponse["feature"]> = {}): FeatureDetailResponse {
  return {
    feature: {
      id,
      title: "T",
      slug: id,
      projectDir: "/proj/app",
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
      workflowRef: { name: "delivery", stale: false },
      feedback: null,
      jobs: {},
      ...overrides,
    },
    activeRun: null,
  }
}

// ---------------------------------------------------------------- fetch stack

interface Call {
  path: string
  method: string
  /** Parsed JSON body, or `undefined` for a GET/no-body request. */
  body: unknown
}

interface Stack {
  readonly fetchImpl: FetchLike
  readonly calls: Call[]
  readonly unauthorized: number[]
}

/** Route table keyed by exact path prefix; each handler may return a
 *  plain JSON-able value (200) or a `Response` for custom status/errors. */
function makeStack(handlers: Record<string, (call: Call) => unknown | Promise<unknown>>): Stack {
  const calls: Call[] = []
  const unauthorized: number[] = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    const method = init?.method ?? "GET"
    let body: unknown
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call: Call = { path, method, body }
    calls.push(call)
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) {
        const result = await handler(call)
        if (result instanceof Response) return result
        return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })
      }
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "no route", requestId: "r" } }), { status: 404 })
  }) as FetchLike
  return { fetchImpl, calls, unauthorized }
}

async function waitForCondition(check: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return
    await flush()
  }
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

function titleInput(): HTMLInputElement {
  return document.querySelector('input[placeholder="e.g. Add dark mode"]') as HTMLInputElement
}
function descriptionInput(): HTMLTextAreaElement {
  return document.querySelector("textarea") as HTMLTextAreaElement
}
function submitButton(): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find(
    b => b.textContent?.includes("start work") || b.textContent?.includes("starting"),
  ) as HTMLButtonElement
}
function cancelButton(): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find(b => b.textContent === "cancel") as HTMLButtonElement
}

// ---------------------------------------------------------------- mount helper

interface MountResult {
  container: HTMLDivElement
  root: import("react-dom/client").Root
  /** In-memory route history — `history[history.length - 1]` is the
   *  current path, so a test can assert navigation happened (and to
   *  where) without a real browser `location`. */
  history: readonly string[]
  unmount: () => Promise<void>
}

/** Services a `mountSheet` call composes — exposed so a test can build
 *  them once and REUSE the same `DataSource` across an unmount+remount
 *  pair (simulating the sheet closing and reopening while the app shell
 *  itself, and its store, stay alive) rather than getting a fresh store
 *  every mount. */
interface SheetServices {
  readonly client: import("../src/api/client.ts").ApiClient
  readonly store: import("../src/api/store.ts").DataSource
  readonly session: import("../src/auth/auth-store.ts").AuthSession
}

async function makeSheetServices(stack: Stack): Promise<SheetServices> {
  const { ApiClient } = await import("../src/api/client.ts")
  const { DataSource } = await import("../src/api/store.ts")
  const { AuthSession } = await import("../src/auth/auth-store.ts")
  const client = new ApiClient({ token: () => "tok", onUnauthorized: () => stack.unauthorized.push(1), fetch: stack.fetchImpl })
  // Real setTimeout, but with no delay — `DataSource`'s bounded
  // internal retry (1s/2s/4s backoff on a NON-forced initial load) would
  // otherwise make a test that exercises an initial-load failure take
  // several real seconds to settle into its final `error` state.
  const store = new DataSource({ client, setTimeoutFn: fn => setTimeout(fn, 0), clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>) })
  const session = new AuthSession({ storage: { get: () => null, set: () => {} }, probe: async () => 200 })
  session.status = "authenticated"
  return { client, store, session }
}

async function mountSheet(stack: Stack, onClose: () => void, services?: SheetServices): Promise<MountResult> {
  const { React, act, createRoot } = await load()
  const h = React.createElement
  const { AppContext } = await import("../src/app-context.ts")
  const { StartWorkSheet } = await import("../src/start-work/start-work-sheet.tsx")
  const { Router } = await import("wouter")
  const { memoryLocation } = await import("wouter/memory-location")

  const { client, store, session } = services ?? (await makeSheetServices(stack))

  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const { hook, history } = memoryLocation({ path: "/", record: true })

  await act(async () => {
    root.render(
      h(
        AppContext.Provider,
        { value: { session, client, store } },
        h(Router, { hook, children: h(StartWorkSheet, { onClose }) }),
      ),
    )
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

// ---------------------------------------------------------------- tests

describe("StartWorkSheet: health load/refresh-on-open", () => {
  it("issues exactly one /v1/health request on a fresh mount — no duplicate concurrent fetch from ensureHealthLoaded + the open-refresh effect racing", async () => {
    const { act } = await load()
    let healthCalls = 0
    const stack = makeStack({
      "/v1/health": () => {
        healthCalls++
        return health()
      },
      "/v1/projects/workflow": () => workflow(),
    })
    const m = await mountSheet(stack, () => {})
    await act(async () => {
      await waitForCondition(() => titleInput() !== null)
    })
    expect(healthCalls).toBe(1)

    await m.unmount()
  })

  it("recovers after an initial health load failure once the sheet is reopened — a settled error forces a fresh retry, not a permanent stuck state", async () => {
    const { act } = await load()
    let healthCalls = 0
    let fail = true
    const stack = makeStack({
      "/v1/health": () => {
        healthCalls++
        if (fail) return new Response(JSON.stringify({ error: { code: "internal", message: "boom", requestId: "r" } }), { status: 500 })
        return health()
      },
      "/v1/projects/workflow": () => workflow(),
    })
    const services = await makeSheetServices(stack)

    // First open: health fails and settles into a permanent error (no
    // other trigger — workflow: has no SSE kind — would ever retry it on
    // its own once the bounded internal retry attempts are exhausted).
    const first = await mountSheet(stack, () => {}, services)
    await act(async () => {
      await waitForCondition(() => document.body.textContent?.includes("could not load configured projects") === true, 60)
    })
    expect(document.body.textContent).toContain("could not load configured projects")
    await first.unmount()

    // The daemon recovers before the operator reopens the sheet.
    fail = false
    const callsBeforeReopen = healthCalls

    // Reopening the sheet (a fresh `StartWorkSheet` instance, same
    // store/session — mirrors the shell mounting a new sheet each time
    // it opens) must force a retry: the health resource's status is a
    // settled "error", not "loading", so the on-open effect's guard
    // must NOT skip it.
    const second = await mountSheet(stack, () => {}, services)
    await act(async () => {
      await waitForCondition(() => healthCalls > callsBeforeReopen)
      await waitForCondition(() => titleInput() !== null, 60)
    })
    expect(document.body.textContent).not.toContain("could not load configured projects")
    expect(healthCalls).toBe(callsBeforeReopen + 1)

    await second.unmount()
  })
})
describe("StartWorkSheet: workflow refresh recovery", () => {
  it("an INITIAL workflow transport failure shows a Retry action; clicking it recovers, preserves entered fields, and restores submission", async () => {
    const { act } = await load()
    let workflowCalls = 0
    let fail = true
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => {
        workflowCalls++
        if (fail) return new Response(JSON.stringify({ error: { code: "internal", message: "boom", requestId: "r" } }), { status: 500 })
        return workflow({ inputs: { feature: { type: "string", presence: "required" } } })
      },
    })
    const services = await makeSheetServices(stack)
    const m = await mountSheet(stack, () => {}, services)

    // The initial fetch fails (and the hook's own bounded auto-retry-
    // once fires and fails again too) — settles into a visible,
    // explicit-Retry-offering unavailable state, never endless loading.
    await act(async () => {
      await waitForCondition(() => document.body.textContent?.includes("boom") === true, 60)
    })
    expect(document.body.textContent).toContain("boom")
    const retryBtn = () => [...document.querySelectorAll("button")].find(b => b.textContent === "retry") as HTMLButtonElement | undefined
    await waitForCondition(() => retryBtn() !== undefined)
    expect(retryBtn()).not.toBeUndefined()
    const callsBeforeExplicitRetry = workflowCalls

    // The operator enters a title BEFORE the target ever became
    // submittable — must survive the whole recovery.
    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    expect(titleInput().value).toBe("Add dark mode")

    // The daemon recovers, then the operator clicks the explicit Retry.
    fail = false
    await act(async () => {
      retryBtn()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(workflowCalls).toBe(callsBeforeExplicitRetry + 1)

    // Recovered: the workflow notice/inputs now render, the entered
    // title survived, and submission is restored (once the newly-
    // revealed required `feature` input is filled in).
    await waitForCondition(() => document.body.textContent?.includes("boom") === false)
    expect(document.body.textContent).not.toContain("boom")
    expect(titleInput().value).toBe("Add dark mode")
    const featureInput = document.querySelector("fieldset input[type=text]") as HTMLInputElement | null
    expect(featureInput).not.toBeNull()
    await act(async () => {
      setValue(featureInput!, "auth")
    })
    await waitForCondition(() => !submitButton().disabled)
    expect(submitButton().disabled).toBe(false)

    await m.unmount()
  })

  it("a cached-refresh failure shows a Retry action; clicking it recovers and restores submission without wiping the compatible entered input", async () => {
    const { act } = await load()
    let workflowCalls = 0
    // First call succeeds (a valid cached snapshot); every call from the
    // SECOND onward — the forced refresh triggered by a rejected submit
    // — fails until `failRefresh` is cleared.
    let failRefresh = false
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => {
        workflowCalls++
        if (workflowCalls > 1 && failRefresh) {
          return new Response(JSON.stringify({ error: { code: "internal", message: "refresh boom", requestId: "r" } }), { status: 500 })
        }
        return workflow({ inputs: { feature: { type: "string", presence: "required" } } })
      },
      "/v1/features": call =>
        call.method === "POST"
          ? new Response(JSON.stringify({ error: { code: "unknown_workflow", message: 'unknown workflow "delivery"', requestId: "r-1" } }), {
              status: 422,
              headers: { "content-type": "application/json" },
            })
          : { features: [] },
    })
    const services = await makeSheetServices(stack)
    const m = await mountSheet(stack, () => {}, services)
    await act(async () => {
      await waitForCondition(() => titleInput() !== null)
    })

    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    const featureInput = document.querySelector("fieldset input[type=text]") as HTMLInputElement | null
    expect(featureInput).not.toBeNull()
    await act(async () => {
      setValue(featureInput!, "auth")
    })
    await waitForCondition(() => !submitButton().disabled)

    // Submitting triggers a config-race rejection, which forces a
    // refetch of this target's workflow — arrange for THAT refetch (and
    // its own bounded auto-retry) to fail, landing in `refreshError`.
    failRefresh = true
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    await act(async () => {
      await waitForCondition(() => document.body.textContent?.includes("could not confirm") === true, 60)
    })
    expect(document.body.textContent).toContain("could not confirm")
    // Preserved through the failure: entered fields and the compatible
    // input's value.
    expect(titleInput().value).toBe("Add dark mode")
    expect((document.querySelector("fieldset input[type=text]") as HTMLInputElement | null)?.value).toBe("auth")

    const retryBtn = () => [...document.querySelectorAll("button")].find(b => b.textContent === "retry") as HTMLButtonElement | undefined
    await waitForCondition(() => retryBtn() !== undefined)
    const callsBeforeExplicitRetry = workflowCalls

    // The daemon recovers; the operator clicks Retry.
    failRefresh = false
    await act(async () => {
      retryBtn()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(workflowCalls).toBe(callsBeforeExplicitRetry + 1)

    await waitForCondition(() => document.body.textContent?.includes("could not confirm") === false)
    expect(document.body.textContent).not.toContain("could not confirm")
    // Values survived the whole recovery; submission is restored.
    expect(titleInput().value).toBe("Add dark mode")
    expect((document.querySelector("fieldset input[type=text]") as HTMLInputElement | null)?.value).toBe("auth")
    await waitForCondition(() => !submitButton().disabled)
    expect(submitButton().disabled).toBe(false)

    await m.unmount()
  })

  it("a persistently failing workflow fetch never auto-retries more than once — the bounded auto-retry does not loop", async () => {
    const { act } = await load()
    let workflowCalls = 0
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => {
        workflowCalls++
        return new Response(JSON.stringify({ error: { code: "internal", message: "boom", requestId: "r" } }), { status: 500 })
      },
    })
    const m = await mountSheet(stack, () => {})
    await act(async () => {
      await waitForCondition(() => document.body.textContent?.includes("boom") === true, 60)
    })
    const callsAfterSettling = workflowCalls
    expect(callsAfterSettling).toBeGreaterThan(0)

    // Give the environment plenty of extra time/microtask turns — a
    // looping auto-retry would keep incrementing `workflowCalls`
    // indefinitely; a bounded one settles and stays flat.
    await act(async () => {
      for (let i = 0; i < 10; i++) await flush()
    })
    expect(workflowCalls).toBe(callsAfterSettling)

    await m.unmount()
  })
})

describe("StartWorkSheet: mounted happy path", () => {
  it("fills the form, submits, and closes+navigates on success without an SSE round trip", async () => {
    const { act } = await load()
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => workflow(),
      "/v1/features": call => (call.method === "POST" ? detailResponse("new-1", { title: "Add dark mode" }) : { features: [] }),
    })
    let closed = 0
    const m = await mountSheet(stack, () => closed++)
    await waitForCondition(() => titleInput() !== null)

    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    expect(titleInput().value).toBe("Add dark mode")
    await waitForCondition(() => !submitButton().disabled)

    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(closed).toBe(1)
    // No SSE frame was ever delivered — the store's stream was never
    // started for this harness (no `store.start()` call) — yet the
    // feature detail is already authoritative from the POST response
    // alone, proving navigation/close did not wait on it.
    expect(stack.calls.some(c => c.path === "/v1/features" && c.method === "POST")).toBe(true)
    // Navigation to /feature/:id happened immediately after the 201,
    // never waiting on any later SSE-triggered refetch.
    expect(m.history[m.history.length - 1]).toBe("/feature/new-1")

    await m.unmount()
  })

  it("submits a typed POST body — title, description, pr, and typed workflow inputs (string/number/boolean) serialize correctly", async () => {
    const { act } = await load()
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () =>
        workflow({
          inputs: {
            feature: { type: "string", presence: "required" },
            count: { type: "number", presence: "optional", default: 3 },
            verbose: { type: "boolean", presence: "optional", default: false },
          },
        }),
      "/v1/features": call => (call.method === "POST" ? detailResponse("new-1") : { features: [] }),
    })
    let closed = 0
    const m = await mountSheet(stack, () => closed++)
    await waitForCondition(() => titleInput() !== null)

    await act(async () => {
      setValue(titleInput(), "Add dark mode")
      setValue(descriptionInput(), "some task context")
    })
    const prField = document.querySelector('input[placeholder="optional — e.g. 123"]') as HTMLInputElement
    // Workflow inputs render alphabetically by name (`count`, `feature`,
    // `verbose`) — see `StartWorkFormFields`'s `.sort(([a], [b]) => ...)`.
    const countField = document.querySelectorAll('fieldset input[type="text"]')[0] as HTMLInputElement
    const featureField = document.querySelectorAll('fieldset input[type="text"]')[1] as HTMLInputElement
    const verboseField = document.querySelector('fieldset input[type="checkbox"]') as HTMLInputElement
    await act(async () => {
      setValue(prField, "42")
      setValue(featureField, "auth")
      setValue(countField, "7")
      verboseField.click()
    })
    await waitForCondition(() => !submitButton().disabled)

    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(closed).toBe(1)
    const postCall = stack.calls.find(c => c.path === "/v1/features" && c.method === "POST")
    expect(postCall).not.toBeUndefined()
    const body = postCall!.body as {
      title: string
      description?: string
      pr?: number
      project: string
      workflow: string
      inputs: Record<string, unknown>
    }
    expect(body.title).toBe("Add dark mode")
    expect(body.description).toBe("some task context")
    // `pr` is a JSON NUMBER, never the raw string typed into the field.
    expect(body.pr).toBe(42)
    expect(typeof body.pr).toBe("number")
    expect(body.project).toBe("/proj/app")
    expect(body.workflow).toBe("delivery")
    // Workflow inputs preserve their own declared JSON types.
    expect(body.inputs).toEqual({ feature: "auth", count: 7, verbose: true })
    expect(typeof body.inputs.count).toBe("number")
    expect(typeof body.inputs.verbose).toBe("boolean")

    await m.unmount()
  })
})

describe("StartWorkSheet: duplicate submit / dismissal prevention", () => {
  it("blocks a second submit activation and Escape/backdrop dismissal while the request is pending", async () => {
    const { act } = await load()
    let resolvePost: (() => void) | null = null
    const postGate = new Promise<void>(resolve => {
      resolvePost = resolve
    })
    let postCount = 0
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => workflow(),
      "/v1/features": async call => {
        if (call.method === "POST") {
          postCount++
          await postGate
          return detailResponse("new-1")
        }
        return { features: [] }
      },
    })
    let closed = 0
    const m = await mountSheet(stack, () => closed++)
    await waitForCondition(() => titleInput() !== null)
    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    await waitForCondition(() => !submitButton().disabled)

    // Fire the submit; the POST hangs on `postGate`.
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(submitButton().disabled).toBe(true)
    expect(submitButton().textContent).toContain("starting")

    // A second click while pending must not fire a second POST.
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(postCount).toBe(1)

    // Escape and the cancel button are both blocked while pending.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(closed).toBe(0)
    expect(cancelButton().disabled).toBe(true)
    await act(async () => {
      cancelButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    })
    expect(closed).toBe(0)

    // Release the gate — the request concludes and close/navigate fires.
    await act(async () => {
      resolvePost?.()
      await flush()
    })
    expect(closed).toBe(1)

    await m.unmount()
  })
})

describe("StartWorkSheet: immediate actionable client validation", () => {
  it("shows no error for an untouched, never-submitted empty title, but shows it the moment the operator types then clears it", async () => {
    const { act } = await load()
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => workflow(),
    })
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => titleInput() !== null)

    // Untouched, empty title: submit is disabled (nothing to submit) but
    // NO error text is shown — never "highlighted fields" with nothing
    // highlighted.
    expect(submitButton().disabled).toBe(true)
    expect(document.body.textContent).not.toContain("a title is required")

    // The operator types something, then clears it back to empty —
    // "touched" now, so the live error becomes visible immediately,
    // with no submit attempt required.
    await act(async () => {
      setValue(titleInput(), "x")
    })
    await act(async () => {
      setValue(titleInput(), "")
    })
    await waitForCondition(() => document.body.textContent?.includes("a title is required") === true)
    expect(document.body.textContent).toContain("a title is required")

    // Correcting the value clears the error again immediately.
    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    await waitForCondition(() => !document.body.textContent?.includes("a title is required"))
    expect(document.body.textContent).not.toContain("a title is required")
    expect(submitButton().disabled).toBe(false)

    await m.unmount()
  })

  it("a blocked submit attempt on an untouched invalid field makes its error visible even though it was never focused", async () => {
    const { act } = await load()
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => workflow({ inputs: { feature: { type: "string", presence: "required" } } }),
    })
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => titleInput() !== null)

    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    // Title is now valid, but the required `feature` workflow input was
    // never touched — canSubmit is still false (it's required), and its
    // error is not yet shown (untouched, no submit attempt yet).
    expect(submitButton().disabled).toBe(true)
    expect(document.body.textContent).not.toContain('"feature" is required')

    // Submitting an invalid form dispatches `submit()`; the hook marks
    // every field touched so an untouched offending field's error
    // becomes visible immediately — the button stays disabled the whole
    // time (submit() is a client-side no-op here), so a real click event
    // (not a programmatic form submit) is the only way to trigger this
    // through the UI, exactly like an operator hitting Enter would.
    const form = document.querySelector("form") as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    await waitForCondition(() => document.body.textContent?.includes('"feature" is required') === true)
    expect(document.body.textContent).toContain('"feature" is required')

    await m.unmount()
  })

  it("switching targets after a blocked submit attempt does not immediately show errors for the new target's untouched inputs", async () => {
    const { act } = await load()
    const stack = makeStack({
      "/v1/health": () =>
        health({
          projects: [
            { projectDir: "/proj/a", state: "valid", diagnostics: [] },
            { projectDir: "/proj/b", state: "valid", diagnostics: [] },
          ],
        }),
      "/v1/projects/workflow": call => {
        const dir = new URL(call.path, "http://x").searchParams.get("dir")
        return workflow({ name: dir === "/proj/a" ? "wf-a" : "wf-b", inputs: { feature: { type: "string", presence: "required" } } })
      },
    })
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => document.querySelectorAll('input[type="radio"]').length === 2)
    await waitForCondition(() => titleInput() !== null)

    // Two eligible targets means neither is auto-preselected — choose
    // the first explicitly before attempting to submit.
    const firstRadio = document.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement
    await act(async () => {
      firstRadio.click()
      await flush()
    })
    await waitForCondition(() => document.body.textContent?.includes("wf-a") === true || document.body.textContent?.includes("wf-b") === true)

    // Attempt a submit with an empty required `feature` input — this
    // marks every current-target field touched, including `feature`.
    const form = document.querySelector("form") as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    await waitForCondition(() => document.body.textContent?.includes('"feature" is required') === true)
    expect(document.body.textContent).toContain('"feature" is required')

    // Now switch to the other target — its own `feature` input is
    // brand new to the operator and must not immediately show an error.
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[]
    const otherRadio = radios.find(r => !r.checked)!
    await act(async () => {
      otherRadio.click()
      await flush()
    })
    await waitForCondition(() => document.body.textContent?.includes("wf-b") === true || document.body.textContent?.includes("wf-a") === true)
    expect(document.body.textContent).not.toContain('"feature" is required')

    await m.unmount()
  })
})

describe("StartWorkSheet: field preservation across failures", () => {
  it("keeps submit disabled with an explanatory title while the title is empty (client validation)", async () => {
    const { act } = await load()
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => workflow(),
    })
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => titleInput() !== null)
    await act(async () => {
      setValue(descriptionInput(), "some task context")
    })
    // Title is empty — canSubmit must already be false; submit is a no-op.
    expect(submitButton().disabled).toBe(true)
    expect(descriptionInput().value).toBe("some task context")
    await m.unmount()
  })

  it("preserves all fields and shows an inline error on a server rejection (invalid_input), and refetches the target's workflow", async () => {
    const { act } = await load()
    let workflowFetches = 0
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => {
        workflowFetches++
        return workflow({ inputs: { feature: { type: "string", presence: "required" } } })
      },
      "/v1/features": call =>
        call.method === "POST"
          ? new Response(
              JSON.stringify({
                error: { code: "invalid_input", message: 'input "feature" is required', requestId: "r-1" },
                diagnostics: [{ name: "feature", kind: "missing_required", message: 'input "feature" is required (type: string)' }],
              }),
              { status: 422, headers: { "content-type": "application/json" } },
            )
          : { features: [] },
    })
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => titleInput() !== null)
    await waitForCondition(() => workflowFetches > 0)
    const initialFetches = workflowFetches

    await act(async () => {
      setValue(titleInput(), "Add dark mode")
      setValue(descriptionInput(), "task text")
    })
    const featureInput = document.querySelector("fieldset input[type=text]") as HTMLInputElement | null
    expect(featureInput).not.toBeNull()
    await act(async () => {
      setValue(featureInput!, "auth")
    })
    await waitForCondition(() => !submitButton().disabled)

    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })

    // Fields preserved.
    expect(titleInput().value).toBe("Add dark mode")
    expect(descriptionInput().value).toBe("task text")
    // Inline error visible.
    await waitForCondition(() => document.body.textContent?.includes('input "feature" is required') === true)
    expect(document.body.textContent).toContain('input "feature" is required')
    // Configuration-race handling refetched this target's workflow
    // projection (design.md "refreshes affected target metadata").
    await waitForCondition(() => workflowFetches > initialFetches)
    expect(workflowFetches).toBeGreaterThan(initialFetches)

    await m.unmount()
  })

  it("preserves fields and shows an inline error on a network failure", async () => {
    const { act } = await load()
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url)
      const method = init?.method ?? "GET"
      if (path.startsWith("/v1/features") && method === "POST") {
        throw new TypeError("network request failed")
      }
      if (path.startsWith("/v1/health")) return new Response(JSON.stringify(health()), { status: 200 })
      if (path.startsWith("/v1/projects/workflow")) return new Response(JSON.stringify(workflow()), { status: 200 })
      return new Response(JSON.stringify({ features: [] }), { status: 200 })
    }) as FetchLike
    const stack: Stack = { fetchImpl, calls: [], unauthorized: [] }
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => titleInput() !== null)
    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    await waitForCondition(() => !submitButton().disabled)
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(titleInput().value).toBe("Add dark mode")
    await waitForCondition(() => document.body.textContent?.toLowerCase().includes("network") === true)
    expect(document.body.textContent?.toLowerCase()).toContain("network")

    await m.unmount()
  })
})

describe("StartWorkSheet: 401 handling", () => {
  it("invokes onUnauthorized when the create request returns 401", async () => {
    const { act } = await load()
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => workflow(),
      "/v1/features": call =>
        call.method === "POST"
          ? new Response(JSON.stringify({ error: { code: "unauthorized", message: "missing bearer token", requestId: "r" } }), {
              status: 401,
              headers: { "content-type": "application/json" },
            })
          : { features: [] },
    })
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => titleInput() !== null)
    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    await waitForCondition(() => !submitButton().disabled)
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    // Central 401 handling (`ApiClient.request`) fires `onUnauthorized`
    // regardless of which caller triggered the request — the sheet does
    // not need its own 401 branch to make this happen.
    await waitForCondition(() => stack.unauthorized.length > 0)
    expect(stack.unauthorized.length).toBe(1)

    await m.unmount()
  })

  // A REAL `AuthSession` + `AuthGate` boundary, composed the same way
  // `app.tsx`'s `Shell()` does (conditional render on `useAuthStatus`,
  // `onUnauthorized` wired to `session.handleUnauthorized()`) — proves
  // a 401 from either discovery (health) or creation actually returns
  // the app to the token screen, not merely that the callback fired in
  // isolation (spec: "A 401 from creation or discovery SHALL return the
  // application to the auth gate like any other authenticated request").
  async function mountWithAuthGateBoundary(stack: {
    readonly fetchImpl: FetchLike
  }): Promise<{ container: HTMLDivElement; root: import("react-dom/client").Root; unmount: () => Promise<void> }> {
    const { React, act, createRoot } = await load()
    const h = React.createElement
    const { AppContext } = await import("../src/app-context.ts")
    const { ApiClient } = await import("../src/api/client.ts")
    const { DataSource } = await import("../src/api/store.ts")
    const { AuthSession } = await import("../src/auth/auth-store.ts")
    const { AuthGate } = await import("../src/auth/auth-gate.tsx")
    const { StartWorkSheet } = await import("../src/start-work/start-work-sheet.tsx")
    const { useAuthStatus } = await import("../src/auth/use-auth.ts")
    const { Router } = await import("wouter")
    const { memoryLocation } = await import("wouter/memory-location")

    const session = new AuthSession({ storage: { get: () => "tok", set: () => {} }, probe: async () => 200 })
    const client = new ApiClient({
      token: () => session.getToken(),
      onUnauthorized: () => session.handleUnauthorized(),
      fetch: stack.fetchImpl,
    })
    const store = new DataSource({ client })
    await session.bootstrap()

    function TestShell(): React.ReactNode {
      const status = useAuthStatus(session)
      if (status !== "authenticated") return h(AuthGate)
      return h(StartWorkSheet, { onClose: () => {} })
    }

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const { hook } = memoryLocation({ path: "/", record: true })

    await act(async () => {
      root.render(h(AppContext.Provider, { value: { session, client, store } }, h(Router, { hook, children: h(TestShell) })))
      await flush()
    })

    return {
      container,
      root,
      unmount: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  it("a 401 on discovery (health) returns the mounted app to the AuthGate token screen", async () => {
    const { act } = await load()
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const path = String(url)
      if (path.startsWith("/v1/health")) {
        return new Response(JSON.stringify({ error: { code: "unauthorized", message: "token expired", requestId: "r" } }), { status: 401 })
      }
      return new Response(JSON.stringify({ features: [] }), { status: 200 })
    }) as FetchLike
    const m = await mountWithAuthGateBoundary({ fetchImpl })
    await act(async () => {
      await flush()
      await flush()
    })
    // The AuthGate's distinguishing control is now on screen — the
    // StartWorkSheet's dialog is gone.
    await waitForCondition(() => document.querySelector('input[aria-label="Bearer token"]') !== null)
    expect(document.querySelector('input[aria-label="Bearer token"]')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await m.unmount()
  })

  it("a 401 on creation returns the mounted app to the AuthGate token screen", async () => {
    const { act } = await load()
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url)
      const method = init?.method ?? "GET"
      if (path.startsWith("/v1/health")) return new Response(JSON.stringify(health()), { status: 200 })
      if (path.startsWith("/v1/projects/workflow")) return new Response(JSON.stringify(workflow()), { status: 200 })
      if (path.startsWith("/v1/features") && method === "POST") {
        return new Response(JSON.stringify({ error: { code: "unauthorized", message: "token expired", requestId: "r" } }), { status: 401 })
      }
      return new Response(JSON.stringify({ features: [] }), { status: 200 })
    }) as FetchLike
    const m = await mountWithAuthGateBoundary({ fetchImpl })
    await waitForCondition(() => titleInput() !== null)
    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    await waitForCondition(() => !submitButton().disabled)
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
      await flush()
    })
    await waitForCondition(() => document.querySelector('input[aria-label="Bearer token"]') !== null)
    expect(document.querySelector('input[aria-label="Bearer token"]')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await m.unmount()
  })
})

describe("StartWorkSheet: metadata reconciliation", () => {
  it("a workflow rename discovered via refetch after unknown_workflow does not erase compatible entered input values", async () => {
    const { act } = await load()
    let workflowCallCount = 0
    const stack = makeStack({
      "/v1/health": () => health(),
      "/v1/projects/workflow": () => {
        workflowCallCount++
        // Renamed on the SECOND fetch (post-refetch); same `feature`
        // input definition (still required string) survives.
        return workflowCallCount === 1
          ? workflow({ name: "old-name", inputs: { feature: { type: "string", presence: "required" } } })
          : workflow({ name: "new-name", inputs: { feature: { type: "string", presence: "required" } } })
      },
      "/v1/features": call =>
        call.method === "POST"
          ? new Response(JSON.stringify({ error: { code: "unknown_workflow", message: 'unknown workflow "old-name"', requestId: "r-1" } }), {
              status: 422,
              headers: { "content-type": "application/json" },
            })
          : { features: [] },
    })
    const m = await mountSheet(stack, () => {})
    await waitForCondition(() => titleInput() !== null)
    await waitForCondition(() => workflowCallCount > 0)
    await act(async () => {
      setValue(titleInput(), "Add dark mode")
    })
    const featureInput = document.querySelector("fieldset input[type=text]") as HTMLInputElement | null
    expect(featureInput).not.toBeNull()
    await act(async () => {
      setValue(featureInput!, "auth")
    })
    await waitForCondition(() => !submitButton().disabled)

    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
    })
    await waitForCondition(() => workflowCallCount > 1)
    await flush()

    // The rename resolved and the SAME-type `feature` input's entered
    // value ("auth") must have survived the reconciliation — not been
    // wiped back to "" the way an unconditional reset would.
    const featureInputAfter = document.querySelector("fieldset input[type=text]") as HTMLInputElement | null
    expect(featureInputAfter?.value).toBe("auth")
    expect(titleInput().value).toBe("Add dark mode")

    await m.unmount()
  })
})
