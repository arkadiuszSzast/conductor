import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { LegacyEngine, type LegacyEngineDeps } from "./src/legacy/engine.ts"
import { interpretLegacy } from "./src/legacy/interpret.ts"
import type { LegacyGh, LegacyCheckSummary, LegacyPrView, LegacyPublishReview, LegacySessionClient, ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/legacy/ports.ts"
import type { LegacyConfig, LegacyPipelineDef } from "./src/legacy/types.ts"

/** A promise plus its resolve/reject, for tests that need to control interleaving explicitly. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------- fakes

class FakeGh implements LegacyGh {
  checks: LegacyCheckSummary = { allConcluded: false, anyFailed: false, failedNames: [] }
  view: LegacyPrView = { number: 7, headSha: "sha-1", state: "OPEN", mergeable: "MERGEABLE" }
  merged: number[] = []
  async prChecks(): Promise<LegacyCheckSummary> {
    return this.checks
  }
  async prView(): Promise<LegacyPrView> {
    return this.view
  }
  async prCreate(): Promise<number> {
    return 7
  }
  async prMerge(_repo: string, pr: number): Promise<void> {
    this.merged.push(pr)
    this.view = { ...this.view, state: "MERGED" }
  }
  async unresolvedThreadCount(): Promise<number> {
    return 0
  }
  async unresolvedThreads() {
    return []
  }
  async resolveThread(): Promise<void> {}
  async replyToThread(): Promise<void> {}
  async reviewActivitySince(): Promise<number> {
    return 0
  }
  async postComment() {
    return { ok: true as const }
  }
  async postReview() {
    return { ok: true as const }
  }
}

class FakeSessions implements LegacySessionClient {
  prompts: Array<{ sessionID: string; text: string; agent?: string; model?: string }> = []
  created: string[] = []
  parents = new Map<string, string>()
  liveSessions = new Set<string>()
  statuses = new Map<string, "busy" | "idle" | "retry">()
  notes: Array<{ sessionID: string; text: string }> = []
  private counter = 0
  /**
   * When set, the NEXT `createSession` call awaits this before resolving,
   * then consumes (nulls) it — lets a test pause `executeAgent` mid-setup
   * to deterministically interleave a concurrent `reconcile()` cycle.
   * `onCreatePause` fires synchronously right before the await, so a test
   * can await it instead of guessing a microtask-tick count.
   */
  nextCreatePause: Promise<void> | null = null
  onCreatePause?: () => void

  async createSession(input: { title: string; directory: string; parentID?: string }): Promise<{ id: string }> {
    if (this.nextCreatePause) {
      const pause = this.nextCreatePause
      this.nextCreatePause = null
      this.onCreatePause?.()
      await pause
    }
    const id = `ses-${++this.counter}`
    this.created.push(id)
    this.liveSessions.add(id)
    if (input.parentID !== undefined) this.parents.set(id, input.parentID)
    return { id }
  }
  async prompt(input: { sessionID: string; text: string; agent?: string; model?: string }): Promise<void> {
    this.prompts.push(input)
  }
  async note(input: { sessionID: string; text: string }): Promise<void> {
    this.notes.push(input)
  }
  async sessionExists(sessionID: string): Promise<boolean> {
    return this.liveSessions.has(sessionID)
  }
  async status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing"> {
    if (!this.liveSessions.has(sessionID)) return "missing"
    return this.statuses.get(sessionID) ?? "busy"
  }
}

class FakeProcess implements ProcessRunner {
  async exec(_command: readonly string[], _options: ProcessExecOptions): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
  async shell(_command: string, _options: ProcessExecOptions): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
}

class FakeClock {
  // Starts from the real clock: `Store.startRun` timestamps run through
  // real `Date.now()` (persistence isn't clock-injected in this legacy
  // compatibility layer), so the engine's injected clock must be
  // comparable to those timestamps — only its forward *advance* is faked.
  current = Date.now()
  now(): number {
    return this.current
  }
  advance(ms: number): void {
    this.current += ms
  }
}

/** A minimal review pipeline: await_ci (builtin, polls) → external_review (agent) → merge (human gate). */
const def: LegacyPipelineDef = {
  roles: {
    reviewer_external: { agent: "review-agent", model: "prov/review" },
    fixer: { agent: "fix-agent", model: "prov/impl" },
  },
  pipeline: [
    { id: "await_ci", type: "builtin", action: "pr.await_checks", then: "external_review", on_fail: { goto: "fix_ci" } },
    { id: "fix_ci", type: "agent", role: "fixer", then: "await_ci" },
    {
      id: "external_review",
      type: "agent",
      role: "reviewer_external",
      then: "merge",
      on_verdict: { approved: { next: true }, changes_requested: { goto: "external_review" } },
      publish: { mode: "comment-only" },
    },
    { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
  ],
}

function makeConfig(over: Partial<LegacyConfig> = {}): LegacyConfig {
  return {
    pipeline: def.pipeline,
    roles: def.roles,
    resolvedWorkflows: {},
    repo: "owner/repo",
    baseBranch: "main",
    runTtlMs: 3_600_000,
    nudgeIdleCycles: 2,
    maxNudges: 2,
    ...over,
  }
}

let directory: string
let connection: DatabaseConnection
let store: Store
let gh: FakeGh
let sessions: FakeSessions
let process_: FakeProcess
let clock: FakeClock

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-legacy-engine-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
  gh = new FakeGh()
  sessions = new FakeSessions()
  process_ = new FakeProcess()
  clock = new FakeClock()
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function makeEngine(config: LegacyConfig, overrides: Partial<LegacyEngineDeps> = {}): LegacyEngine {
  return new LegacyEngine({
    store,
    resolveConfig: () => config,
    gh,
    sessions,
    process: process_,
    clock,
    log: { log: () => {} },
    ...overrides,
  })
}

describe("LegacyEngine: dispatch drives builtin polling into an agent step", () => {
  it("await_ci pending leaves the run open; green CI advances to external_review", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: false, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("await_ci")

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.reconcile()

    const state = store.getFeature(feature.id)
    expect(state?.currentStep).toBe("external_review")
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]?.agent).toBe("review-agent")
  })
})

describe("LegacyEngine: executeAgent claims its run before any await — no reconcile double-dispatch", () => {
  it("a reconcile() interleaved mid-session-setup sees the claimed run and does not re-execute", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }

    const pause = deferred<void>()
    const reached = deferred<void>()
    sessions.nextCreatePause = pause.promise
    sessions.onCreatePause = () => reached.resolve()

    // dispatch(feature.start) walks await_ci → external_review (agent) in
    // one synchronous call chain; executeAgent's FIRST createSession call
    // (the parent session) is where it now blocks.
    const dispatchPromise = engine.dispatch(feature.id, { kind: "feature.start" })
    await reached.promise

    // `store.startRun` for the "external_review" agent step already ran
    // (synchronously, before the paused await) — reconcile must see it as
    // the active run and do nothing, not treat "no session id yet" as
    // "no run for this step" and re-execute.
    const activeDuringPause = store.getActiveRun(feature.id)
    expect(activeDuringPause?.stepId).toBe("external_review")
    expect(activeDuringPause?.sessionId).toBeNull()

    await engine.reconcile()
    expect(sessions.created).toHaveLength(0) // still blocked on the very first createSession call
    expect(sessions.prompts).toHaveLength(0)

    pause.resolve()
    await dispatchPromise

    // Exactly one session pair (parent + child) and one prompt — the race
    // window did not produce a duplicate run/session for the same step.
    expect(sessions.created).toHaveLength(2)
    expect(sessions.prompts).toHaveLength(1)
    const active = store.getActiveRun(feature.id)
    expect(active?.stepId).toBe("external_review")
    expect(active?.sessionId).toBe(sessions.created[1])
  })

  it("does not prompt stale session setup after TTL recovery owns the retry", async () => {
    const config = makeConfig({ runTtlMs: 1 })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    const pause = deferred<void>()
    const paused = deferred<void>()
    sessions.nextCreatePause = pause.promise
    sessions.onCreatePause = () => paused.resolve()

    const dispatchPromise = engine.dispatch(feature.id, { kind: "feature.start" })
    await paused.promise
    const original = store.getActiveRun(feature.id)
    if (!original) throw new Error("missing claimed run")
    clock.current = original.timeStarted + 5

    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(1)
    const retry = store.getActiveRun(feature.id)
    expect(retry?.id).not.toBe(original.id)

    pause.resolve()
    await dispatchPromise
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]?.sessionID).toBe(retry?.sessionId ?? undefined)
    expect(store.getFeature(feature.id)?.sessionId).toBe(sessions.parents.get(retry?.sessionId ?? ""))
  })
})

describe("LegacyEngine: durable action recovery", () => {
  it("replays a persisted same-step verdict decision once after restart", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })

    const run = store.getActiveRun(feature.id)
    const state = store.getFeature(feature.id)
    if (!run || !state) throw new Error("missing active review run")
    const event = { kind: "step.verdict", stepId: "external_review", verdict: "changes_requested" } as const
    const transition = interpretLegacy(def, state, event)
    expect(store.concludeRun(run.id, "succeeded", { output: "changes requested" }, event, transition)).toBe(true)
    expect(store.getPendingRunAction(feature.id)?.decision).toEqual({ kind: "execute", stepId: "external_review" })

    const restarted = makeEngine(config)
    await restarted.reconcile()
    expect(store.getActiveRun(feature.id)?.stepId).toBe("external_review")
    expect(store.getPendingRunAction(feature.id)).toBeNull()
    const promptCount = sessions.prompts.length

    await restarted.reconcile()
    expect(sessions.prompts).toHaveLength(promptCount)
  })
})

describe("LegacyEngine: report — explicit-report-only completion", () => {
  it("verdict report advances via on_verdict and records findings as DB source of truth", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })

    const run = store.getActiveRun(feature.id)
    expect(run).not.toBeNull()
    const notes = '{"summary":"one nit","findings":[{"path":"a.ts","line":1,"body":"nit","severity":"nit"}]}'
    const reply = await engine.report({ runId: run?.id ?? "", verdict: "changes_requested", notes })
    expect(reply).toContain("changes_requested")
    expect(store.listFindings(feature.id)).toHaveLength(1)
    // changes_requested loops back to external_review (same step, fresh child session)
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")
  })

  it("duplicate/late report on an already-concluded run is a no-op reply, not an error", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    const runId = run?.id ?? ""

    await engine.report({ runId, verdict: "approved" })
    const secondReply = await engine.report({ runId, verdict: "approved" })
    expect(secondReply).toContain("already concluded")
  })

  it("unknown run_id reports a readable error instead of throwing", async () => {
    const engine = makeEngine(makeConfig())
    const reply = await engine.report({ runId: "does-not-exist", outcome: "succeeded" })
    expect(reply).toContain("Unknown run_id")
  })

  it("atomic report: feature transition is durable before publish resolves; next agent dispatch waits for it", async () => {
    let publishReached = false
    const publishGate = deferred<string>()
    const publishReview: LegacyPublishReview = async () => {
      publishReached = true
      return publishGate.promise
    }
    const config = makeConfig()
    const engine = makeEngine(config, { publishReview })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    expect(run).not.toBeNull()
    const runId = run?.id ?? ""
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.created).toHaveLength(2) // parent + first child session

    const notes = '{"summary":"one nit","findings":[{"path":"a.ts","line":1,"body":"nit","severity":"nit"}]}'
    const reportPromise = engine.report({ runId, verdict: "changes_requested", notes })

    // Let report() run its synchronous prefix (atomic conclude+transition,
    // finding insert) up to the point it blocks on the injected publisher.
    while (!publishReached) await Promise.resolve()

    // The run conclusion and feature transition are ALREADY durable —
    // this is the crash-recovery property: if the process died right
    // here (mid-publish network call), the feature would still have
    // advanced. The old ordering applied the transition only AFTER
    // publish, leaving a stuck feature on a crash in this exact window.
    expect(store.getRunById(runId)).toMatchObject({ status: "succeeded" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")
    expect(store.listFindings(feature.id)).toHaveLength(1)

    // But acting on the decision (dispatching the retried agent step) has
    // NOT happened yet — no new session/prompt until publish resolves.
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.created).toHaveLength(2)

    publishGate.resolve("publish: comment posted")
    const reply = await reportPromise
    expect(reply).toContain("changes_requested")

    // Now the next agent dispatch has happened, after publish.
    expect(sessions.prompts).toHaveLength(2)
    expect(sessions.created).toHaveLength(3)
  })

  it("concurrent duplicate verdict reports (Promise.all) claim exactly once: one finding, one publish, one transition", async () => {
    let publishCalls = 0
    const publishReview: LegacyPublishReview = async () => {
      publishCalls++
      return "publish: comment posted"
    }
    const config = makeConfig()
    const engine = makeEngine(config, { publishReview })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    const runId = run?.id ?? ""
    const transitionsBefore = store.getTransitions(feature.id).length

    const notes = '{"summary":"one nit","findings":[{"path":"a.ts","line":1,"body":"nit","severity":"nit"}]}'
    const [first, second] = await Promise.all([
      engine.report({ runId, verdict: "changes_requested", notes }),
      engine.report({ runId, verdict: "changes_requested", notes }),
    ])
    const replies = [first, second]
    expect(replies.filter(r => r.includes("already concluded"))).toHaveLength(1)
    expect(replies.filter(r => r.includes("changes_requested"))).toHaveLength(1)
    expect(store.listFindings(feature.id)).toHaveLength(1)
    expect(publishCalls).toBe(1)
    expect(store.getTransitions(feature.id)).toHaveLength(transitionsBefore + 1)
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")
  })
})

describe("LegacyEngine: human gates", () => {
  it("approve executes the gated step; requestChanges without on_reject escalates", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved" })
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")

    const reply = await engine.approve(feature.id, "ship it")
    expect(reply).toContain("Approved")
    expect(gh.merged).toEqual([7])
    expect(store.getFeature(feature.id)?.status).toBe("done")
  })

  it("requestChanges on a merge gate with no on_reject escalates", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved" })

    const reply = await engine.requestChanges(feature.id, "not ready")
    expect(reply).toContain("Changes requested")
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("LegacyEngine: reaper — TTL and idle/nudge/missing-session behaviour", () => {
  async function startReview(over: Partial<LegacyConfig> = {}) {
    const config = makeConfig(over)
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    if (!run?.sessionId) throw new Error("no active agent run")
    clock.current = run.timeStarted
    return { engine, feature, run, sessionId: run.sessionId }
  }

  it("reaps a run that exceeded TTL and burns a retry attempt", async () => {
    const { engine, feature } = await startReview({ runTtlMs: 1 })
    expect(store.getActiveRun(feature.id)).not.toBeNull()

    clock.advance(5)
    await engine.reconcile()

    const state = store.getFeature(feature.id)
    expect(state?.attempts["external_review"]).toBe(1)
    expect(sessions.prompts.length).toBe(2) // original + retry
  })

  it("busy session is never nudged", async () => {
    const { engine, feature } = await startReview()
    await engine.reconcile()
    await engine.reconcile()
    expect(sessions.prompts.length).toBe(1)
    expect(store.getActiveRun(feature.id)).not.toBeNull()
  })

  it("idle session gets nudged at most maxNudges times, then reaped", async () => {
    const { engine, feature, run, sessionId } = await startReview()
    sessions.statuses.set(sessionId, "idle")

    await engine.reconcile() // idle cycle 1 — debounce, no nudge
    expect(sessions.prompts.length).toBe(1)
    await engine.reconcile() // idle cycle 2 — nudge #1
    expect(sessions.prompts.length).toBe(2)
    expect(sessions.prompts[1]?.sessionID).toBe(sessionId)
    expect(sessions.prompts[1]?.text).toContain(`run_id="${run.id}"`)

    await engine.reconcile() // idle 1
    await engine.reconcile() // idle 2 → nudge #2 (maxNudges reached)
    expect(sessions.prompts.length).toBe(3)

    await engine.reconcile() // idle 1
    await engine.reconcile() // idle 2 → budget exhausted → reap → retry
    const state = store.getFeature(feature.id)
    expect(state?.attempts["external_review"]).toBe(1)
    expect(sessions.prompts.length).toBe(4)
    expect(sessions.prompts[3]?.sessionID).not.toBe(sessionId)
  })

  it("missing session is reaped immediately without waiting for the idle debounce or TTL", async () => {
    const { engine, feature, sessionId } = await startReview({ runTtlMs: 3_600_000 })
    sessions.liveSessions.delete(sessionId)
    await engine.reconcile()
    const state = store.getFeature(feature.id)
    expect(state?.attempts["external_review"]).toBe(1)
  })

  it("a report between cycles clears the run before any nudge fires", async () => {
    const { engine, feature, run, sessionId } = await startReview()
    sessions.statuses.set(sessionId, "idle")
    await engine.reconcile() // idle cycle 1
    await engine.report({ runId: run.id, verdict: "approved" })
    await engine.reconcile()
    expect(sessions.prompts.length).toBe(1) // no nudge ever sent
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
  })
})

describe("LegacyEngine: escalation when a step vanishes from a live pipeline", () => {
  it("act() escalates loudly instead of soft-bricking the feature", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.applyTransition(
      feature.id,
      { kind: "feature.start" },
      { decision: { kind: "execute", stepId: "ghost-step" }, patch: { status: "running", currentStep: "ghost-step" } },
    )
    await engine["act"](feature.id, { kind: "execute", stepId: "ghost-step" })
    const state = store.getFeature(feature.id)
    expect(state?.status).toBe("escalated")
    expect(state?.escalation).toContain("ghost-step")
  })
})
