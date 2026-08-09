import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { Engine, type EngineDeps } from "./src/engine/engine.ts"
import { interpret } from "./src/engine/interpret.ts"
import type { GhClient, CheckSummary, PrView, PublishReview, SessionClient, ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/engine/ports.ts"
import type { EngineConfig, PipelineDef } from "./src/engine/types.ts"

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

class FakeGh implements GhClient {
  checks: CheckSummary = { allConcluded: false, anyFailed: false, failedNames: [] }
  view: PrView = { number: 7, headSha: "sha-1", state: "OPEN", mergeable: "MERGEABLE" }
  merged: number[] = []
  threads: Array<{ id: string; openedBy: string; firstCommentBody: string; lastReplyBy: string; lastReplyBody: string; path: string }> = []
  resolvedThreads: string[] = []
  threadReplies: Array<{ threadId: string; body: string }> = []
  async prChecks(): Promise<CheckSummary> {
    return this.checks
  }
  async prView(): Promise<PrView> {
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
    return this.threads
  }
  async resolveThread(threadId: string): Promise<void> {
    this.resolvedThreads.push(threadId)
    this.threads = this.threads.filter(t => t.id !== threadId)
  }
  async replyToThread(threadId: string, body: string): Promise<void> {
    this.threadReplies.push({ threadId, body })
  }
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

class FakeSessions implements SessionClient {
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
  // real `Date.now()` (persistence isn't clock-injected in this
  // seed-compatibility layer), so the engine's injected clock must be
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
const def: PipelineDef = {
  roles: {
    reviewer_external: { agent: "review-agent", model: "prov/review" },
    fixer: { agent: "fix-agent", model: "prov/impl" },
  },
  pipeline: [
    { id: "await_ci", type: "builtin", action: "pr.await_checks", then: "external_review", on_fail: { goto: "fix_ci" } },
    { id: "fix_ci", type: "agent", role: "fixer", prompt: "CI is red:\n{{steps.await_ci.output}}", then: "await_ci" },
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

function makeConfig(over: Partial<EngineConfig> = {}): EngineConfig {
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
  directory = mkdtempSync(join(tmpdir(), "conductor-engine-"))
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

function makeEngine(config: EngineConfig, overrides: Partial<EngineDeps> = {}): Engine {
  return new Engine({
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

describe("Engine: dispatch drives builtin polling into an agent step", () => {
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
    expect(sessions.prompts[0]?.model).toBe("prov/review")
    expect(sessions.prompts[0]?.text).toContain("MUST report")
    expect(sessions.prompts[0]?.text).toContain("run_id=")
  })

  it("routes red CI to the fixer with a different agent/model than review", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: true, failedNames: ["Backend Quality"] }
    await engine.dispatch(feature.id, { kind: "feature.start" })

    expect(store.getFeature(feature.id)?.currentStep).toBe("fix_ci")
    expect(sessions.prompts[0]?.agent).toBe("fix-agent")
    expect(sessions.prompts[0]?.model).toBe("prov/impl")
    expect(sessions.prompts[0]?.text).toContain("Backend Quality")
  })

  it("changes_requested loops to fix_review and escalates after max_rounds", async () => {
    const pipeline: PipelineDef["pipeline"] = [
      { id: "await_ci", type: "builtin", action: "pr.await_checks", then: "external_review" },
      {
        id: "external_review",
        type: "agent",
        role: "reviewer_external",
        rounds_with: "fix_review",
        max_rounds: 3,
        on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
      },
      { id: "fix_review", type: "agent", role: "fixer", then: "await_ci" },
      { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
    ]
    const engine = makeEngine(makeConfig({ pipeline }))
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }

    await engine.dispatch(feature.id, { kind: "feature.start" })
    let run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "changes_requested" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("fix_review")

    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")

    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "changes_requested" })
    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")

    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "changes_requested" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("Engine: executeAgent claims its run before any await — no reconcile double-dispatch", () => {
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

describe("Engine: durable action recovery", () => {
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
    const transition = interpret(def, state, event)
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

describe("Engine: report — explicit-report-only completion", () => {
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
    const publishReached = deferred<void>()
    const publishGate = deferred<string>()
    const publishReview: PublishReview = async () => {
      publishReached.resolve()
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
    await publishReached.promise

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
    const publishReview: PublishReview = async () => {
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

describe("Engine: human gates", () => {
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

describe("Engine: reaper — TTL and idle/nudge/missing-session behaviour", () => {
  async function startReview(over: Partial<EngineConfig> = {}) {
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

  it("maxNudges=0 disables nudging — idle goes straight to reap", async () => {
    const { engine, feature, sessionId } = await startReview({ maxNudges: 0 })
    sessions.statuses.set(sessionId, "idle")
    await engine.reconcile()
    await engine.reconcile()
    const state = store.getFeature(feature.id)
    expect(state?.attempts["external_review"]).toBe(1)
    expect(sessions.prompts.filter(p => p.sessionID === sessionId).length).toBe(1)
  })
})

describe("Engine: stale reports", () => {
  it("a report for a superseded run is rejected politely", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved" })

    const reply = await engine.report({ runId: run?.id ?? "", verdict: "approved" })
    expect(reply).toContain("already concluded")
  })
})

describe("Engine: session lifecycle", () => {
  it("fresh mode (default): child session per step run under one feature parent", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: true, failedNames: ["gate"] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(sessions.created).toHaveLength(2)
    const parent = sessions.created[0] ?? ""
    expect(store.getFeature(feature.id)?.sessionId).toBe(parent)
    expect(sessions.prompts[0]?.sessionID).toBe(sessions.created[1] ?? "")
    expect(sessions.parents.get(sessions.created[1] ?? "")).toBe(parent)

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    let run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")
    expect(sessions.created).toHaveLength(3)
    expect(sessions.prompts[1]?.sessionID).toBe(sessions.created[2] ?? "")
    expect(sessions.parents.get(sessions.created[2] ?? "")).toBe(parent)
    expect(store.getFeature(feature.id)?.sessionId).toBe(parent)

    sessions.liveSessions.clear()
    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "changes_requested" })
    expect(sessions.created).toHaveLength(5)
    const newParent = sessions.created[3] ?? ""
    expect(store.getFeature(feature.id)?.sessionId).toBe(newParent)
    expect(sessions.parents.get(sessions.created[4] ?? "")).toBe(newParent)
  })

  it("adopted session (conductor_start caller) becomes the parent — no separate anchor created", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    const userSession = await sessions.createSession({ title: "user session", directory: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7, sessionId: userSession.id })
    const createdBefore = sessions.created.length

    gh.checks = { allConcluded: true, anyFailed: true, failedNames: ["gate"] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.sessionId).toBe(userSession.id)
    expect(sessions.created).toHaveLength(createdBefore + 1)
    const child = sessions.created[sessions.created.length - 1] ?? ""
    expect(sessions.parents.get(child)).toBe(userSession.id)
    expect(sessions.notes[0]?.sessionID).toBe(userSession.id)
  })

  it("parent session receives timeline notes (dispatch + report), children get none", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: true, failedNames: ["gate"] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const parent = sessions.created[0] ?? ""
    expect(sessions.notes).toHaveLength(1)
    expect(sessions.notes[0]?.sessionID).toBe(parent)
    expect(sessions.notes[0]?.text).toContain("▶ fix_ci")
    expect(sessions.notes[0]?.text).toContain("fix-agent")

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded", notes: "Fixed flaky gate test" })
    const parentNotes = sessions.notes.filter(n => n.sessionID === parent)
    expect(parentNotes).toHaveLength(sessions.notes.length)
    const reportNote = sessions.notes.find(n => n.text.includes("fixer"))
    expect(reportNote?.text).toContain("succeeded")
    expect(reportNote?.text).toContain("Fixed flaky gate test")

    const reviewRun = store.getActiveRun(feature.id)
    await engine.report({ runId: reviewRun?.id ?? "", verdict: "approved", notes: "LGTM" })
    const verdictNote = sessions.notes.find(n => n.text.includes("verdict"))
    expect(verdictNote?.text).toContain("reviewer_external")
    expect(verdictNote?.text).toContain("approved")
  })

  it("timeline note failure never breaks the pipeline", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    sessions.note = async () => {
      throw new Error("boom")
    }

    gh.checks = { allConcluded: true, anyFailed: true, failedNames: ["gate"] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.status).not.toBe("escalated")
  })

  it("feature mode: role opts into the shared long-lived session", async () => {
    const config = makeConfig({
      roles: {
        ...def.roles,
        fixer: { agent: "fix-agent", model: "prov/impl", session: "feature" },
      },
    })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: true, failedNames: ["gate"] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(sessions.created).toHaveLength(1)
    const parent = sessions.created[0] ?? ""
    expect(sessions.prompts[0]?.sessionID).toBe(parent)

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(sessions.created).toHaveLength(2)
    expect(sessions.prompts[1]?.sessionID).toBe(sessions.created[1] ?? "")
    expect(sessions.parents.get(sessions.created[1] ?? "")).toBe(parent)
  })
})

describe("Engine: multi-project daemon", () => {
  it("one engine drives two projects, each under its own config", async () => {
    const configA = makeConfig({ runTtlMs: 1 })
    const configB = makeConfig({ runTtlMs: 3_600_000 })
    const byDir: Record<string, EngineConfig> = {
      "/tmp/project-a": configA,
      "/tmp/project-b": configB,
    }
    const engine = new Engine({
      store,
      resolveConfig: dir => byDir[dir] ?? null,
      gh,
      sessions,
      process: process_,
      clock,
      log: { log: () => {} },
    })

    const featA = store.createFeature({ title: "A", slug: "a", projectDir: "/tmp/project-a" })
    store.setFeatureFields(featA.id, { pr: 7 })
    const featB = store.createFeature({ title: "B", slug: "b", projectDir: "/tmp/project-b" })
    store.setFeatureFields(featB.id, { pr: 8 })

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(featA.id, { kind: "feature.start" })
    await engine.dispatch(featB.id, { kind: "feature.start" })
    expect(store.getActiveRun(featA.id)).not.toBeNull()
    expect(store.getActiveRun(featB.id)).not.toBeNull()

    const runA = store.getActiveRun(featA.id)
    clock.current = (runA?.timeStarted ?? clock.current) + 5
    await engine.reconcile()
    expect(store.getFeature(featA.id)?.attempts["external_review"]).toBe(1)
    expect(store.getFeature(featB.id)?.attempts["external_review"]).toBeUndefined()
    expect(store.getActiveRun(featB.id)).not.toBeNull()
  })

  it("features from a project with no resolvable config are skipped, not broken", async () => {
    const config = makeConfig({ runTtlMs: 1 })
    const orphan = store.createFeature({ title: "O", slug: "o", projectDir: "/tmp/unknown" })
    store.setFeatureFields(orphan.id, { pr: 9 })
    const orphanEngine = new Engine({
      store,
      resolveConfig: dir => (dir === "/tmp/p" ? config : null),
      gh,
      sessions,
      process: process_,
      clock,
      log: { log: () => {} },
    })
    await orphanEngine.dispatch(orphan.id, { kind: "feature.start" })
    expect(store.getFeature(orphan.id)?.currentStep).toBeNull()
    await orphanEngine.reconcile()
    expect(store.getFeature(orphan.id)?.status).toBe("running")
    expect(store.getActiveRun(orphan.id)).toBeNull()
  })
})

describe("Engine: named workflows", () => {
  const bugfixPipeline: PipelineDef["pipeline"] = [
    { id: "reproduce", type: "agent", role: "fixer", prompt: "Reproduce: {{feature.title}}. Report via conductor_report." },
    { id: "merge", type: "builtin", action: "pr.merge" },
  ]

  it("a feature started under a named workflow runs that pipeline, not the default", async () => {
    const config = makeConfig({ resolvedWorkflows: { bugfix: bugfixPipeline } })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "B", slug: "b", projectDir: "/tmp/p", workflow: "bugfix" })
    store.setFeatureFields(feature.id, { pr: 7 })

    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("reproduce")
    expect(sessions.prompts[0]?.text).toContain("Reproduce")

    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(gh.merged).toEqual([7])
    expect(store.getFeature(feature.id)?.status).toBe("done")
  })

  it("a feature with an unknown workflow is skipped, never run under the default", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "X", slug: "x", projectDir: "/tmp/p", workflow: "no-such-workflow" })
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.currentStep).toBeNull()
    expect(sessions.prompts).toHaveLength(0)
  })
})

describe("Engine: human request-changes at an approval gate", () => {
  it("routes via on_reject, hands the notes to the fixer prompt, and re-reaches the gate", async () => {
    const pipeline: PipelineDef["pipeline"] = def.pipeline.map(step =>
      step.id === "merge"
        ? { ...step, on_reject: { goto: "fix_review" } }
        : step.id === "external_review" && step.type === "agent"
          ? { ...step, on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } } }
          : step,
    ).flatMap(step =>
      step.id === "merge"
        ? [{ id: "fix_review", type: "agent", role: "fixer", prompt: "Human requested: {{steps.merge.output}}", then: "await_ci" } as const, step]
        : [step],
    )
    const engine = makeEngine(makeConfig({ pipeline }))
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    let run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved" })
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")

    const reply = await engine.requestChanges(feature.id, "Rename the endpoint to /todos/archive")
    expect(reply).toContain("fix_review")
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getFeature(feature.id)?.currentStep).toBe("fix_review")
    expect(sessions.prompts[sessions.prompts.length - 1]?.text).toContain("Rename the endpoint to /todos/archive")

    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")
    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved" })
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")
    expect(gh.merged).toEqual([])
  })

  it("request-changes on a non-waiting feature is refused", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    const reply = await engine.requestChanges(feature.id, "nope")
    expect(reply).toContain("not waiting")
  })
})

describe("Engine: human approve-with-notes at an approval gate", () => {
  it("records the notes, proceeds past the gate, and exposes them via getLastHumanNotes", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved" })
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")

    const reply = await engine.approve(feature.id, "Squash-merge please; follow up on naming in a next PR")
    expect(reply).toContain("notes recorded")
    expect(store.getLastHumanNotes(feature.id, "merge")).toContain("Squash-merge please")
    expect(gh.merged).toEqual([7])
    expect(store.getFeature(feature.id)?.status).toBe("done")
  })

  it("plain approve (no notes) records nothing and just proceeds", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 8 })

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved" })

    const reply = await engine.approve(feature.id)
    expect(reply).not.toContain("notes recorded")
    expect(store.getLastHumanNotes(feature.id, "merge")).toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("done")
  })

  it("approve on a non-waiting feature is refused", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    const reply = await engine.approve(feature.id, "notes")
    expect(reply).toContain("not waiting")
  })
})

describe("Engine: feature description", () => {
  const designDef: PipelineDef = {
    pipeline: [{ id: "design", type: "agent", role: "designer", prompt: "Design this:\n{{feature.description}}", then: "done" }],
    roles: { designer: { agent: "designer", model: "m" } },
  }

  it("is stored and exposed to prompts as {{feature.description}}", async () => {
    const config = makeConfig({ pipeline: designDef.pipeline, roles: designDef.roles })
    const engine = makeEngine(config)
    const feature = store.createFeature({
      title: "Fog of war",
      slug: "fog-of-war",
      projectDir: "/tmp/p",
      description: "Players only see discovered map tiles.\nAcceptance: undiscovered tiles render as fog.",
    })
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const prompt = sessions.prompts[sessions.prompts.length - 1]
    expect(prompt?.text).toContain("Players only see discovered map tiles")
  })

  it("falls back to the title when no description was given", async () => {
    const config = makeConfig({ pipeline: designDef.pipeline, roles: designDef.roles })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "Fix typo in README", slug: "fix-typo", projectDir: "/tmp/p" })
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const prompt = sessions.prompts[sessions.prompts.length - 1]
    expect(prompt?.text).toContain("Design this:\nFix typo in README")
  })
})

describe("Engine: conflicting PR branch", () => {
  it("CONFLICTING mergeable fails await_ci and routes to the fixer with rebase instructions", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.view = { number: 7, headSha: "sha-1", state: "OPEN", mergeable: "CONFLICTING" }
    gh.checks = { allConcluded: false, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })

    const state = store.getFeature(feature.id)
    expect(state?.currentStep).toBe("fix_ci")
    expect(sessions.prompts[0]?.text).toContain("CONFLICTING")
    expect(sessions.prompts[0]?.text).toContain("rebase")

    gh.view = { number: 7, headSha: "sha-2", state: "OPEN", mergeable: "MERGEABLE" }
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("external_review")
  })

  it("UNKNOWN mergeable stays pending (GitHub still computing), not failed", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.view = { number: 7, headSha: "sha-1", state: "OPEN", mergeable: "UNKNOWN" }
    gh.checks = { allConcluded: false, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("await_ci")
    expect(sessions.prompts).toHaveLength(0)
  })
})

describe("Engine: review publishing", () => {
  function pipelineWithPublish(): EngineConfig {
    const pipeline: PipelineDef["pipeline"] = def.pipeline.flatMap(step => {
      if (step.id === "external_review" && step.type === "agent") {
        return [{
          ...step,
          prompt: "Review round.\nOpen findings:\n{{findings.open}}",
          publish: { mode: "github-review" },
          on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
        }]
      }
      if (step.id === "merge") {
        return [
          { id: "fix_review", type: "agent", role: "fixer", prompt: "Open findings:\n{{findings.open}}", then: "await_ci" } as const,
          step,
        ]
      }
      return [step]
    })
    return makeConfig({ pipeline, reviewPublish: { tokenCommand: "fake-token-cmd" } })
  }

  it("publishes the review (merged step+config publish def) before the fixer is dispatched", async () => {
    let published: Array<{ mode: string; tokenCommand?: string; pr: number; verdict: string }> = []
    const publishReview: PublishReview = async input => {
      published.push({ mode: input.publish.mode, ...(input.publish.tokenCommand !== undefined ? { tokenCommand: input.publish.tokenCommand } : {}), pr: input.pr, verdict: input.verdict })
      return "publish: review posted (fake)"
    }
    const engine = makeEngine(pipelineWithPublish(), { publishReview })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    const notes = JSON.stringify({ summary: "Needs work", findings: [{ path: "src/todos.ts", line: 12, body: "off-by-one" }] })
    await engine.report({ runId: run?.id ?? "", verdict: "changes_requested", notes })

    expect(published).toHaveLength(1)
    expect(published[0]?.mode).toBe("github-review")
    expect(published[0]?.tokenCommand).toBe("fake-token-cmd")
    expect(published[0]?.pr).toBe(7)
    expect(published[0]?.verdict).toBe("changes_requested")
    expect(store.getFeature(feature.id)?.currentStep).toBe("fix_review")
    const fixerPrompt = sessions.prompts[sessions.prompts.length - 1]
    expect(fixerPrompt?.text).toContain("off-by-one")
  })

  it("approved verdicts publish too; steps without publish do not", async () => {
    let publishCalls = 0
    const publishReview: PublishReview = async () => {
      publishCalls++
      return "publish: comment posted"
    }
    const engine = makeEngine(pipelineWithPublish(), { publishReview })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: true, failedNames: ["gate"] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    let run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(publishCalls).toBe(0)

    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved", notes: '{"summary":"LGTM","findings":[]}' })
    expect(publishCalls).toBe(1)
  })

  it("publish failure never blocks the verdict routing", async () => {
    const publishReview: PublishReview = async () => {
      throw new Error("gh exploded")
    }
    const engine = makeEngine(pipelineWithPublish(), { publishReview })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved", notes: "ok" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
  })
})

describe("Engine: findings lifecycle (DB source of truth)", () => {
  function reviewNotes(findings: Array<{ path: string; line: number; severity?: string; body: string }>): string {
    return JSON.stringify({ summary: "Review summary", findings })
  }

  it("review verdict persists findings; fixer resolutions update them; gate passes when no blocker/major open", async () => {
    const findingsPipeline: PipelineDef = {
      roles: def.roles,
      pipeline: [
        { id: "await_ci", type: "builtin", action: "pr.await_checks", then: "external_review", on_fail: { goto: "fix_ci" } },
        { id: "fix_ci", type: "agent", role: "fixer", then: "await_ci" },
        {
          id: "external_review",
          type: "agent",
          role: "reviewer_external",
          then: "sync_findings",
          on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
        },
        { id: "fix_review", type: "agent", role: "fixer", then: "await_ci" },
        { id: "sync_findings", type: "builtin", action: "findings.sync", then: "check_findings" },
        { id: "check_findings", type: "builtin", action: "findings.check", on_fail: { goto: "fix_review", max_attempts: 3 }, then: "merge" },
        { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
      ],
    }
    const config = makeConfig({ pipeline: findingsPipeline.pipeline, roles: findingsPipeline.roles })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })

    let run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "changes_requested",
      notes: reviewNotes([
        { path: "src/a.ts", line: 10, severity: "major", body: "broken edge case" },
        { path: "src/b.ts", line: 20, severity: "nit", body: "naming taste" },
      ]),
    })
    let findings = store.listFindings(feature.id)
    expect(findings.map(f => [f.id, f.severity, f.status])).toEqual([
      ["F1", "major", "new"],
      ["F2", "nit", "new"],
    ])
    expect(store.getFeature(feature.id)?.currentStep).toBe("fix_review")

    run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      outcome: "succeeded",
      notes: JSON.stringify({
        summary: "done",
        resolutions: [
          { id: "F1", status: "fixed", note: "guarded the edge case" },
          { id: "F2", status: "dismissed", note: "consistent with file style" },
        ],
      }),
    })
    findings = store.listFindings(feature.id)
    expect(findings.map(f => [f.id, f.status])).toEqual([
      ["F1", "fixed"],
      ["F2", "dismissed"],
    ])

    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved", notes: JSON.stringify({ summary: "LGTM", findings: [] }) })

    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
  })

  it("gate blocks on open major but not on open minor/nit", async () => {
    const findingsPipeline: PipelineDef = {
      roles: def.roles,
      pipeline: [
        { id: "await_ci", type: "builtin", action: "pr.await_checks", then: "external_review" },
        {
          id: "external_review",
          type: "agent",
          role: "reviewer_external",
          then: "check_findings",
          on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
        },
        { id: "fix_review", type: "agent", role: "fixer", prompt: "Open findings:\n{{findings.open}}", then: "await_ci" },
        { id: "check_findings", type: "builtin", action: "findings.check", on_fail: { goto: "fix_review", max_attempts: 3 }, then: "merge" },
        { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
      ],
    }
    const engine = makeEngine(makeConfig({ pipeline: findingsPipeline.pipeline, roles: findingsPipeline.roles }))
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })
    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }

    await engine.dispatch(feature.id, { kind: "feature.start" })
    let run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "changes_requested",
      notes: reviewNotes([{ path: "src/a.ts", line: 1, severity: "major", body: "bug" }]),
    })
    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded", notes: "did some work" })
    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved", notes: JSON.stringify({ summary: "ok", findings: [] }) })

    expect(store.getFeature(feature.id)?.currentStep).toBe("fix_review")
    expect(sessions.prompts[sessions.prompts.length - 1]?.text).toContain("F1 [major]")

    run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      outcome: "succeeded",
      notes: JSON.stringify({ summary: "fixed", resolutions: [{ id: "F1", status: "fixed", note: "done" }] }),
    })
    run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "approved",
      notes: reviewNotes([
        { path: "src/b.ts", line: 2, severity: "minor", body: "minor" },
        { path: "src/c.ts", line: 3, severity: "nit", body: "nit" },
      ]),
    })
    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")
  })

  it("findings.sync maps threads via [F<n>] marker and projects resolutions", async () => {
    const findingsPipeline: PipelineDef = {
      roles: def.roles,
      pipeline: [
        { id: "await_ci", type: "builtin", action: "pr.await_checks", then: "external_review", on_fail: { goto: "fix_ci" } },
        { id: "fix_ci", type: "agent", role: "fixer", then: "await_ci" },
        {
          id: "external_review",
          type: "agent",
          role: "reviewer_external",
          then: "sync_findings",
          on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
        },
        { id: "fix_review", type: "agent", role: "fixer", then: "await_ci" },
        { id: "sync_findings", type: "builtin", action: "findings.sync", then: "merge" },
        { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
      ],
    }
    const config = makeConfig({ pipeline: findingsPipeline.pipeline, roles: findingsPipeline.roles })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    gh.checks = { allConcluded: true, anyFailed: false, failedNames: [] }
    await engine.dispatch(feature.id, { kind: "feature.start" })
    let run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "changes_requested",
      notes: reviewNotes([{ path: "src/a.ts", line: 10, severity: "major", body: "bug" }]),
    })
    run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      outcome: "succeeded",
      notes: JSON.stringify({ summary: "fixed", resolutions: [{ id: "F1", status: "fixed", note: "guarded" }] }),
    })

    gh.threads = [{
      id: "THREAD-1",
      openedBy: "bot",
      firstCommentBody: "`F1` **[major]** bug",
      lastReplyBy: "bot",
      lastReplyBody: "`F1` **[major]** bug",
      path: "src/a.ts",
    }]

    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved", notes: JSON.stringify({ summary: "ok", findings: [] }) })

    expect(gh.threadReplies.map(r => r.threadId)).toEqual(["THREAD-1"])
    expect(gh.threadReplies[0]?.body).toContain("F1 fixed")
    expect(gh.threadReplies[0]?.body).toContain("guarded")
    expect(gh.resolvedThreads).toEqual(["THREAD-1"])
    const f1 = store.listFindings(feature.id)[0]
    expect(f1?.threadId).toBe("THREAD-1")
    expect(f1?.synced).toBe(true)
    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")
  })
})

describe("Engine: current step vanished from the pipeline (config changed)", () => {
  it("resume on a feature stuck on a removed step escalates loudly instead of soft-bricking", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    connection.db.run("UPDATE feature SET current_step = 'check_threads', status = 'escalated' WHERE id = ?", [feature.id])

    await engine.dispatch(feature.id, { kind: "human.resumed" })
    const state = store.getFeature(feature.id)
    expect(state?.status).toBe("escalated")
    const transitions = store.getTransitions(feature.id, 3)
    expect(JSON.stringify(transitions)).toContain("no longer exists")
  })

  it("reconcile escalates a running feature whose step vanished (once, via status flip)", async () => {
    const config = makeConfig()
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    connection.db.run("UPDATE feature SET current_step = 'check_threads', status = 'running' WHERE id = ?", [feature.id])

    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("Engine: findings.check polish round", () => {
  const polishPipeline: PipelineDef = {
    roles: def.roles,
    pipeline: [
      {
        id: "external_review",
        type: "agent",
        role: "reviewer_external",
        then: "check_findings",
        on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
      },
      { id: "fix_review", type: "agent", role: "fixer", prompt: "Open findings:\n{{findings.open}}", then: "external_review" },
      { id: "check_findings", type: "builtin", action: "findings.check", on_fail: { goto: "fix_review", max_attempts: 3 }, then: "merge" },
      { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
    ],
  }

  it("approved-with-nits gets one fixer round before the gate relaxes", async () => {
    const config = makeConfig({ pipeline: polishPipeline.pipeline, roles: polishPipeline.roles })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    await engine.dispatch(feature.id, { kind: "feature.start" })

    let run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "approved",
      notes: JSON.stringify({
        summary: "LGTM with nits",
        findings: [
          { path: "src/a.ts", line: 1, severity: "nit", body: "naming" },
          { path: "src/b.ts", line: 2, severity: "minor", body: "missing test" },
        ],
      }),
    })

    expect(store.getFeature(feature.id)?.currentStep).toBe("fix_review")
    const fixerPrompt = sessions.prompts[sessions.prompts.length - 1]
    expect(fixerPrompt?.text).toContain("F1 [nit]")
    expect(fixerPrompt?.text).toContain("F2 [minor]")

    run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      outcome: "succeeded",
      notes: JSON.stringify({
        summary: "polished",
        resolutions: [
          { id: "F1", status: "dismissed", note: "consistent with file style" },
          { id: "F2", status: "fixed", note: "test added" },
        ],
      }),
    })
    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", verdict: "approved", notes: JSON.stringify({ summary: "ok", findings: [] }) })
    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
  })

  it("after the polish round leftover nits do not spin the loop", async () => {
    const config = makeConfig({ pipeline: polishPipeline.pipeline, roles: polishPipeline.roles })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })
    store.setFeatureFields(feature.id, { pr: 7 })

    await engine.dispatch(feature.id, { kind: "feature.start" })
    let run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "approved",
      notes: JSON.stringify({ summary: "nits", findings: [{ path: "a.ts", line: 1, severity: "nit", body: "taste" }] }),
    })
    run = store.getActiveRun(feature.id)
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded", notes: "did nothing" })
    run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "approved",
      notes: JSON.stringify({ summary: "another nit", findings: [{ path: "b.ts", line: 2, severity: "nit", body: "more taste" }] }),
    })
    expect(store.getFeature(feature.id)?.currentStep).toBe("merge")
    const open = store.listFindings(feature.id).filter(f => f.status === "new")
    expect(open.map(f => f.id)).toEqual(["F1", "F2"])
  })
})

describe("Engine: findings.check step scoping (params.steps)", () => {
  it("findings from steps outside the filter do not block", async () => {
    const scopedPipeline: PipelineDef = {
      pipeline: [
        {
          id: "design_review",
          type: "agent",
          role: "critic",
          on_verdict: { approved: { next: true }, changes_requested: { next: true } },
        },
        {
          id: "check",
          type: "builtin",
          action: "findings.check",
          params: { steps: "external_review", polish: "0" },
          then: "done_marker",
          on_fail: { goto: "design_review", max_attempts: 2 },
        },
        { id: "done_marker", type: "builtin", action: "findings.check", params: { steps: "none" } },
      ],
      roles: { critic: { agent: "critic", model: "m" } },
    }
    const config = makeConfig({ pipeline: scopedPipeline.pipeline, roles: scopedPipeline.roles })
    const engine = makeEngine(config)
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/p" })

    await engine.dispatch(feature.id, { kind: "feature.start" })
    const run = store.getActiveRun(feature.id)
    await engine.report({
      runId: run?.id ?? "",
      verdict: "approved",
      notes: JSON.stringify({
        summary: "design ok with one major tracked",
        findings: [{ path: "openspec/changes/x/design.md", line: 1, severity: "major", body: "boundary doubt" }],
      }),
    })
    const state = store.getFeature(feature.id)
    expect(state?.status).toBe("done")
    const open = store.listFindings(feature.id).filter(f => f.status === "new")
    expect(open).toHaveLength(1)
    expect(open[0]?.stepId).toBe("design_review")
  })
})

describe("Engine: escalation when a step vanishes from a live pipeline", () => {
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
