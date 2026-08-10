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
