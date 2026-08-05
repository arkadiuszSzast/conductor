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
