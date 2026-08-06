import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { LegacyEngine } from "./src/legacy/engine.ts"
import type { LegacyGh, LegacyCheckSummary, LegacyPrView, LegacySessionClient, ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/legacy/ports.ts"
import type { LegacyConfig, LegacyPipelineDef } from "./src/legacy/types.ts"

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

  async createSession(input: { title: string; directory: string; parentID?: string }): Promise<{ id: string }> {
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

function makeEngine(config: LegacyConfig): LegacyEngine {
  return new LegacyEngine({
    store,
    resolveConfig: () => config,
    gh,
    sessions,
    process: process_,
    clock,
    log: { log: () => {} },
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
