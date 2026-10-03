import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { agentStep, job, workflow } from "@conductor/core/testing.ts"

let directory: string
let connection: DatabaseConnection
let store: Store
let now = 1_000_000
const clock = { now: () => now }
const wf = workflow({ main: job([agentStep("work", "r", "p"), agentStep("next", "r", "p")]) }, { r: { agent: "build" } })
const resolve = () => ({ workflow: wf })

beforeEach(() => {
  now = 1_000_000
  directory = mkdtempSync(join(tmpdir(), "conductor-healing-store-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db, clock)
  store.configureNotifications([{ id: "telegram" }])
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function seed(): { featureId: string; runId: string } {
  const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "w" })
  store.applyTransition(feature.id, { kind: "feature.start" }, {
    decisions: [{ kind: "execute_step", jobId: "main", stepId: "work" }],
    patch: { status: "running", jobs: { main: { status: "running", currentStep: "work", steps: { work: { status: "running" } } } } },
  })
  const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "work", stepType: "agent", attempt: 1 })
  store.bindRunnerTransport({ runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
  return { featureId: feature.id, runId }
}

function fence(runId: string) {
  return store.fenceRunnerExecution({ runId, jobId: "main", stepId: "work", reasonCode: "lost_create_response", diagnostic: "session/new lost" }, resolve)
}

const plan = (attentionAfter: number) => (failures: number) => ({ delayMs: 60_000 * failures, attention: failures >= attentionAfter })

describe("migration 0027", () => {
  it("adds the self-healing tables and fence columns", () => {
    const tables = (connection.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining(["healing_episode", "feature_attention", "notification_outbox"]))
    const columns = (connection.db.query("PRAGMA table_info(runner_fence)").all() as { name: string }[]).map(row => row.name)
    expect(columns).toEqual(expect.arrayContaining(["classification", "evidence", "classified_at"]))
  })
})

describe("fence evidence and classification", () => {
  it("snapshots pre-fence evidence before operations collapse to unknown", () => {
    const { runId } = seed()
    const op = store.claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    fence(runId)
    expect(store.getFence(runId)?.evidence).toEqual({ sessionBound: false, promptLeftPrepared: false, pendingAnswerDelivery: false })
  })

  it("records a submitted prompt as having left prepared", () => {
    const { runId } = seed()
    const op = store.claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    fence(runId)
    expect(store.getFence(runId)?.evidence?.["promptLeftPrepared"]).toBe(true)
  })

  it("a healable classification schedules exactly one healing episode and keeps the feature running", () => {
    const { featureId, runId } = seed()
    fence(runId)
    expect(store.hasPendingFence(featureId)).toBe(true)
    const first = store.classifyFenceExecution(runId, { classification: "no_effect", evidence: {}, planHealing: plan(3) }, resolve)
    expect(first.healing?.consecutiveFailures).toBe(1)
    expect(first.healing?.nextAttemptAt).toBe(now + 60_000)
    expect(store.classifyFenceExecution(runId, { classification: "no_effect", evidence: {}, planHealing: plan(3) }, resolve).classified).toBe(false)
    expect(store.getFeature(featureId)?.status).toBe("running")
    expect(store.hasBlockingRunnerFence(featureId)).toBe(false)
  })

  it("heal claims once, resolves the fence and logs system.healed", () => {
    const { featureId, runId } = seed()
    fence(runId)
    const { healing } = store.classifyFenceExecution(runId, { classification: "no_effect", evidence: {}, planHealing: plan(3) }, resolve)
    expect(store.healFencedTarget(healing!.id, now)).toBeNull()
    now += 60_000
    expect(store.healFencedTarget(healing!.id, now)?.jobId).toBe("main")
    expect(store.healFencedTarget(healing!.id, now)).toBeNull()
    expect(store.getFence(runId)?.resolutionNote).toContain("auto-heal: no_effect")
    expect(store.getTransitions(featureId, 1)[0]?.event).toMatchObject({ kind: "system.healed", fencedRunId: runId })
  })

  it("chains consecutive failures until a run for the target succeeds", () => {
    const { featureId, runId } = seed()
    fence(runId)
    let { healing } = store.classifyFenceExecution(runId, { classification: "no_effect", evidence: {}, planHealing: plan(2) }, resolve)
    now += healing!.delayMs
    store.healFencedTarget(healing!.id, now)
    const second = store.insertRun({ featureId, jobId: "main", stepId: "work", stepType: "agent", attempt: 1 })
    store.bindRunnerTransport({ runId: second, transport: "acp", directory: "/p", daemonGeneration: 1 })
    fence(second)
    healing = store.classifyFenceExecution(second, { classification: "no_effect", evidence: {}, planHealing: plan(2) }, resolve).healing
    expect(healing?.consecutiveFailures).toBe(2)
    expect(store.listAttention(featureId)).toHaveLength(1)
    expect(store.listNotifications(featureId).map(n => n.kind)).toEqual(["attention"])

    now += healing!.delayMs
    store.healFencedTarget(healing!.id, now)
    const third = store.insertRun({ featureId, jobId: "main", stepId: "work", stepType: "agent", attempt: 1 })
    const event = { kind: "step.completed", jobId: "main", stepId: "work" } as const
    store.concludeRun(third, "succeeded", {}, event, { decisions: [], patch: {} })
    expect(store.listAttention(featureId)).toHaveLength(0)
    expect(store.listNotifications(featureId).map(n => n.kind)).toEqual(["attention", "recovered"])
  })

  it("an unsafe classification escalates, records an escalated notification and clears attention", () => {
    const { featureId, runId } = seed()
    store.upsertAttention({ featureId, jobId: "main", stepId: "work", source: "healing", consecutiveFailures: 3, lastDiagnostic: "x", nextAttemptAt: null })
    fence(runId)
    store.classifyFenceExecution(runId, { classification: "unsafe", evidence: {}, planHealing: plan(3) }, resolve)
    expect(store.getFeature(featureId)?.status).toBe("escalated")
    expect(store.listAttention(featureId)).toHaveLength(0)
    expect(store.hasBlockingRunnerFence(featureId)).toBe(true)
    expect(store.listNotifications(featureId).map(n => n.kind)).toEqual(["attention", "escalated"])
  })
})

describe("notification outbox", () => {
  it("records nothing when no channel is configured", () => {
    store.configureNotifications([])
    const { featureId, runId } = seed()
    fence(runId)
    store.classifyFenceExecution(runId, { classification: "unsafe", evidence: {}, planHealing: plan(3) }, resolve)
    expect(store.listNotifications(featureId)).toHaveLength(0)
  })

  it("respects per-channel event filters", () => {
    store.configureNotifications([{ id: "a", events: ["done"] }, { id: "b" }])
    const { featureId, runId } = seed()
    fence(runId)
    store.classifyFenceExecution(runId, { classification: "unsafe", evidence: {}, planHealing: plan(3) }, resolve)
    expect(store.listNotifications(featureId).map(n => n.channel)).toEqual(["b"])
  })

  it("rolls back with the status change that caused it", () => {
    const { featureId } = seed()
    connection.db.run("CREATE TRIGGER boom BEFORE INSERT ON transition_log BEGIN SELECT RAISE(ABORT, 'boom'); END")
    expect(() => store.markEscalated(featureId, "stuck")).toThrow("boom")
    expect(store.listNotifications(featureId)).toHaveLength(0)
  })

  it("records waiting_human and done edges with their targets", () => {
    const { featureId, runId } = seed()
    store.setRunQuestion(runId, "which approach?")
    const waiting = store.listNotifications(featureId)
    expect(waiting.map(n => n.kind)).toEqual(["waiting_human"])
    expect(waiting[0]?.payload.diagnostic).toContain("which approach?")
    store.applyTransition(featureId, { kind: "step.completed", jobId: "main", stepId: "work" }, { decisions: [{ kind: "finish" }], patch: { status: "done" } })
    expect(store.listNotifications(featureId).map(n => n.kind)).toContain("done")
  })

  it("claims atomically and re-releases an expired lease", () => {
    const { featureId } = seed()
    store.markEscalated(featureId, "stuck")
    const [due] = store.listDueNotifications(now)
    expect(store.claimNotification(due!.id, now, 1000)?.attempts).toBe(1)
    expect(store.claimNotification(due!.id, now, 1000)).toBeNull()
    now += 1000
    expect(store.releaseExpiredNotificationClaims(now)).toBe(1)
    expect(store.listDueNotifications(now)).toHaveLength(1)
  })
})
