/**
 * `RecoverySheet` mounted tests for execution-uncertain targets: the sheet
 * must ask for the acknowledgement (and cleanup attestation) the server
 * requires, send them, and never mislabel the server's demand for them as
 * a stale view. Requires `NODE_ENV=development` (`bun run test:mounted`),
 * see `test/dom-env.ts` — components are imported dynamically per test.
 */
import { describe as describeBase, expect, it } from "bun:test"
import { mountedTestsSupported, useDomEnv, flush } from "./dom-env.ts"
import type { FeatureDetailResponse, RecoverableTarget } from "../src/api/types.ts"
import type { FetchLike } from "../src/api/client.ts"

const { load } = useDomEnv()
const describe = describeBase.skipIf(!mountedTestsSupported)

function detail(targets: readonly RecoverableTarget[]): FeatureDetailResponse {
  return {
    feature: {
      id: "f1",
      title: "Add Leaderboards",
      slug: "f1",
      projectDir: "/proj/app",
      workflow: "delivery",
      description: null,
      status: "escalated",
      sessionId: null,
      worktree: null,
      branch: null,
      pr: null,
      escalation: null,
      currentStep: "implement",
      createdAt: 1,
      updatedAt: 7,
      findingCounts: { new: 0, fixed: 0, dismissed: 0, reopened: 0 },
      workflowRef: { name: "delivery", stale: false },
      feedback: null,
      jobs: {},
      recoverableTargets: targets,
    },
    activeRun: null,
  }
}

interface Call {
  readonly path: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}

function makeFetch(targets: readonly RecoverableTarget[], recover: (call: Call) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    const call: Call = { path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }
    calls.push(call)
    if (path.endsWith("/recover")) return recover(call)
    if (path.startsWith("/v1/features/f1")) return Response.json(detail(targets))
    return Response.json({ error: { code: "not_found", message: "no route", requestId: "r" } }, { status: 404 })
  }) as FetchLike
  return { fetchImpl, calls }
}

const ok = (): Response => Response.json({ result: "Recovered.", ...detail([]) })

async function mount(fetchImpl: FetchLike): Promise<{ unmount: () => Promise<void>; closed: () => number }> {
  const { React, act, createRoot } = await load()
  const { AppContext } = await import("../src/app-context.ts")
  const { RecoverySheet } = await import("../src/feature/recovery-sheet.tsx")
  const { ApiClient } = await import("../src/api/client.ts")
  const { DataSource } = await import("../src/api/store.ts")
  const { AuthSession } = await import("../src/auth/auth-store.ts")
  const client = new ApiClient({ token: () => "tok", fetch: fetchImpl })
  const store = new DataSource({ client, setTimeoutFn: fn => setTimeout(fn, 0), clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>) })
  const session = new AuthSession({ storage: { get: () => null, set: () => {} }, probe: async () => 200 })
  session.status = "authenticated"
  let closes = 0
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      React.createElement(AppContext.Provider, { value: { session, client, store } },
        React.createElement(RecoverySheet, { featureId: "f1", onClose: () => closes++ })),
    )
    await flush()
  })
  return {
    closed: () => closes,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

async function settle(check: () => boolean): Promise<void> {
  const { act } = await load()
  await act(async () => {
    for (let i = 0; i < 30 && !check(); i++) await flush()
  })
}

function setNotes(value: string): void {
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

function confirmBoxes(): HTMLInputElement[] {
  return [...document.querySelectorAll('[aria-label="uncertain execution"] input[type="checkbox"]')] as HTMLInputElement[]
}

function submitButton(): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("recover")) as HTMLButtonElement
}

async function click(el: HTMLElement): Promise<void> {
  const { act } = await load()
  await act(async () => {
    el.click()
    await flush()
  })
}

describe("RecoverySheet: execution-uncertain targets", () => {
  it("requires acknowledgement and cleanup attestation for a fenced target, then sends both", async () => {
    const { fetchImpl, calls } = makeFetch([{ jobId: "main", stepId: "implement", uncertain: { cleanupAttestationRequired: true } }], ok)
    const sheet = await mount(fetchImpl)
    await settle(() => document.querySelector("textarea") !== null && confirmBoxes().length > 0)
    const { act } = await load()
    await act(async () => setNotes("verified the old runner is gone"))

    expect(confirmBoxes()).toHaveLength(2)
    expect(submitButton().disabled).toBe(true)
    await click(confirmBoxes()[0]!)
    expect(submitButton().disabled).toBe(true)
    await click(confirmBoxes()[1]!)
    expect(submitButton().disabled).toBe(false)

    await click(submitButton())
    await settle(() => sheet.closed() > 0)
    const recover = calls.find(call => call.path.endsWith("/recover"))!
    expect(recover.body).toMatchObject({ acknowledgeUncertain: true, cleanupAttested: true, expectedVersion: 7 })
    expect(typeof recover.body?.["idempotencyKey"]).toBe("string")
    await sheet.unmount()
  })

  it("an uncertainty_required rejection asks for confirmation instead of claiming the view went stale", async () => {
    let attempts = 0
    const { fetchImpl, calls } = makeFetch([{ jobId: "main", stepId: "implement" }], () => {
      attempts++
      return attempts === 1
        ? Response.json({ error: { code: "uncertainty_required", message: "Uncertain execution requires acknowledgeUncertain", requestId: "r" } }, { status: 409 })
        : ok()
    })
    const sheet = await mount(fetchImpl)
    await settle(() => document.querySelector("textarea") !== null)
    const { act } = await load()
    await act(async () => setNotes("retry"))
    await click(submitButton())
    await settle(() => confirmBoxes().length > 0)

    expect(document.body.textContent).not.toContain("state changed since this sheet opened")
    expect(confirmBoxes()).toHaveLength(2)
    for (const box of confirmBoxes()) await click(box)
    await click(submitButton())
    await settle(() => sheet.closed() > 0)
    const recovers = calls.filter(call => call.path.endsWith("/recover"))
    expect(recovers).toHaveLength(2)
    expect(recovers[1]!.body).toMatchObject({ acknowledgeUncertain: true, cleanupAttested: true })
    expect(recovers[1]!.body?.["idempotencyKey"]).toBe(recovers[0]!.body?.["idempotencyKey"])
    await sheet.unmount()
  })
})
