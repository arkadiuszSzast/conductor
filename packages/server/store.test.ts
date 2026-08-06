import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"

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

describe("feature lifecycle", () => {
  it("creates and reads a feature with defaults", () => {
    const feature = store.createFeature({ title: "Add login", slug: "add-login", projectDir: "/tmp/proj" })
    expect(feature.status).toBe("running")
    expect(feature.currentStep).toBeNull()
    expect(feature.attempts).toEqual({})
  })

  it("applies a transition atomically with its audit entry", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decision: { kind: "execute", stepId: "implement" },
      patch: { status: "running", currentStep: "implement" },
    })
    expect(store.getFeature(feature.id)?.currentStep).toBe("implement")
    const log = store.getTransitions(feature.id)
    expect(log).toHaveLength(1)
    expect(log[0]?.decision).toBe("execute")
    expect(log[0]?.detail).toBe("implement")
  })

  it("rolls back the feature patch when audit persistence fails", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    connection.db.run(`
      CREATE TRIGGER reject_transition BEFORE INSERT ON transition_log
      BEGIN SELECT RAISE(ABORT, 'audit rejected'); END
    `)
    expect(() => store.applyTransition(feature.id, { kind: "feature.start" }, {
      decision: { kind: "execute", stepId: "implement" },
      patch: { currentStep: "implement", attempts: { implement: 1 } },
    })).toThrow("audit rejected")
    expect(store.getFeature(feature.id)).toMatchObject({ currentStep: null, attempts: {} })
    expect(store.getTransitions(feature.id)).toEqual([])
  })

  it("records escalation reason on the feature", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    store.applyTransition(feature.id, { kind: "step.failed", stepId: "gate", reason: "boom" }, {
      decision: { kind: "escalate", reason: "gate exhausted attempts" },
      patch: { status: "escalated", attempts: { gate: 2 } },
    })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getFeature(feature.id)?.attempts).toEqual({ gate: 2 })
    expect(store.getFeature(feature.id)?.escalation).toBe("gate exhausted attempts")
    store.applyTransition(feature.id, { kind: "human.resumed" }, {
      decision: { kind: "execute", stepId: "gate" },
      patch: { status: "running", escalation: null },
    })
    expect(store.getFeature(feature.id)?.escalation).toBeNull()
  })

  it("filters active features and finds by PR", () => {
    const a = store.createFeature({ title: "A", slug: "a", projectDir: "/p" })
    const b = store.createFeature({ title: "B", slug: "b", projectDir: "/p" })
    store.applyTransition(b.id, { kind: "human.abandoned" }, { decision: { kind: "abandon" }, patch: { status: "abandoned" } })
    store.setFeatureFields(a.id, { pr: 42 })
    expect(store.listFeatures({ activeOnly: true }).map(feature => feature.id)).toEqual([a.id])
    expect(store.findFeatureByPr(42)?.id).toBe(a.id)
    expect(store.findFeatureByPr(999)).toBeNull()
  })
})

describe("step runs", () => {
  it("tracks a run through start and finish and exposes last output", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "gate", stepType: "command", attempt: 1 })
    expect(store.getActiveRun(feature.id)?.id).toBe(runId)
    store.finishRun(runId, "failed", { output: "FAILED: 3 tests", reason: "exit 1" })
    expect(store.getActiveRun(feature.id)).toBeNull()
    expect(store.getLastOutput(feature.id, "gate")).toBe("FAILED: 3 tests")
  })

  it("preserves nudge and human-note semantics", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "merge", stepType: "agent", attempt: 2, role: "reviewer" })
    expect(store.incrementNudges(runId)).toBe(1)
    expect(store.getRunById(runId)).toMatchObject({ featureId: feature.id, stepId: "merge", attempt: 2, role: "reviewer" })
    store.finishRun(runId, "succeeded", { output: "Squash-merge please", reason: "human approved" })
    expect(store.getLastHumanNotes(feature.id, "merge")).toBe("Squash-merge please")
  })

  it("sets a run's session id while it is still running", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "implement", stepType: "agent", attempt: 1 })
    expect(store.setRunSession(runId, "session-123")).toBe(true)
    expect(store.getActiveRun(feature.id)?.sessionId).toBe("session-123")
  })

  it("setRunSession is a no-op once the run has concluded", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "implement", stepType: "agent", attempt: 1 })
    store.finishRun(runId, "reaped", { reason: "TTL" })
    expect(store.setRunSession(runId, "session-late")).toBe(false)
    expect(store.getRunById(runId)?.output).toBeNull()
  })
})

describe("concludeRun", () => {
  it("atomically concludes the run and applies the feature transition", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "implement", stepType: "agent", attempt: 1 })
    const event = { kind: "step.succeeded", stepId: "implement", output: "done" } as const
    const ok = store.concludeRun(runId, "succeeded", { output: "done" }, event, {
      decision: { kind: "execute", stepId: "review" },
      patch: { status: "running", currentStep: "review" },
    })
    expect(ok).toBe(true)
    expect(store.getRunById(runId)).toMatchObject({ status: "succeeded", output: "done", completionEvent: JSON.stringify(event) })
    expect(store.getFeature(feature.id)?.currentStep).toBe("review")
    const log = store.getTransitions(feature.id)
    expect(log).toHaveLength(1)
    expect(log[0]?.decision).toBe("execute")
  })

  it("returns false and applies no transition when the run is already concluded", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "implement", stepType: "agent", attempt: 1 })
    const event = { kind: "step.succeeded", stepId: "implement", output: "done" } as const
    const transition = {
      decision: { kind: "execute", stepId: "review" },
      patch: { status: "running", currentStep: "review" },
    } as const
    expect(store.concludeRun(runId, "succeeded", { output: "done" }, event, transition)).toBe(true)

    const duplicate = store.concludeRun(runId, "succeeded", { output: "duplicate report" }, event, {
      decision: { kind: "execute", stepId: "merge" },
      patch: { status: "running", currentStep: "merge" },
    })
    expect(duplicate).toBe(false)
    expect(store.getFeature(feature.id)?.currentStep).toBe("review")
    expect(store.getTransitions(feature.id)).toHaveLength(1)
    expect(store.getRunById(runId)?.output).toBe("done")
  })

  it("rolls back the run conclusion when the transition audit insert fails", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "implement", stepType: "agent", attempt: 1 })
    connection.db.run(`
      CREATE TRIGGER reject_conclude_transition BEFORE INSERT ON transition_log
      BEGIN SELECT RAISE(ABORT, 'audit rejected'); END
    `)
    const event = { kind: "step.succeeded", stepId: "implement", output: "done" } as const
    expect(() => store.concludeRun(runId, "succeeded", { output: "done" }, event, {
      decision: { kind: "execute", stepId: "review" },
      patch: { status: "running", currentStep: "review" },
    })).toThrow("audit rejected")
    expect(store.getRunById(runId)).toMatchObject({ status: "running", output: null, completionEvent: null })
    expect(store.getFeature(feature.id)?.currentStep).toBeNull()
    expect(store.getTransitions(feature.id)).toEqual([])
  })
})

describe("pending run action (crash-recovery outbox)", () => {
  it("concludeRun leaves the decision pending until markRunActionHandled claims it", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "implement", stepType: "agent", attempt: 1 })
    const event = { kind: "step.succeeded", stepId: "implement", output: "done" } as const
    store.concludeRun(runId, "succeeded", { output: "done" }, event, {
      decision: { kind: "execute", stepId: "review" },
      patch: { status: "running", currentStep: "review" },
    })
    expect(store.getPendingRunAction(feature.id)).toEqual({ runId, decision: { kind: "execute", stepId: "review" } })

    expect(store.markRunActionHandled(runId)).toBe(true)
    expect(store.getPendingRunAction(feature.id)).toBeNull()
  })

  it("markRunActionHandled is a one-shot atomic claim — a second call returns false", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "implement", stepType: "agent", attempt: 1 })
    const event = { kind: "step.succeeded", stepId: "implement", output: "done" } as const
    store.concludeRun(runId, "succeeded", { output: "done" }, event, {
      decision: { kind: "finish" },
      patch: { status: "done", currentStep: null },
    })
    expect(store.markRunActionHandled(runId)).toBe(true)
    expect(store.markRunActionHandled(runId)).toBe(false)
  })

  it("getPendingRunAction returns null for a feature with no concluded runs", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    expect(store.getPendingRunAction(feature.id)).toBeNull()
  })

  it("a plain finishRun (no feature transition) never becomes a pending action", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    const runId = store.startRun({ featureId: feature.id, stepId: "await_ci", stepType: "builtin", attempt: 1 })
    store.finishRun(runId, "reaped", { reason: "pending — will re-check" })
    expect(store.getPendingRunAction(feature.id)).toBeNull()
  })
})

describe("findings and review threads", () => {
  it("preserves the findings lifecycle and reopened thread state", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    expect(store.insertFindings(feature.id, "review", [{ path: "src/a.ts", line: 7, severity: "major", tags: ["bug"], body: "Broken" }])).toEqual(["F1"])
    store.setFindingThread(feature.id, "F1", "thread-1")
    store.markFindingSynced(feature.id, "F1")
    expect(store.listFindings(feature.id)[0]).toMatchObject({ id: "F1", threadId: "thread-1", synced: true, tags: ["bug"] })
    expect(store.setFindingStatus(feature.id, "F1", "fixed", "fixed in commit")).toBe(true)
    expect(store.listFindings(feature.id)[0]).toMatchObject({ status: "fixed", resolution: "fixed in commit", synced: false })

    const thread = { threadId: "thread-1", featureId: feature.id, pr: 9, path: "src/a.ts", openedBy: "reviewer", lastReplyBy: "author", lastReply: "fixed" }
    expect(store.upsertThread(thread)).toBe("open")
    store.markThreadResolved("thread-1")
    expect(store.upsertThread({ ...thread, lastReply: "new reply" })).toBe("reopened")
  })
})

describe("pr_head", () => {
  it("supersedes old heads when a new SHA arrives", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p" })
    store.upsertPrHead(feature.id, 7, "sha-old", "in_review")
    store.upsertPrHead(feature.id, 7, "sha-new", "awaiting_ci")
    expect(store.supersedeOldHeads(7, "sha-new")).toBe(1)
    expect(store.getPrHead(7, "sha-old")?.status).toBe("superseded")
    expect(store.getPrHead(7, "sha-new")?.status).toBe("awaiting_ci")
  })
})
