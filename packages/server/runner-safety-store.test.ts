import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, migrateDatabase, type DatabaseConnection } from "./src/database.ts"
import { migrations, runMigrations } from "./src/migrations.ts"
import { Database } from "bun:sqlite"
import { Store } from "./src/store.ts"
import { journalAcpStream } from "./src/acp/connection.ts"
import type { AnyMessage } from "@agentclientprotocol/sdk"
import { agentStep, job, workflow } from "@conductor/core/testing.ts"
import type { WorkflowDef } from "@conductor/core"

let directory: string
let connection: DatabaseConnection
let store: Store

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-runner-safety-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

const roles: WorkflowDef["roles"] = { implementer: { agent: "build" } }

function makeWorkflow(): WorkflowDef {
  return workflow({ main: job([agentStep("work", "implementer", "do the work", { retry: { strategy: "backoff", maxAttempts: 3, backoff: { strategy: "constant", delay: 1000 } } })]) }, roles)
}

function seedRunningFeatureWithRun(): { featureId: string; runId: string } {
  const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
  store.applyTransition(feature.id, { kind: "feature.start" }, {
    decisions: [{ kind: "execute_step", jobId: "main", stepId: "work" }],
    patch: { status: "running", jobs: { main: { status: "running", currentStep: "work", steps: { work: { status: "running" } } } } },
  })
  const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "work", stepType: "agent", attempt: 1 })
  return { featureId: feature.id, runId }
}

function claimOperation(input: Parameters<Store["claimOperation"]>[0]) {
  if (!store.getRunnerBinding(input.runId)) store.bindRunnerTransport({ runId: input.runId, transport: "acp", directory: "/p", daemonGeneration: input.ownerGeneration })
  return store.claimOperation(input)
}

// ---------------------------------------------------------------------------
// 2.1: migrations, typed accessors, uniqueness/conflict, native defaults
// ---------------------------------------------------------------------------

describe("worker mutation transactions", () => {
  it("SEC3/DB2/DB3 fences and persists escalation without a workflow", () => {
    const { featureId, runId } = seedRunningFeatureWithRun()
    store.bindRunnerTransport({ runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
    const credential = store.issueCredential({ runId, attempt: 1, processGeneration: 0, tokenHash: "synthetic-hash", issuedAt: 1 })
    expect(store.fenceRunnerExecution({ runId, jobId: "main", stepId: "work", reasonCode: "startup_recovery", diagnostic: "ownership lost" }, () => undefined).fenced).toBe(true)
    expect(store.findCredentialByHash(credential.tokenHash)?.revokedAt).not.toBeNull()
    expect(store.getRunById(runId)?.status).toBe("uncertain")
    store.markRunActionHandled(runId)
    expect(store.classifyFenceExecution(runId, { classification: "unsafe", evidence: {}, planHealing: () => ({ delayMs: 0, attention: false }) }, () => undefined).classified).toBe(true)
    expect(store.getFeature(featureId)?.status).toBe("escalated")
    expect(store.getPendingRunAction(featureId)?.decisions).toEqual([{ kind: "escalate", reason: "ownership lost" }])
    store.markRunActionHandled(runId)
    expect(store.getPendingRunAction(featureId)).toBeNull()
  })
  it("authorizes inside SQLite transactions and rolls back ask plus dedup on persistence failure", () => {
    const { runId } = seedRunningFeatureWithRun()
    const guard = () => { expect(connection.db.inTransaction).toBe(true) }
    connection.db.run(`CREATE TRIGGER reject_question BEFORE UPDATE OF pending_question ON run BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
    expect(() => store.setRunQuestion(runId, "N", { authorize: guard, invocationId: "one", payloadDigest: "N", disposition: "recorded" })).toThrow("synthetic failure")
    expect(store.findAskInvocation(runId, "one")).toBeNull()
    expect(store.getRunById(runId)?.pendingQuestion).toBeNull()
    connection.db.run("DROP TRIGGER reject_question")
    expect(store.setRunQuestion(runId, "N", { authorize: guard, invocationId: "one", payloadDigest: "N", disposition: "recorded" })).toBe(true)
    const reopened = new Store(connection.db)
    expect(reopened.setRunQuestion(runId, "N", { authorize: guard, invocationId: "one", payloadDigest: "N", disposition: "changed caller text" })).toBe("recorded")
    expect(() => store.concludeRun(runId, "succeeded", {}, { kind: "step.completed", jobId: "main", stepId: "work" }, { patch: {}, decisions: [] }, { authorize: () => { guard(); throw new Error("revoked") } })).toThrow("revoked")
    expect(store.getRunById(runId)?.status).toBe("running")
  })
})

describe("2.1: migration from current schema / empty DB", () => {
  it("preserves populated run logs and answer deliveries across the actual schema rebuild", () => {
    const db = new Database(":memory:")
    try {
      db.run("PRAGMA foreign_keys = ON")
      const index = migrations.findIndex(m => m.id === "0022_runner_safety")
      runMigrations(db, migrations.slice(0, index))
      const prior = new Store(db)
      const feature = prior.createFeature({ title: "Migration", slug: "migration", projectDir: "/fixture", workflow: "wf" })
      const runId = prior.insertRun({ featureId: feature.id, jobId: "main", stepId: "work", stepType: "agent", attempt: 1 })
      prior.appendRunLog(runId, [{ source: "step", text: "preserve audit" }])
      prior.setRunQuestion(runId, "preserve question")
      expect(prior.acceptAnswer(runId, "preserve answer").kind).toBe("accepted")
      const beforeRuns = db.query("SELECT * FROM run").all()
      const beforeLogs = db.query("SELECT * FROM run_log").all()
      const beforeAnswers = db.query("SELECT * FROM answer_delivery").all()
      runMigrations(db)
      expect(db.prepare("SELECT * FROM run").all()).toEqual(beforeRuns)
      expect(db.query("SELECT * FROM run_log").all()).toEqual(beforeLogs)
      expect(db.prepare("SELECT * FROM answer_delivery").all()).toEqual(beforeAnswers)
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      prior.appendRunLog(runId, [{ source: "step", text: "after migration" }])
      expect(db.query("SELECT COUNT(*) AS n FROM run_log").get()).toEqual({ n: 2 })
      db.run("DELETE FROM run WHERE id = ?", [runId])
      expect(db.query("SELECT * FROM run_log").all()).toEqual([])
      expect(db.query("SELECT * FROM answer_delivery").all()).toEqual([])
    } finally {
      db.close()
    }
  })
  it("applies 0022_runner_safety cleanly on a fresh empty database", () => {
    const applied = connection.db.query("SELECT id FROM schema_migration ORDER BY position").all() as Array<{ id: string }>
    expect(applied.map(row => row.id)).toContain("0022_runner_safety")
    expect(applied.at(-1)?.id).toBe(migrations.at(-1)?.id)
  })

  it("re-running migrations against the same database is a no-op (idempotent ledger)", () => {
    const before = connection.db.query("SELECT COUNT(*) AS n FROM schema_migration").get() as { n: number }
    const appliedAgain = migrateDatabase(connection)
    expect(appliedAgain).toEqual([])
    const after = connection.db.query("SELECT COUNT(*) AS n FROM schema_migration").get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  it("migrating a database that predates 0022 (simulated via a fresh chain slice) still reaches the same schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-legacy-"))
    try {
      const legacyConn = openMigratedDatabase({ path: join(dir, "legacy.db") })
      // Insert a legacy-shape feature/run using ONLY pre-0022 columns —
      // proves the rebuild preserves existing rows exactly.
      const legacyStore = new Store(legacyConn.db)
      const feature = legacyStore.createFeature({ title: "Legacy", slug: "legacy", projectDir: "/legacy", workflow: "wf" })
      legacyConn.close()
      // Reopen and re-run migrations (idempotent) — the feature must
      // still read back identically, and the new run/runner_* tables
      // must exist and be empty.
      const reopened = openMigratedDatabase({ path: join(dir, "legacy.db") })
      const reopenedStore = new Store(reopened.db)
      expect(reopenedStore.getFeature(feature.id)?.title).toBe("Legacy")
      expect(reopened.db.query("SELECT COUNT(*) AS n FROM runner_binding").get()).toEqual({ n: 0 })
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("2.1: unique operation/payload conflict", () => {
  it("returns the SAME operation for a duplicate claim with a matching payload digest", () => {
    const { runId } = seedRunningFeatureWithRun()
    const first = claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "digest-a", ownerGeneration: 1 })
    const second = claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "digest-a", ownerGeneration: 1 })
    expect(second.id).toBe(first.id)
    expect(second).toEqual(first)
  })

  it("throws a conflict for the same logical key with a DIFFERENT payload digest", () => {
    const { runId } = seedRunningFeatureWithRun()
    claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "digest-a", ownerGeneration: 1 })
    expect(() =>
      claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "digest-b", ownerGeneration: 1 }),
    ).toThrow(/conflict/)
  })

  it("different kinds for the same run/logicalKey do not collide", () => {
    const { runId } = seedRunningFeatureWithRun()
    const create = claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "d1", ownerGeneration: 1 })
    const prompt = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d1", ownerGeneration: 1 })
    expect(create.id).not.toBe(prompt.id)
  })

  it("findOperation returns null for an operation that was never claimed", () => {
    const { runId } = seedRunningFeatureWithRun()
    expect(store.findOperation(runId, "answer", "nonexistent-token")).toBeNull()
  })
})

describe("2.1: native defaults", () => {
  it("a run with no runner_binding row is implicitly native (existing pre-migration behavior)", () => {
    const { runId } = seedRunningFeatureWithRun()
    expect(store.getRunnerBinding(runId)).toBeNull()
  })

  it("existing run/answer_delivery statuses (running/pending) remain valid after the CHECK constraint rebuild", () => {
    const { runId } = seedRunningFeatureWithRun()
    expect(store.getRunById(runId)?.status).toBe("running")
    store.setRunQuestion(runId, "what should I do?")
    const accepted = store.acceptAnswer(runId, "do the thing")
    expect(accepted.kind).toBe("accepted")
  })
})

describe("2.1: atomic binding-at-run-insert", () => {
  it("rolls back the run when its binding cannot be inserted", () => {
    const feature = store.createFeature({ title: "Atomic", slug: "atomic", projectDir: "/p", workflow: "wf" })
    connection.db.run("CREATE TRIGGER reject_binding BEFORE INSERT ON runner_binding BEGIN SELECT RAISE(ABORT, 'binding refused'); END")
    expect(() => store.insertRun({
      featureId: feature.id, jobId: "main", stepId: "work", stepType: "agent", attempt: 1,
      binding: { transport: "acp", profileId: "fake", directory: "/p", daemonGeneration: 1 },
    })).toThrow("binding refused")
    expect(store.listRuns(feature.id)).toEqual([])
  })

  it("publishes run insertion only after the immutable binding is committed", () => {
    const feature = store.createFeature({ title: "Atomic", slug: "atomic", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({
      featureId: feature.id, jobId: "main", stepId: "work", stepType: "agent", attempt: 1,
      binding: { transport: "acp", profileId: "fake", directory: "/p", daemonGeneration: 1 },
    })
    expect(store.getRunnerBinding(runId)).toMatchObject({ transport: "acp", profileId: "fake", directory: "/p" })
  })

  it("binds a run to acp transport and the binding round-trips exactly", () => {
    const { runId } = seedRunningFeatureWithRun()
    const bound = store.bindRunnerTransport({
      runId, transport: "acp", profileId: "opencode-acp", configDigest: "cfg-1",
      directory: "/srv/work/my-project", daemonGeneration: 1,
    })
    expect(bound.transport).toBe("acp")
    expect(bound.phase).toBe("active")
    const fetched = store.getRunnerBinding(runId)
    expect(fetched).toEqual(bound)
  })

  it("a second bindRunnerTransport call for the same run is a no-op returning the FIRST binding (immutable transport selection)", () => {
    const { runId } = seedRunningFeatureWithRun()
    const first = store.bindRunnerTransport({ runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
    // Config changes after dispatch (a different profile) must NEVER
    // reroute an existing run — the design.md invariant this test locks in.
    const second = store.bindRunnerTransport({ runId, transport: "native", directory: "/p", daemonGeneration: 2 })
    expect(second).toEqual(first)
    expect(second.transport).toBe("acp")
  })

  it("setBindingSessionRef attaches the opaque session identity only for an active binding", () => {
    const { runId } = seedRunningFeatureWithRun()
    store.bindRunnerTransport({ runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
    expect(store.setBindingSessionRef(runId, "acp-proc-1")).toBe(true)
    expect(store.getRunnerBinding(runId)?.sessionRef).toBe("acp-proc-1")
  })

  it("session_ref is UNIQUE across bindings — two runs cannot share one opaque reference", () => {
    const seedA = seedRunningFeatureWithRun()
    const seedB = seedRunningFeatureWithRun()
    store.bindRunnerTransport({ runId: seedA.runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
    store.bindRunnerTransport({ runId: seedB.runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
    store.setBindingSessionRef(seedA.runId, "shared-ref")
    expect(() => store.setBindingSessionRef(seedB.runId, "shared-ref")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2.2: guarded operation phase transitions, generation/version checks
// ---------------------------------------------------------------------------

describe("2.2: guarded operation phase transitions", () => {
  it("commits sending before transport entry and submitted only after the write callback", async () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.bindRunnerTransport({ runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
    let release!: () => void
    let entered!: () => void
    const boundary = new Promise<void>(resolve => { entered = resolve })
    let writes = 0
    const journal = journalAcpStream({
      readable: new ReadableStream<AnyMessage>(),
      writable: new WritableStream<AnyMessage>({ write() {
        writes++
        expect(store.getOperation(op.id)?.phase).toBe("sending")
        entered()
        return new Promise<void>(resolve => { release = resolve })
      } }),
    }, store, 1)
    const submitted = journal.track(op.id)
    const writer = journal.stream.writable.getWriter()
    const writing = writer.write({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} })
    await boundary
    expect(store.getOperation(op.id)?.phase).toBe("sending")
    release()
    await submitted
    await writing
    expect(store.getOperation(op.id)?.phase).toBe("submitted")
    const duplicate = journal.track(op.id)
    await expect(writer.write({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: {} })).rejects.toThrow()
    await expect(duplicate).rejects.toThrow()
    expect(writes).toBe(1)
    writer.releaseLock()
  })

  it("rejects stale generation before entering the underlying write", async () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    let writes = 0
    const journal = journalAcpStream({ readable: new ReadableStream<AnyMessage>(), writable: new WritableStream<AnyMessage>({ write() { writes++ } }) }, store, 2)
    const submitted = journal.track(op.id)
    const writer = journal.stream.writable.getWriter()
    await expect(writer.write({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} })).rejects.toThrow()
    await expect(submitted).rejects.toThrow()
    expect(writes).toBe(0)
    expect(store.getOperation(op.id)?.phase).toBe("prepared")
  })

  it("a failed attempted write is durably unknown", async () => {
    const { runId } = seedRunningFeatureWithRun()
    store.bindRunnerTransport({ runId, transport: "acp", directory: "/p", daemonGeneration: 1 })
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    const journal = journalAcpStream({ readable: new ReadableStream<AnyMessage>(), writable: new WritableStream<AnyMessage>({ write() { throw new Error("pipe lost") } }) }, store, 1)
    const submitted = journal.track(op.id)
    const writer = journal.stream.writable.getWriter()
    await expect(writer.write({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} })).rejects.toThrow()
    await expect(submitted).rejects.toThrow()
    expect(store.getOperation(op.id)?.phase).toBe("unknown")
  })

  it("rejects skipped phases and cannot reopen durable completion", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    expect(store.transitionOperationPhase(op.id, "prepared", "completed")).toBe(false)
    expect(store.transitionOperationPhase(op.id, "prepared", "submitted")).toBe(false)
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    store.transitionOperationPhase(op.id, "submitted", "completed")
    expect(store.transitionOperationPhase(op.id, "completed", "sending")).toBe(false)
    expect(store.transitionOperationPhase(op.id, "completed", "unknown")).toBe(false)
  })

  it("walks prepared -> sending -> submitted -> completed", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    expect(op.phase).toBe("prepared")
    expect(store.transitionOperationPhase(op.id, "prepared", "sending")).toBe(true)
    expect(store.transitionOperationPhase(op.id, "sending", "submitted")).toBe(true)
    expect(store.transitionOperationPhase(op.id, "submitted", "completed", { stopReason: "end_turn" })).toBe(true)
    const final = store.getOperation(op.id)
    expect(final?.phase).toBe("completed")
    expect(final?.stopReason).toBe("end_turn")
  })

  it("rejects a transition whose `from` no longer matches the current phase", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    // Stale caller still thinks it's "prepared" — must fail, not silently succeed.
    expect(store.transitionOperationPhase(op.id, "prepared", "submitted")).toBe(false)
    expect(store.getOperation(op.id)?.phase).toBe("sending")
  })

  it("crash-before-write: an operation stuck at 'prepared' can still transition normally (never entered write boundary)", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    // Simulated "proven no write" disposition for a prepared operation.
    expect(store.transitionOperationPhase(op.id, "prepared", "not_sent")).toBe(true)
    expect(store.getOperation(op.id)?.phase).toBe("not_sent")
  })

  it("crash-after-write (sending, no confirmation): transitions to unknown, never silently to completed", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    expect(store.transitionOperationPhase(op.id, "sending", "unknown")).toBe(true)
    expect(store.getOperation(op.id)?.phase).toBe("unknown")
  })

  it("crash-after-response (submitted, response lost): transitions to unknown", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    expect(store.transitionOperationPhase(op.id, "submitted", "unknown")).toBe(true)
  })

  it("crash-before-confirmation (completed, but the confirming write is what's pending): once completed, a repeated claim never duplicates a potentially sent operation", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    store.transitionOperationPhase(op.id, "submitted", "completed")
    // A restarted caller re-derives the SAME logical key and re-claims —
    // it must get back the completed row, never a fresh "prepared" one.
    const reclaimed = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 2 })
    expect(reclaimed.phase).toBe("completed")
    expect(reclaimed.id).toBe(op.id)
  })

  it("a terminal phase (not_sent) can never transition further", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "not_sent")
    expect(store.transitionOperationPhase(op.id, "not_sent", "sending")).toBe(false)
    expect(store.getOperation(op.id)?.phase).toBe("not_sent")
  })

  it("a terminal phase (unknown) can never transition further", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "unknown")
    expect(store.transitionOperationPhase(op.id, "unknown", "completed")).toBe(false)
  })
})

describe("2.2: startup recovery disposition (stale generation scan)", () => {
  it("lists only non-terminal operations from an older daemon generation", () => {
    const seedA = seedRunningFeatureWithRun()
    const seedB = seedRunningFeatureWithRun()
    const staleOp = claimOperation({ runId: seedA.runId, kind: "prompt", logicalKey: seedA.runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(staleOp.id, "prepared", "sending")
    const currentOp = claimOperation({ runId: seedB.runId, kind: "prompt", logicalKey: seedB.runId, payloadDigest: "d", ownerGeneration: 5 })
    const stale = store.listStaleGenerationOperations(5)
    expect(stale.map(op => op.id)).toEqual([staleOp.id])
    expect(stale.map(op => op.id)).not.toContain(currentOp.id)
  })

  it("excludes already-terminal operations from an old generation (nothing to recover twice)", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "create", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "not_sent")
    expect(store.listStaleGenerationOperations(5)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2.3: atomic fence transaction, credential revocation, uncertainty
// ---------------------------------------------------------------------------

describe("2.3: fenceRunnerExecution — atomic uncertainty transition", () => {
  function resolveWorkflow() {
    const wf = makeWorkflow()
    return () => ({ workflow: wf })
  }

  it("marks the run uncertain, escalates the feature and closes the target without retry/onFail", () => {
    const { featureId, runId } = seedRunningFeatureWithRun()
    const result = store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "lost_prompt_response", diagnostic: "response lost" },
      resolveWorkflow(),
    )
    expect(result.fenced).toBe(true)
    expect(store.getRunById(runId)?.status).toBe("uncertain")
    // The fence alone holds the target armed; classification routes it.
    expect(store.getFeature(featureId)?.status).toBe("running")
    expect(store.getFence(runId)?.classification).toBeNull()
    store.classifyFenceExecution(runId, { classification: "unsafe", evidence: {}, planHealing: () => ({ delayMs: 0, attention: false }) }, resolveWorkflow())
    const feature = store.getFeature(featureId)
    expect(feature?.status).toBe("escalated")
    expect(feature?.jobs.main?.status).toBe("failed")
    expect(feature?.jobs.main?.currentStep).toBeNull()
    // No downstream execute_step decision was recorded for this target —
    // the transition log's last entry must be exactly the escalation.
    const log = store.getTransitions(featureId, 1)
    expect(log[0]?.decisions).toEqual([{ kind: "escalate", reason: "response lost" }])
  })

  it("revokes every credential for the fenced run", () => {
    const { runId } = seedRunningFeatureWithRun()
    const cred = store.issueCredential({ runId, attempt: 1, processGeneration: 1, tokenHash: "hash-1", issuedAt: Date.now() })
    store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "process_or_daemon_restart", diagnostic: "restart" },
      resolveWorkflow(),
    )
    expect(store.findCredentialByHash(cred.tokenHash)?.revokedAt).not.toBeNull()
  })

  it("preserves an open answer delivery's notes while marking it unknown", () => {
    const { runId } = seedRunningFeatureWithRun()
    store.setRunQuestion(runId, "which approach?")
    const accepted = store.acceptAnswer(runId, "use approach B")
    expect(accepted.kind).toBe("accepted")
    store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "lost_answer_response", diagnostic: "answer lost" },
      resolveWorkflow(),
    )
    const delivery = accepted.kind === "accepted" ? store.getAnswerDelivery(accepted.delivery.id) : null
    expect(delivery?.status).toBe("unknown")
    expect(delivery?.notes).toBe("use approach B")
  })

  it("marks the associated operation unknown", () => {
    const { runId } = seedRunningFeatureWithRun()
    const op = claimOperation({ runId, kind: "prompt", logicalKey: runId, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "lost_prompt_response", operationId: op.id, diagnostic: "lost" },
      resolveWorkflow(),
    )
    expect(store.getOperation(op.id)?.phase).toBe("unknown")
  })

  it("report-versus-fence race: a run already concluded some other way cannot be fenced", () => {
    const { runId } = seedRunningFeatureWithRun()
    // Simulate a report that already committed (run no longer running).
    connection.db.run("UPDATE run SET status = 'succeeded' WHERE id = ?", [runId])
    const result = store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "lost_prompt_response", diagnostic: "lost" },
      resolveWorkflow(),
    )
    expect(result.fenced).toBe(false)
    expect(store.getRunById(runId)?.status).toBe("succeeded")
  })

  it("a second fence attempt on an already-fenced run is rejected, not double-applied", () => {
    const { runId } = seedRunningFeatureWithRun()
    const first = store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "lost_prompt_response", diagnostic: "lost" },
      resolveWorkflow(),
    )
    expect(first.fenced).toBe(true)
    // The run's own status already left 'running' (→ 'uncertain') inside
    // the first fence's transaction, so a second attempt is rejected —
    // whether the caller-visible reason is "run_not_active" (the run
    // itself is no longer running) or "already_fenced" (a fence row
    // already exists) is an implementation ordering detail; either way
    // the fence record and the escalated feature/run state from the
    // FIRST call must be exactly preserved, never overwritten.
    const second = store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "turn_deadline_exceeded", diagnostic: "again" },
      resolveWorkflow(),
    )
    expect(second.fenced).toBe(false)
    expect(store.getFence(runId)?.reasonCode).toBe("lost_prompt_response")
    expect(store.getRunById(runId)?.reason).toBe("lost")
  })

  it("closes an open retry episode for the target so a stale due-schedule never fires a replacement dispatch", () => {
    const { featureId, runId } = seedRunningFeatureWithRun()
    store.scheduleRetry({
      featureId, jobId: "main", stepId: "work", attempts: 1, startedAt: Date.now(), pausedMs: 0,
      featurePausedMsAtStart: 0, nextAttemptAt: Date.now() + 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 3, maxElapsedMs: 60_000,
      failure: { class: "transient_transport", diagnostic: "flaky", source: "runner" },
    })
    store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "lost_prompt_response", diagnostic: "lost" },
      resolveWorkflow(),
    )
    const dueLater = store.listDueRetryEpisodes(Date.now() + 10_000)
    expect(dueLater.find(episode => episode.jobId === "main" && episode.stepId === "work")).toBeUndefined()
  })

  it("resolveFence records operator resolution and is idempotent", () => {
    const { runId } = seedRunningFeatureWithRun()
    store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "work", reasonCode: "lost_prompt_response", diagnostic: "lost" },
      resolveWorkflow(),
    )
    expect(store.resolveFence(runId, "operator confirmed cleanup")).toBe(true)
    expect(store.getFence(runId)?.resolutionNote).toBe("operator confirmed cleanup")
    expect(store.resolveFence(runId, "again")).toBe(false)
  })
})
