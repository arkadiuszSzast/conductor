import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store, type StoreChange } from "./src/store.ts"
import type { Decision, PipelineEvent, Transition } from "@conductor/core"

let directory: string
let connection: DatabaseConnection
let store: Store

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-store-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function jobRunningPatch(jobId: string, stepId: string): Transition["patch"] {
  return { status: "running", jobs: { [jobId]: { status: "running", currentStep: stepId, steps: { [stepId]: { status: "running" } } } } }
}

describe("feature lifecycle", () => {
  it("creates and reads a feature with a fresh graph state", () => {
    const feature = store.createFeature({ title: "Add login", slug: "add-login", projectDir: "/tmp/proj", workflow: "wf" })
    expect(feature.status).toBe("running")
    expect(feature.jobs).toEqual({})
    expect(feature.workflow).toBe("wf")
    expect(store.getFeature(feature.id)).toEqual(feature)
  })

  it("applies a transition atomically with its audit entry", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const event: PipelineEvent = { kind: "feature.start" }
    const decisions: Decision[] = [{ kind: "execute_step", jobId: "main", stepId: "implement" }]
    store.applyTransition(feature.id, event, { decisions, patch: jobRunningPatch("main", "implement") })
    const after = store.getFeature(feature.id)!
    expect(after.jobs["main"]?.currentStep).toBe("implement")
    expect(after.jobs["main"]?.status).toBe("running")
    const log = store.getTransitions(feature.id)
    expect(log).toHaveLength(1)
    expect(log[0]?.decisions).toEqual(decisions)
  })

  it("rolls back the feature patch when audit persistence fails", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    connection.db.run(`
      CREATE TRIGGER reject_transition BEFORE INSERT ON transition_log
      BEGIN SELECT RAISE(ABORT, 'audit rejected'); END
    `)
    expect(() =>
      store.applyTransition(feature.id, { kind: "feature.start" }, {
        decisions: [{ kind: "execute_step", jobId: "main", stepId: "implement" }],
        patch: jobRunningPatch("main", "implement"),
      }),
    ).toThrow("audit rejected")
    expect(store.getFeature(feature.id)).toEqual(feature)
    expect(store.getTransitions(feature.id)).toEqual([])
  })

  it("records escalation reason on the feature", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "step.failed", jobId: "main", stepId: "gate", reason: "boom" }, {
      decisions: [{ kind: "escalate", reason: "gate exhausted attempts" }],
      patch: { status: "escalated" },
    })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getEscalation(feature.id)).toBe("gate exhausted attempts")
    store.applyTransition(feature.id, { kind: "human.resumed" }, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "gate" }],
      patch: { status: "running" },
    })
    expect(store.getEscalation(feature.id)).toBeNull()
  })

  it("filters active features and finds by PR", () => {
    const a = store.createFeature({ title: "A", slug: "a", projectDir: "/p", workflow: "wf" })
    const b = store.createFeature({ title: "B", slug: "b", projectDir: "/p", workflow: "wf" })
    store.applyTransition(b.id, { kind: "human.abandoned" }, { decisions: [{ kind: "abandon" }], patch: { status: "abandoned" } })
    store.setFeatureFields(a.id, { pr: 42 })
    expect(store.listFeatures({ activeOnly: true }).map(feature => feature.id)).toEqual([a.id])
    expect(store.findFeatureByPr(42)?.id).toBe(a.id)
    expect(store.findFeatureByPr(999)).toBeNull()
  })
})

describe("runs", () => {
  it("tracks a run through insert and finish and exposes it by id", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "gate", stepType: "command", attempt: 1 })
    expect(store.getActiveRun(feature.id)?.id).toBe(runId)
    store.finishRun(runId, "failed", { outputs: {}, reason: "exit 1" })
    expect(store.getActiveRun(feature.id)).toBeNull()
    expect(store.getRunById(runId)?.status).toBe("failed")
  })

  it("increments nudges", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "merge", stepType: "agent", attempt: 2 })
    expect(store.incrementNudges(runId)).toBe(1)
    expect(store.getRunById(runId)).toMatchObject({ jobId: "main", stepId: "merge", attempt: 2 })
  })

  it("sets a run's session id while it is still running", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    expect(store.setRunSession(runId, "session-123")).toBe(true)
    expect(store.getActiveRun(feature.id)?.sessionId).toBe("session-123")
  })

  it("setRunSession is a no-op once the run has concluded", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    store.finishRun(runId, "reaped", { reason: "TTL" })
    expect(store.setRunSession(runId, "session-late")).toBe(false)
  })

  it("visibility: a run inserted before dispatch is observable by getActiveRunForStep", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    expect(store.getActiveRunForStep(feature.id, "main", "implement")?.id).toBe(runId)
    expect(store.getActiveRunForStep(feature.id, "main", "other")).toBeNull()
  })

  it("listActiveRuns returns every in-flight run across jobs (fan-out)", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const a = store.insertRun({ featureId: feature.id, jobId: "a", stepId: "s", stepType: "agent", attempt: 1 })
    const b = store.insertRun({ featureId: feature.id, jobId: "b", stepId: "s", stepType: "command", attempt: 1 })
    expect(store.listActiveRuns(feature.id).map(r => r.id).sort()).toEqual([a, b].sort())
  })

  it("insertRun leaves pendingState/nextObservation null", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "poll", stepType: "action", attempt: 1 })
    const run = store.getRunById(runId)!
    expect(run.pendingState).toBeNull()
    expect(run.nextObservation).toBeNull()
  })

  it("recordPendingObservation claims a running run and round-trips pendingState/nextObservation", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "poll", stepType: "action", attempt: 1 })
    const claimed = store.recordPendingObservation(runId, { deadline: 123 }, 999)
    expect(claimed).toBe(true)

    const run = store.getRunById(runId)!
    expect(run.status).toBe("running")
    expect(run.pendingState).toEqual({ deadline: 123 })
    expect(run.nextObservation).toBe(999)
    expect(store.getActiveRun(feature.id)?.id).toBe(runId)
  })

  it("recordPendingObservation accepts a null state", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "poll", stepType: "action", attempt: 1 })
    store.recordPendingObservation(runId, null, 500)
    const run = store.getRunById(runId)!
    expect(run.pendingState).toBeNull()
    expect(run.nextObservation).toBe(500)
  })

  it("recordPendingObservation returns false and drops the write once the run has concluded", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "poll", stepType: "action", attempt: 1 })
    store.finishRun(runId, "reaped", { reason: "TTL" })

    const claimed = store.recordPendingObservation(runId, { deadline: 1 }, 1000)
    expect(claimed).toBe(false)
    const run = store.getRunById(runId)!
    expect(run.pendingState).toBeNull()
    expect(run.nextObservation).toBeNull()
    expect(run.status).toBe("reaped")
  })
})

describe("concludeRun", () => {
  it("atomically concludes the run and applies the feature transition", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const event: PipelineEvent = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done", outputs: { report: "done" } }
    const ok = store.concludeRun(runId, "succeeded", { outputs: { report: "done" } }, event, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "review" }],
      patch: jobRunningPatch("main", "review"),
    })
    expect(ok).toBe(true)
    expect(store.getRunById(runId)).toMatchObject({ status: "succeeded", outputs: { report: "done" } })
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("review")
    const log = store.getTransitions(feature.id)
    expect(log).toHaveLength(1)
    expect(log[0]?.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "review" }])
  })

  it("returns false and applies no transition when the run is already concluded", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const event: PipelineEvent = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done", outputs: { report: "done" } }
    const transition: Transition = {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "review" }],
      patch: jobRunningPatch("main", "review"),
    }
    expect(store.concludeRun(runId, "succeeded", { outputs: { report: "done" } }, event, transition)).toBe(true)

    const duplicate = store.concludeRun(runId, "succeeded", { outputs: { report: "duplicate" } }, event, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "merge" }],
      patch: jobRunningPatch("main", "merge"),
    })
    expect(duplicate).toBe(false)
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("review")
    expect(store.getTransitions(feature.id)).toHaveLength(1)
    expect(store.getRunById(runId)?.outputs).toEqual({ report: "done" })
  })

  it("rolls back the run conclusion when the transition audit insert fails", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    connection.db.run(`
      CREATE TRIGGER reject_conclude_transition BEFORE INSERT ON transition_log
      BEGIN SELECT RAISE(ABORT, 'audit rejected'); END
    `)
    const event: PipelineEvent = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done" }
    expect(() =>
      store.concludeRun(runId, "succeeded", { outputs: {} }, event, {
        decisions: [{ kind: "execute_step", jobId: "main", stepId: "review" }],
        patch: jobRunningPatch("main", "review"),
      }),
    ).toThrow("audit rejected")
    expect(store.getRunById(runId)).toMatchObject({ status: "running", outputs: {} })
    expect(store.getFeature(feature.id)?.jobs["main"]).toBeUndefined()
    expect(store.getTransitions(feature.id)).toEqual([])
  })
})

describe("pending run action (crash-recovery outbox)", () => {
  it("concludeRun leaves decisions pending until markRunActionHandled claims them", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const event: PipelineEvent = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done" }
    store.concludeRun(runId, "succeeded", { outputs: {} }, event, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "review" }],
      patch: jobRunningPatch("main", "review"),
    })
    expect(store.getPendingRunAction(feature.id)).toEqual({
      runId,
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "review" }],
    })

    expect(store.markRunActionHandled(runId)).toBe(true)
    expect(store.getPendingRunAction(feature.id)).toBeNull()
  })

  it("markRunActionHandled is a one-shot atomic claim — a second call returns false", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const event: PipelineEvent = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done" }
    store.concludeRun(runId, "succeeded", { outputs: {} }, event, {
      decisions: [{ kind: "finish" }],
      patch: { status: "done" },
    })
    expect(store.markRunActionHandled(runId)).toBe(true)
    expect(store.markRunActionHandled(runId)).toBe(false)
  })

  it("getPendingRunAction returns null for a feature with no concluded runs", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    expect(store.getPendingRunAction(feature.id)).toBeNull()
  })

  it("a plain finishRun (no feature transition) never becomes a pending action", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "check", stepType: "command", attempt: 1 })
    store.finishRun(runId, "reaped", { reason: "pending — will re-check" })
    expect(store.getPendingRunAction(feature.id)).toBeNull()
  })
})

describe("findings", () => {
  it("preserves the findings lifecycle", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    expect(store.insertFindings(feature.id, "review", [{ path: "src/a.ts", line: 7, severity: "major", tags: ["bug"], body: "Broken" }])).toEqual(["F1"])
    expect(store.listFindings(feature.id)[0]).toMatchObject({ id: "F1", tags: ["bug"] })
    expect(store.setFindingStatus(feature.id, "F1", "fixed", "fixed in commit")).toBe(true)
    expect(store.listFindings(feature.id)[0]).toMatchObject({ status: "fixed", resolution: "fixed in commit" })
  })
})

describe("feature records (API projection reads)", () => {
  it("returns row timestamps alongside the state and bumps updatedAt on transition", () => {
    const before = Date.now()
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const record = store.getFeatureRecord(feature.id)!
    expect(record.state).toEqual(feature)
    expect(record.createdAt).toBeGreaterThanOrEqual(before)
    expect(record.updatedAt).toBe(record.createdAt)

    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "implement" }],
      patch: jobRunningPatch("main", "implement"),
    })
    const after = store.getFeatureRecord(feature.id)!
    expect(after.updatedAt).toBeGreaterThanOrEqual(after.createdAt)
    expect(after.createdAt).toBe(record.createdAt)
  })

  it("listFeatureRecords filters by statuses", () => {
    const running = store.createFeature({ title: "A", slug: "a", projectDir: "/p", workflow: "wf" })
    const done = store.createFeature({ title: "B", slug: "b", projectDir: "/p", workflow: "wf" })
    store.applyTransition(done.id, { kind: "feature.start" }, { decisions: [], patch: { status: "done" } })
    const waiting = store.createFeature({ title: "C", slug: "c", projectDir: "/p", workflow: "wf" })
    store.applyTransition(waiting.id, { kind: "feature.start" }, {
      decisions: [{ kind: "wait_human", jobId: "main", stepId: "approve" }],
      patch: {
        status: "waiting_human",
        jobs: { main: { status: "running", currentStep: "approve", steps: { approve: { status: "waiting_human" } } } },
      },
    })

    const filtered = store.listFeatureRecords({ statuses: ["done", "waiting_human"] })
    expect(filtered.map(record => record.state.id).sort()).toEqual([done.id, waiting.id].sort())

    const all = store.listFeatureRecords()
    expect(all.map(record => record.state.id)).toContain(running.id)
  })
})

describe("finding counts", () => {
  it("groups counts per feature and status in one query and omits zero-finding features", () => {
    const first = store.createFeature({ title: "A", slug: "a", projectDir: "/p", workflow: "wf" })
    const second = store.createFeature({ title: "B", slug: "b", projectDir: "/p", workflow: "wf" })
    store.insertFindings(first.id, "review", [
      { path: "a.ts", line: 1, severity: "major", tags: [], body: "x" },
      { path: "b.ts", line: 2, severity: "minor", tags: [], body: "y" },
    ])
    store.setFindingStatus(first.id, "F2", "fixed")

    const counts = store.countFindingsByStatus([first.id, second.id])
    expect(counts.get(first.id)).toEqual({ new: 1, fixed: 1, dismissed: 0, reopened: 0 })
    expect(counts.get(second.id)).toBeUndefined()
    expect(store.countFindingsByStatus([])).toEqual(new Map())
  })
})

describe("newest run per step", () => {
  it("returns the newest run id per (job, step) across the whole history", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const oldRun = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    store.finishRun(oldRun, "failed", { reason: "boom" })
    connection.db.run("UPDATE run SET time_started = time_started - 1000 WHERE id = ?", [oldRun])
    const newRun = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 2 })
    const otherStep = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "review", stepType: "agent", attempt: 1 })

    const newest = store.newestRunIdsByStep(feature.id)
    expect(newest.get("main\u0000implement")).toBe(newRun)
    expect(newest.get("main\u0000review")).toBe(otherStep)
  })
})

describe("run logs", () => {
  function makeRun(): string {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    return store.insertRun({ featureId: feature.id, jobId: "main", stepId: "verify", stepType: "command", attempt: 1 })
  }

  it("round-trips an append batch with monotonic seq, time and source", () => {
    const runId = makeRun()
    const range = store.appendRunLog(runId, [
      { source: "process", text: "line one" },
      { source: "process", text: "line two" },
    ])
    expect(range).toEqual({ firstSeq: 1, lastSeq: 2 })
    const page = store.getRunLog(runId)
    expect(page.lines.map(line => line.text)).toEqual(["line one", "line two"])
    expect(page.lines.map(line => line.seq)).toEqual([1, 2])
    expect(page.lines.every(line => line.source === "process" && line.time > 0)).toBe(true)
    expect(page.nextSeq).toBe(2)
    expect(page.truncated).toBe(false)
  })

  it("seq stays monotonic across batches", () => {
    const runId = makeRun()
    store.appendRunLog(runId, [{ source: "step", text: "a" }])
    const second = store.appendRunLog(runId, [{ source: "step", text: "b" }, { source: "step", text: "c" }])
    expect(second).toEqual({ firstSeq: 2, lastSeq: 3 })
  })

  it("an empty batch is a no-op", () => {
    const runId = makeRun()
    expect(store.appendRunLog(runId, [])).toBeNull()
    expect(store.getRunLog(runId).lines).toEqual([])
  })

  it("a batch is atomic — a mid-batch failure leaves nothing behind", () => {
    const runId = makeRun()
    connection.db.run(`
      CREATE TRIGGER reject_second_line BEFORE INSERT ON run_log
      WHEN NEW.seq = 2
      BEGIN SELECT RAISE(ABORT, 'batch rejected'); END
    `)
    expect(() => store.appendRunLog(runId, [
      { source: "agent", text: "first" },
      { source: "agent", text: "second" },
    ])).toThrow("batch rejected")
    expect(store.getRunLog(runId).lines).toEqual([])
  })

  it("enforces the per-run cap by dropping the oldest lines — the tail survives", () => {
    const runId = makeRun()
    const megabyte = "x".repeat(1024 * 1024)
    store.appendRunLog(runId, [{ source: "process", text: megabyte }])
    store.appendRunLog(runId, [{ source: "process", text: megabyte }])
    store.appendRunLog(runId, [{ source: "process", text: "tail marker" }])
    const page = store.getRunLog(runId)
    expect(page.lines.map(line => line.seq)).toEqual([2, 3])
    expect(page.lines[page.lines.length - 1]!.text).toBe("tail marker")
  })

  it("requireRunning refuses the append atomically once the run has concluded", () => {
    const runId = makeRun()
    store.finishRun(runId, "succeeded", { outputs: {} })
    expect(store.appendRunLog(runId, [{ source: "agent", text: "late" }], { requireRunning: true })).toBeNull()
    expect(store.getRunLog(runId).lines).toEqual([])
    // Daemon-internal producers stay lenient: no requireRunning, the append lands.
    expect(store.appendRunLog(runId, [{ source: "process", text: "settling output" }])).toEqual({ firstSeq: 1, lastSeq: 1 })
  })

  it("a single chunk larger than the whole cap survives as the tail — an append never erases itself", () => {
    const runId = makeRun()
    store.appendRunLog(runId, [{ source: "process", text: "old line" }])
    const oversized = "y".repeat(3 * 1024 * 1024)
    store.appendRunLog(runId, [{ source: "process", text: oversized }])
    const page = store.getRunLog(runId)
    expect(page.lines).toHaveLength(1)
    expect(page.lines[0]!.seq).toBe(2)
    expect(page.lines[0]!.text.length).toBe(oversized.length)
  })

  it("pages with after/limit and reports truncation", () => {
    const runId = makeRun()
    store.appendRunLog(runId, Array.from({ length: 5 }, (_, i) => ({ source: "step" as const, text: `l${i + 1}` })))
    const first = store.getRunLog(runId, { limit: 2 })
    expect(first.lines.map(line => line.text)).toEqual(["l1", "l2"])
    expect(first.nextSeq).toBe(2)
    expect(first.truncated).toBe(true)

    const second = store.getRunLog(runId, { afterSeq: first.nextSeq, limit: 2 })
    expect(second.lines.map(line => line.text)).toEqual(["l3", "l4"])
    expect(second.truncated).toBe(true)

    const last = store.getRunLog(runId, { afterSeq: second.nextSeq, limit: 2 })
    expect(last.lines.map(line => line.text)).toEqual(["l5"])
    expect(last.nextSeq).toBe(5)
    expect(last.truncated).toBe(false)

    const empty = store.getRunLog(runId, { afterSeq: 5 })
    expect(empty.lines).toEqual([])
    expect(empty.nextSeq).toBe(5)
  })

  it("throttles run_log notifications per run within the window and re-emits after it", () => {
    const clock = { current: 1_000_000, now(): number { return this.current } }
    const throttled = new Store(connection.db, clock)
    const feature = throttled.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = throttled.insertRun({ featureId: feature.id, jobId: "main", stepId: "verify", stepType: "command", attempt: 1 })
    const other = throttled.insertRun({ featureId: feature.id, jobId: "other", stepId: "verify", stepType: "command", attempt: 1 })
    const changes: StoreChange[] = []
    throttled.onChange(change => {
      if (change.kind === "run_log") changes.push(change)
    })

    throttled.appendRunLog(runId, [{ source: "step", text: "a" }])
    throttled.appendRunLog(runId, [{ source: "step", text: "b" }])
    throttled.appendRunLog(runId, [{ source: "step", text: "c" }])
    expect(changes).toHaveLength(1)

    // The throttle is per run: another run of the same feature emits independently.
    throttled.appendRunLog(other, [{ source: "step", text: "x" }])
    expect(changes).toHaveLength(2)

    clock.current += 1_000
    throttled.appendRunLog(runId, [{ source: "step", text: "d" }])
    expect(changes).toHaveLength(3)

    // Every append landed regardless of notification coalescing.
    expect(throttled.getRunLog(runId).lines.map(line => line.text)).toEqual(["a", "b", "c", "d"])
  })
})

describe("timeline events", () => {
  it("returns event as a parsed object", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "implement" }],
      patch: jobRunningPatch("main", "implement"),
    })
    const [entry] = store.getTransitions(feature.id)
    expect(entry?.event).toEqual({ kind: "feature.start" })
  })
})

describe("onChange", () => {
  it("fires post-commit for feature/transition/run/finding changes", () => {
    const changes: StoreChange[] = []
    const unsubscribe = store.onChange(change => changes.push(change))

    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    expect(changes).toContainEqual({ kind: "feature", featureId: feature.id })

    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "implement" }],
      patch: jobRunningPatch("main", "implement"),
    })
    expect(changes).toContainEqual({ kind: "transition", featureId: feature.id })

    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    expect(changes).toContainEqual({ kind: "run", featureId: feature.id })

    store.insertFindings(feature.id, "implement", [{ path: "a.ts", line: 1, severity: "minor", tags: [], body: "b" }])
    expect(changes).toContainEqual({ kind: "finding", featureId: feature.id })

    changes.length = 0
    store.setFeatureFields(feature.id, { sessionId: "ses_parent" })
    expect(changes).toContainEqual({ kind: "feature", featureId: feature.id })

    changes.length = 0
    unsubscribe()
    store.finishRun(runId, "succeeded", { outputs: {} })
    expect(changes).toEqual([])
  })

  it("a throwing listener is swallowed and never breaks a durable transition", () => {
    store.onChange(() => {
      throw new Error("boom")
    })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    expect(store.getFeature(feature.id)).not.toBeNull()
  })
})

describe("interactive steps: run questions", () => {
  it("setRunQuestion parks the feature and clearRunQuestion resumes it, with timeline entries", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "explore", stepType: "agent", attempt: 1 })

    expect(store.setRunQuestion(runId, "Which storage?")).toBe(true)
    expect(store.getFeature(feature.id)!.status).toBe("waiting_human")
    const asked = store.getRunById(runId)!
    expect(asked.status).toBe("running")
    expect(asked.pendingQuestion).toBe("Which storage?")
    expect(asked.askedAt).not.toBeNull()

    expect(store.clearRunQuestion(runId)).toBe(true)
    expect(store.getFeature(feature.id)!.status).toBe("running")
    const cleared = store.getRunById(runId)!
    expect(cleared.pendingQuestion).toBeNull()
    expect(cleared.askedAt).toBeNull()

    const kinds = store.getTransitions(feature.id).map(t => (t.event as { kind: string }).kind)
    expect(kinds).toContain("run.ask")
    expect(kinds).toContain("run.answer")
  })

  it("keeps the feature waiting until every concurrent question is answered", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const first = store.insertRun({ featureId: feature.id, jobId: "left", stepId: "explore", stepType: "agent", attempt: 1 })
    const second = store.insertRun({ featureId: feature.id, jobId: "right", stepId: "review", stepType: "agent", attempt: 1 })

    store.setRunQuestion(first, "First?")
    store.setRunQuestion(second, "Second?")
    expect(store.clearRunQuestion(first)).toBe(true)
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")

    expect(store.clearRunQuestion(second)).toBe(true)
    expect(store.getFeature(feature.id)?.status).toBe("running")
  })

  it("keeps the feature waiting when a gate remains after its question is answered", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [{ kind: "wait_human", jobId: "gate", stepId: "approve" }],
      patch: {
        status: "waiting_human",
        jobs: { gate: { status: "running", currentStep: "approve", steps: { approve: { status: "waiting_human" } } } },
      },
    })
    const runId = store.insertRun({ featureId: feature.id, jobId: "agent", stepId: "explore", stepType: "agent", attempt: 1 })
    store.setRunQuestion(runId, "Question?")

    expect(store.clearRunQuestion(runId)).toBe(true)
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
  })

  it("preserves aggregate attention when a sibling transition writes running", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [
        { kind: "wait_human", jobId: "gate", stepId: "approve" },
        { kind: "execute_step", jobId: "worker", stepId: "build" },
      ],
      patch: {
        status: "waiting_human",
        jobs: {
          gate: { status: "running", currentStep: "approve", steps: { approve: { status: "waiting_human" } } },
          worker: { status: "running", currentStep: "build", steps: { build: { status: "running" } } },
        },
      },
    })

    store.applyTransition(feature.id, { kind: "step.failed", jobId: "worker", stepId: "build", reason: "retry" }, {
      decisions: [{ kind: "execute_step", jobId: "worker", stepId: "build" }],
      patch: { status: "running", jobs: { worker: { status: "running", currentStep: "build", steps: { build: { status: "running" } } } } },
    })

    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
  })

  it("returns to running after the final gate is resolved", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [{ kind: "wait_human", jobId: "gate", stepId: "approve" }],
      patch: {
        status: "waiting_human",
        jobs: { gate: { status: "running", currentStep: "approve", steps: { approve: { status: "waiting_human" } } } },
      },
    })

    store.applyTransition(feature.id, { kind: "step.completed", jobId: "gate", stepId: "approve", outcome: "approved" }, {
      decisions: [{ kind: "execute_step", jobId: "gate", stepId: "deliver" }],
      patch: {
        jobs: { gate: { currentStep: "deliver", steps: { approve: { status: "succeeded" }, deliver: { status: "running" } } } },
      },
    })

    expect(store.getFeature(feature.id)?.status).toBe("running")
  })

  it("rejects asking on a concluded run and clearing without a question", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "explore", stepType: "agent", attempt: 1 })

    expect(store.clearRunQuestion(runId)).toBe(false)

    store.finishRun(runId, "succeeded")
    expect(store.setRunQuestion(runId, "Too late?")).toBe(false)
    expect(store.getFeature(feature.id)!.status).toBe("running")
  })

  it("a pending question survives a fresh store over the same database", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "explore", stepType: "agent", attempt: 1 })
    store.setRunQuestion(runId, "Persisted?")

    const fresh = new Store(connection.db)
    expect(fresh.getRunById(runId)!.pendingQuestion).toBe("Persisted?")
    expect(fresh.getFeature(feature.id)!.status).toBe("waiting_human")
  })

  it("emits a feature change on ask and on answer", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "explore", stepType: "agent", attempt: 1 })
    const changes: StoreChange[] = []
    const unsubscribe = store.onChange(change => changes.push(change))
    store.setRunQuestion(runId, "Q")
    store.clearRunQuestion(runId)
    unsubscribe()
    expect(changes.filter(c => c.kind === "feature").length).toBe(2)
  })
})
