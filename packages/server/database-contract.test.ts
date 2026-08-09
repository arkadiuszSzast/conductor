import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase } from "./src/database.ts"
import { migrations } from "./src/migrations.ts"
import { Store } from "./src/store.ts"
import { Engine } from "./src/engine/engine.ts"
import type { CheckSummary, GhClient, PrView, ProcessExecOptions, ProcessExecResult, ProcessRunner, ReviewPayload, SessionClient } from "./src/engine/ports.ts"
import type { EngineConfig, PipelineDef } from "./src/engine/types.ts"

const featureId = "historical-feature"
const fixture = join(import.meta.dir, "fixtures", "database", "historical-seed-findings.sqlite")
const pipeline: PipelineDef = {
  roles: { reviewer_external: { agent: "reviewer", model: "provider/review" }, fixer: { agent: "fixer", model: "provider/implement" } },
  pipeline: [
    { id: "await_ci", type: "builtin", action: "pr.await_checks", then: "external_review" },
    {
      id: "external_review",
      type: "agent",
      role: "reviewer_external",
      rounds_with: "fix_review",
      max_rounds: 3,
      on_verdict: { approved: { goto: "sync_findings" }, changes_requested: { goto: "fix_review" } },
    },
    { id: "fix_review", type: "agent", role: "fixer", then: "external_review" },
    { id: "sync_findings", type: "builtin", action: "findings.sync", then: "merge" },
    { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
  ],
}
const config: EngineConfig = {
  pipeline: pipeline.pipeline,
  roles: pipeline.roles,
  resolvedWorkflows: {},
  repo: "fixture/repository",
  baseBranch: "main",
  runTtlMs: 3_600_000,
  nudgeIdleCycles: 2,
  maxNudges: 2,
}

class FakeGh implements GhClient {
  checks: CheckSummary = { allConcluded: true, anyFailed: false, failedNames: [] }
  view: PrView = { number: 42, headSha: "sha-current", state: "OPEN", mergeable: "MERGEABLE" }
  calls: string[] = []
  async prChecks(): Promise<CheckSummary> { this.calls.push("checks"); return this.checks }
  async prView(): Promise<PrView> { this.calls.push("view"); return this.view }
  async prCreate(): Promise<number> { this.calls.push("create"); return 42 }
  async prMerge(): Promise<void> { this.calls.push("merge"); this.view = { ...this.view, state: "MERGED" } }
  async unresolvedThreadCount(): Promise<number> { this.calls.push("thread-count"); return 0 }
  async unresolvedThreads() { this.calls.push("threads"); return [] }
  async resolveThread(): Promise<void> { this.calls.push("resolve") }
  async replyToThread(): Promise<void> { this.calls.push("reply") }
  async reviewActivitySince(): Promise<number> { this.calls.push("activity"); return 0 }
  async postComment(): Promise<{ ok: true }> { this.calls.push("comment"); return { ok: true } }
  async postReview(_repo: string, _pr: number, _payload: ReviewPayload): Promise<{ ok: true }> { this.calls.push("review"); return { ok: true } }
}

class FakeSessions implements SessionClient {
  calls: string[] = []
  async createSession(): Promise<{ id: string }> { this.calls.push("create"); return { id: "unexpected" } }
  async prompt(): Promise<void> { this.calls.push("prompt") }
  async sessionExists(): Promise<boolean> { this.calls.push("exists"); return true }
  async status(): Promise<"busy"> { this.calls.push("status"); return "busy" }
  async note(): Promise<void> { this.calls.push("note") }
}

class FakeProcess implements ProcessRunner {
  calls: string[] = []
  async exec(_command: readonly string[], _options: ProcessExecOptions): Promise<ProcessExecResult> { this.calls.push("exec"); return { code: 0, stdout: "", stderr: "", output: "" } }
  async shell(_command: string, _options: ProcessExecOptions): Promise<ProcessExecResult> { this.calls.push("shell"); return { code: 0, stdout: "", stderr: "", output: "" } }
}

let directory = ""
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = "" })

function copiedFixture(): string {
  directory = mkdtempSync(join(tmpdir(), "conductor-historical-contract-"))
  const path = join(directory, "conductor.sqlite")
  copyFileSync(fixture, path)
  return path
}

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
}

function snapshot(db: Database) {
  return {
    feature: db.query("SELECT * FROM feature WHERE id = ?").get(featureId),
    runs: db.query("SELECT * FROM step_run WHERE feature_id = ? ORDER BY time_started").all(featureId),
    heads: db.query("SELECT * FROM pr_head WHERE feature_id = ? ORDER BY time_created").all(featureId),
    findings: db.query("SELECT * FROM finding WHERE feature_id = ? ORDER BY seq").all(featureId),
    threads: db.query("SELECT * FROM review_thread WHERE feature_id = ? ORDER BY thread_id").all(featureId),
    transitions: db.query("SELECT * FROM transition_log WHERE feature_id = ? ORDER BY id").all(featureId),
  }
}

function makeEngine(store: Store, gh: FakeGh, sessions: FakeSessions, process: FakeProcess): Engine {
  return new Engine({ store, resolveConfig: () => config, gh, sessions, process, clock: { now: () => 1_800_000_000_000 }, log: { log: () => {} }, publishReview: async () => { gh.calls.push("publish"); return "published" } })
}

describe("historical seed database contract", () => {
  it("migrates and restarts an in-flight human gate without replay", async () => {
    const path = copiedFixture()
    const historical = new Database(path)
    expect(historical.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(historical.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get()).toBeNull()
    expect(tableColumns(historical, "feature")).not.toContain("description")
    expect(tableColumns(historical, "step_run")).not.toContain("completion_event")
    expect(tableColumns(historical, "step_run")).not.toContain("completion_decision")
    expect(tableColumns(historical, "step_run")).not.toContain("action_handled")
    expect(historical.query("SELECT status, current_step FROM feature WHERE id = ?").get(featureId)).toEqual({ status: "waiting_human", current_step: "merge" })
    expect(historical.query("SELECT COUNT(*) AS count FROM step_run WHERE feature_id = ? AND status = 'running'").get(featureId)).toEqual({ count: 0 })
    const historicalSnapshot = snapshot(historical)
    historical.close()

    const migrated = openMigratedDatabase({ path })
    const store = new Store(migrated.db)
    expect(migrated.db.query("SELECT id, position FROM schema_migration ORDER BY position").all()).toEqual(migrations.map((migration, position) => ({ id: migration.id, position })))
    expect(store.getFeature(featureId)).toEqual({
      id: featureId,
      title: "Historical gate fixture",
      slug: "historical-gate",
      projectDir: "/fixtures/historical-project",
      workflow: null,
      description: null,
      status: "waiting_human",
      currentStep: "merge",
      sessionId: "historical-parent-session",
      worktree: "/fixtures/worktrees/historical-gate",
      branch: "feature/historical-gate",
      pr: 42,
      attempts: { await_ci: 1, external_review: 2, fix_review: 1, sync_findings: 1 },
      rounds: { external_review: 2 },
      escalation: null,
    })
    expect(store.getActiveRun(featureId)).toBeNull()
    expect(store.getPendingRunAction(featureId)).toBeNull()
    expect(migrated.db.query("SELECT DISTINCT description FROM feature").all()).toEqual([{ description: null }])
    expect(migrated.db.query("SELECT DISTINCT completion_event, completion_decision, action_handled FROM step_run").all()).toEqual([{ completion_event: null, completion_decision: null, action_handled: 0 }])
    const migratedSnapshot = snapshot(migrated.db)
    expect(migratedSnapshot.heads).toEqual(historicalSnapshot.heads)
    expect(migratedSnapshot.findings).toEqual(historicalSnapshot.findings)
    expect(migratedSnapshot.threads).toEqual(historicalSnapshot.threads)
    expect(migratedSnapshot.transitions).toEqual(historicalSnapshot.transitions)
    expect(migratedSnapshot.runs.map(row => {
      const { completion_event: _event, completion_decision: _decision, action_handled: _handled, ...historicalColumns } = row as Record<string, unknown>
      return historicalColumns
    })).toEqual(historicalSnapshot.runs as Array<Record<string, unknown>>)
    const { description: _description, ...migratedFeatureHistoricalColumns } = migratedSnapshot.feature as Record<string, unknown>
    expect(migratedFeatureHistoricalColumns).toEqual(historicalSnapshot.feature as Record<string, unknown>)
    expect(store.listFindings(featureId)).toEqual([
      { id: "F1", stepId: "external_review", path: "src/open.ts", line: 12, severity: "major", tags: ["correctness", "tests"], body: "Open follow-up", status: "reopened", resolution: "needs follow-up", threadId: "thread-open", synced: false },
      { id: "F2", stepId: "external_review", path: "src/fixed.ts", line: 7, severity: "minor", tags: ["style"], body: "Resolved issue", status: "fixed", resolution: "fixed in review round", threadId: "thread-fixed", synced: true },
    ])
    const before = snapshot(migrated.db)
    migrated.close()

    const restarted = openMigratedDatabase({ path })
    expect(restarted.db.query("SELECT COUNT(*) AS count FROM schema_migration").get()).toEqual({ count: migrations.length })
    const restartedStore = new Store(restarted.db)
    const gh = new FakeGh()
    const sessions = new FakeSessions()
    const process = new FakeProcess()
    const engine = makeEngine(restartedStore, gh, sessions, process)
    await engine.reconcile()
    await engine.reconcile()
    expect(restartedStore.getFeature(featureId)?.status).toBe("waiting_human")
    expect(snapshot(restarted.db)).toEqual(before)
    expect(gh.calls).toEqual([])
    expect(sessions.calls).toEqual([])
    expect(process.calls).toEqual([])

    expect(await engine.approve(featureId)).toContain("now: done")
    expect(gh.calls).toEqual(["view", "merge"])
    expect(sessions.calls).toEqual(["exists", "note"])
    expect(process.calls).toEqual([])
    expect(restartedStore.getFeature(featureId)).toMatchObject({ status: "done", currentStep: null, attempts: { await_ci: 1, external_review: 2, fix_review: 1, sync_findings: 1 }, rounds: { external_review: 2 } })
    const afterRuns = restarted.db.query("SELECT * FROM step_run WHERE feature_id = ? ORDER BY time_started").all(featureId) as Array<Record<string, unknown>>
    expect(afterRuns.slice(0, before.runs.length)).toEqual(before.runs as Array<Record<string, unknown>>)
    const mergeRun = afterRuns[before.runs.length]
    expect(mergeRun).toMatchObject({
      feature_id: featureId,
      step_id: "merge",
      step_type: "builtin",
      attempt: 1,
      status: "succeeded",
      role: null,
      model: null,
      session_id: null,
      output: "merged PR #42",
      reason: null,
      action_handled: 1,
    })
    expect(typeof mergeRun?.id).toBe("string")
    expect(String(mergeRun?.id).length).toBeGreaterThan(0)
    expect(before.runs.some(row => (row as { id: string }).id === mergeRun?.id)).toBe(false)
    expect(typeof mergeRun?.time_started).toBe("number")
    expect(typeof mergeRun?.time_finished).toBe("number")
    expect(Number(mergeRun?.time_finished)).toBeGreaterThanOrEqual(Number(mergeRun?.time_started))
    expect(JSON.parse(String(mergeRun?.completion_event))).toEqual({ kind: "step.succeeded", stepId: "merge", output: "merged PR #42" })
    expect(JSON.parse(String(mergeRun?.completion_decision))).toEqual({ kind: "finish" })
    expect(snapshot(restarted.db).heads).toEqual(before.heads)
    expect(snapshot(restarted.db).findings).toEqual(before.findings)
    expect(snapshot(restarted.db).threads).toEqual(before.threads)
    const transitionsAfter = snapshot(restarted.db).transitions as Array<{ event: string; decision: string; detail: string | null }>
    expect(transitionsAfter.slice(0, before.transitions.length)).toEqual(before.transitions as Array<{ event: string; decision: string; detail: string | null }>)
    expect(transitionsAfter.slice(before.transitions.length).map(row => ({ event: JSON.parse(row.event), decision: row.decision, detail: row.detail }))).toEqual([
      { event: { kind: "human.approved", stepId: "merge" }, decision: "execute", detail: "merge" },
      { event: { kind: "step.succeeded", stepId: "merge", output: "merged PR #42" }, decision: "finish", detail: null },
    ])
    restarted.close()

    const finalRestart = openMigratedDatabase({ path })
    const finalGh = new FakeGh()
    await makeEngine(new Store(finalRestart.db), finalGh, new FakeSessions(), new FakeProcess()).reconcile()
    expect(finalGh.calls).toEqual([])
    expect(new Store(finalRestart.db).getFeature(featureId)).toMatchObject({ status: "done", currentStep: null, pr: 42, worktree: "/fixtures/worktrees/historical-gate", branch: "feature/historical-gate" })
    expect(finalRestart.db.query("SELECT COUNT(*) AS count FROM step_run WHERE feature_id = ? AND step_id = 'merge'").get(featureId)).toEqual({ count: 1 })
    expect(finalRestart.db.query("SELECT action_handled, completion_decision FROM step_run WHERE feature_id = ? AND step_id = 'merge'").get(featureId)).toEqual({ action_handled: 1, completion_decision: '{"kind":"finish"}' })
    expect(finalRestart.db.query("SELECT COUNT(*) AS count FROM transition_log WHERE feature_id = ?").get(featureId)).toEqual({ count: before.transitions.length + 2 })
    finalRestart.close()
  })
})
