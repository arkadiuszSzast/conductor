import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openDatabase, openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { migrations, runMigrations, type Migration } from "./src/migrations.ts"

let directory: string
let connection: DatabaseConnection
let store: Store

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-answer-delivery-store-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function askingRun(): { featureId: string; runId: string } {
  const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
  const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "explore", stepType: "agent", attempt: 1, sessionId: "ses-1" })
  store.setRunQuestion(runId, "Which storage?")
  return { featureId: feature.id, runId }
}

// ---------------------------------------------------------------------------
// 1.2 acceptance
// ---------------------------------------------------------------------------

describe("acceptAnswer", () => {
  it("accepts a durable delivery without clearing the pending question", () => {
    const { featureId, runId } = askingRun()
    const result = store.acceptAnswer(runId, "SQLite")
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") throw new Error("expected accepted")
    expect(result.delivery).toMatchObject({
      runId, featureId, jobId: "main", stepId: "explore",
      notes: "SQLite", status: "pending", targetSessionId: "ses-1",
    })
    expect(result.delivery.deliveryToken).toMatch(/^[0-9a-f-]{36}$/)

    // The question stays visible; the feature stays waiting_human — the
    // aggregate human-attention recalc must still see the outstanding
    // question while delivery is only accepted, not yet confirmed.
    expect(store.getRunById(runId)!.pendingQuestion).toBe("Which storage?")
    expect(store.getFeature(featureId)!.status).toBe("waiting_human")

    const kinds = store.getTransitions(featureId).map(t => (t.event as { kind: string }).kind)
    expect(kinds).toContain("run.answer_accepted")
  })

  it("rejects a second acceptance while the first is accepted-pending (not idempotent, no replace)", () => {
    const { runId } = askingRun()
    const first = store.acceptAnswer(runId, "SQLite")
    expect(first.kind).toBe("accepted")
    const second = store.acceptAnswer(runId, "Postgres")
    expect(second.kind).toBe("already_accepted")

    const open = store.getOpenAnswerDelivery(runId)!
    expect(open.notes).toBe("SQLite")
  })

  it("rejects acceptance on a run without a pending question", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "explore", stepType: "agent", attempt: 1 })
    expect(store.acceptAnswer(runId, "eager").kind).toBe("not_asking")
  })

  it("rejects acceptance on a concluded run", () => {
    const { runId } = askingRun()
    store.finishRun(runId, "succeeded")
    expect(store.acceptAnswer(runId, "late").kind).toBe("run_not_active")
  })

  it("concurrent acceptance requests: exactly one accepted", async () => {
    const { runId } = askingRun()
    const results = await Promise.all([
      Promise.resolve(store.acceptAnswer(runId, "SQLite")),
      Promise.resolve(store.acceptAnswer(runId, "Postgres")),
      Promise.resolve(store.acceptAnswer(runId, "MySQL")),
    ])
    expect(results.filter(r => r.kind === "accepted")).toHaveLength(1)
    expect(results.filter(r => r.kind === "already_accepted")).toHaveLength(2)
  })

  it("restart persistence: a new store instance over the same db file sees the pending delivery", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    const fresh = new Store(connection.db)
    const delivery = fresh.getOpenAnswerDelivery(runId)
    expect(delivery).not.toBeNull()
    expect(delivery!.id).toBe(accepted.delivery.id)
    expect(delivery!.status).toBe("pending")
    expect(delivery!.notes).toBe("SQLite")
    expect(fresh.getRunById(runId)!.pendingQuestion).toBe("Which storage?")
    expect(fresh.getFeature(accepted.delivery.featureId)!.status).toBe("waiting_human")
  })
})

// ---------------------------------------------------------------------------
// 1.3 claim / lease / confirm / fail / cancel
// ---------------------------------------------------------------------------

describe("claimAnswerDelivery", () => {
  it("claims a pending delivery, setting a lease", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    const claimed = store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)
    expect(claimed).not.toBeNull()
    expect(claimed!.status).toBe("claimed")
    expect(claimed!.claimedAt).toBe(1000)
    expect(claimed!.leaseExpiresAt).toBe(31_000)
  })

  it("claim races: two claims on the same delivery — exactly one wins", async () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    const [a, b] = await Promise.all([
      Promise.resolve(store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)),
      Promise.resolve(store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)),
    ])
    const winners = [a, b].filter((r): r is NonNullable<typeof r> => r !== null)
    expect(winners).toHaveLength(1)
  })

  it("excludes deliveries belonging to a paused feature", () => {
    const { featureId, runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.applyTransition(featureId, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })

    expect(store.listPendingAnswerDeliveries(1000)).toHaveLength(0)
    expect(store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)).toBeNull()
  })

  it("listPendingAnswerDeliveries includes lease-expired claimed rows, excludes still-leased ones", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 10_000) // lease expires at 11000

    expect(store.listPendingAnswerDeliveries(5000)).toHaveLength(0)
    expect(store.listPendingAnswerDeliveries(11_000)).toHaveLength(1)
  })

  it("releaseAnswerDelivery returns a claimed delivery to pending immediately", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)

    expect(store.releaseAnswerDelivery(accepted.delivery.id)).toBe(true)
    const released = store.getAnswerDelivery(accepted.delivery.id)!
    expect(released.status).toBe("pending")
    expect(released.leaseExpiresAt).toBeNull()
    expect(store.listPendingAnswerDeliveries(1000)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Review fix: bounded, durable transient-delivery-retry scheduling
// ---------------------------------------------------------------------------

describe("acceptAnswer: bounded-retry schedule initialization", () => {
  it("initializes attempt_count=0, next_attempt_at=null (due now), and a finite deadline_at", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    expect(accepted.delivery.attemptCount).toBe(0)
    expect(accepted.delivery.nextAttemptAt).toBeNull()
    expect(accepted.delivery.deadlineAt).not.toBeNull()
    expect(accepted.delivery.deadlineAt!).toBeGreaterThan(accepted.delivery.createdAt)
  })
})

describe("scheduleAnswerDeliveryRetry", () => {
  it("returns a claimed delivery to pending, bumps attempt_count, and sets a future next_attempt_at", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)

    expect(store.scheduleAnswerDeliveryRetry(accepted.delivery.id, 5000)).toBe(true)
    const scheduled = store.getAnswerDelivery(accepted.delivery.id)!
    expect(scheduled.status).toBe("pending")
    expect(scheduled.claimedAt).toBeNull()
    expect(scheduled.leaseExpiresAt).toBeNull()
    expect(scheduled.attemptCount).toBe(1)
    expect(scheduled.nextAttemptAt).toBe(5000)
  })

  it("a future next_attempt_at suppresses listPendingAnswerDeliveries/claimAnswerDelivery until due", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)
    store.scheduleAnswerDeliveryRetry(accepted.delivery.id, 10_000)

    // Not due yet: excluded from both the listing and a direct claim
    // attempt, even though the lease itself has long expired (the
    // lease no longer governs a `pending` row's due-ness).
    expect(store.listPendingAnswerDeliveries(5000)).toHaveLength(0)
    expect(store.claimAnswerDelivery(accepted.delivery.id, 5000, 30_000)).toBeNull()

    // Due once next_attempt_at elapses.
    expect(store.listPendingAnswerDeliveries(10_000)).toHaveLength(1)
    const reclaimed = store.claimAnswerDelivery(accepted.delivery.id, 10_000, 30_000)
    expect(reclaimed).not.toBeNull()
    expect(reclaimed!.status).toBe("claimed")
  })

  it("is a no-op once the delivery is no longer claimed", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    // Never claimed — still pending.
    expect(store.scheduleAnswerDeliveryRetry(accepted.delivery.id, 5000)).toBe(false)
  })

  it("restart persistence: the schedule survives across a fresh Store instance over the same db", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)
    store.scheduleAnswerDeliveryRetry(accepted.delivery.id, 9000)

    const fresh = new Store(connection.db)
    const reread = fresh.getAnswerDelivery(accepted.delivery.id)!
    expect(reread.attemptCount).toBe(1)
    expect(reread.nextAttemptAt).toBe(9000)
    expect(fresh.listPendingAnswerDeliveries(9000)).toHaveLength(1)
  })
})

describe("confirmAnswerDelivered", () => {
  it("marks delivered, clears the pending question, and returns the feature to running", () => {
    const { featureId, runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)

    expect(store.confirmAnswerDelivered(accepted.delivery.id)).toEqual({ kind: "confirmed" })
    expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("delivered")
    expect(store.getRunById(runId)!.pendingQuestion).toBeNull()
    expect(store.getFeature(featureId)!.status).toBe("running")

    const kinds = store.getTransitions(featureId).map(t => (t.event as { kind: string }).kind)
    expect(kinds).toContain("run.answer")
  })

  it("is guarded by claimed status — confirming a pending (unclaimed) delivery is not_claimed", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    expect(store.confirmAnswerDelivered(accepted.delivery.id)).toEqual({ kind: "not_claimed" })
  })

  it("is guarded by the run still being active — confirming after the run concluded is not_claimed", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)
    store.finishRun(runId, "failed", { reason: "unrelated conclusion" })

    expect(store.confirmAnswerDelivered(accepted.delivery.id)).toEqual({ kind: "not_claimed" })
  })

  it("review fix: a superseded question (run asked again before confirmation) is cancelled without clearing the newer question", () => {
    const { featureId, runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)

    // The agent moved on and asked a NEW question before this delivery's
    // confirmation lands — asked_at (question_generation) no longer
    // matches what this delivery answers. Forced via raw SQL (rather
    // than a second `setRunQuestion` call) so the new generation is
    // deterministically distinct regardless of how fast the test runs —
    // `setRunQuestion` stamps `asked_at` from `Date.now()`, which a
    // same-millisecond second call could otherwise collide with.
    connection.db.run(
      "UPDATE run SET pending_question = ?, asked_at = ? WHERE id = ?",
      ["A different, newer question?", accepted.delivery.questionGeneration + 1, runId],
    )

    expect(store.confirmAnswerDelivered(accepted.delivery.id)).toEqual({ kind: "stale_superseded" })
    expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("cancelled")
    // The newer question must survive untouched.
    expect(store.getRunById(runId)!.pendingQuestion).toBe("A different, newer question?")
    expect(store.getFeature(featureId)!.status).toBe("waiting_human")
  })

  it("review fix: a run with no pending question at all (already answered by another delivery) is cancelled, not confirmed", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)

    // Simulate the question already having been cleared by some other
    // confirmed delivery/path before this stale claim gets confirmed.
    connection.db.run("UPDATE run SET pending_question = NULL, asked_at = NULL WHERE id = ?", [runId])

    expect(store.confirmAnswerDelivered(accepted.delivery.id)).toEqual({ kind: "stale_superseded" })
    expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("cancelled")
  })
})

describe("failAnswerDelivery / cancelAnswerDelivery", () => {
  it("terminal failure retains notes and bounds the failure detail", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.claimAnswerDelivery(accepted.delivery.id, 1000, 30_000)

    const longDetail = "x".repeat(5000)
    expect(store.failAnswerDelivery(accepted.delivery.id, longDetail)).toBe(true)
    const failed = store.getAnswerDelivery(accepted.delivery.id)!
    expect(failed.status).toBe("failed")
    expect(failed.notes).toBe("SQLite")
    expect(failed.failureDetail!.length).toBeLessThan(longDetail.length)
  })

  it("terminal failure is a no-op once already terminal", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    store.failAnswerDelivery(accepted.delivery.id, "missing session")
    expect(store.failAnswerDelivery(accepted.delivery.id, "again")).toBe(false)
  })

  it("cancels a stale-target delivery, retaining notes under a distinct disposition", () => {
    const { runId } = askingRun()
    const accepted = store.acceptAnswer(runId, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    expect(store.cancelAnswerDelivery(accepted.delivery.id, "run concluded before delivery")).toBe(true)
    const cancelled = store.getAnswerDelivery(accepted.delivery.id)!
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.notes).toBe("SQLite")
    expect(cancelled.failureDetail).toBe("run concluded before delivery")
  })

  it("a delivery can be accepted again for the same run once the prior one reaches a terminal state", () => {
    const { runId } = askingRun()
    const first = store.acceptAnswer(runId, "SQLite")
    if (first.kind !== "accepted") throw new Error("expected accepted")
    store.failAnswerDelivery(first.delivery.id, "missing session")

    // A fresh ask reopens the question; a fresh accept is independent of
    // the terminal one (the partial unique index only covers non-terminal rows).
    store.setRunQuestion(runId, "Which storage, take two?")
    const second = store.acceptAnswer(runId, "Postgres")
    expect(second.kind).toBe("accepted")
  })
})

describe("listAnswerDeliveries", () => {
  it("lists every delivery for a feature in creation order", () => {
    const { featureId, runId } = askingRun()
    const first = store.acceptAnswer(runId, "SQLite")
    if (first.kind !== "accepted") throw new Error("expected accepted")
    store.failAnswerDelivery(first.delivery.id, "missing session")
    store.setRunQuestion(runId, "Round two?")
    store.acceptAnswer(runId, "Postgres")

    const all = store.listAnswerDeliveries(featureId)
    expect(all).toHaveLength(2)
    expect(all.map(d => d.notes)).toEqual(["SQLite", "Postgres"])
  })
})

// ---------------------------------------------------------------------------
// 1.4 migration compatibility
// ---------------------------------------------------------------------------

describe("migration compatibility: a pre-existing asking run stays readable", () => {
  it("a db created before the answer_delivery migration, with an asking run, is readable after migrating", () => {
    const preMigrationDirectory = mkdtempSync(join(tmpdir(), "conductor-answer-delivery-migration-"))
    try {
      // Simulate an upgrade: build the schema through every migration
      // BEFORE 0014_answer_delivery (the pre-upgrade daemon), insert an
      // asking run, then reopen with the FULL migration list (the
      // upgraded daemon) and confirm nothing needed rewriting. A
      // monotonic PREFIX, not an id-based filter — the ledger check
      // requires every applied migration to be a contiguous prefix of
      // the full ordered list, so skipping an id out of order (e.g.
      // leaving a later migration in while excluding an earlier one)
      // would fail for reasons unrelated to what this test covers.
      const priorMigrations: Migration[] = migrations.slice(0, migrations.findIndex(m => m.id === "0014_answer_delivery"))
      const dbPath = join(preMigrationDirectory, "state.db")
      const legacyConnection = openDatabase({ path: dbPath })
      runMigrations(legacyConnection.db, priorMigrations)
      const legacyStore = new Store(legacyConnection.db)
      const feature = legacyStore.createFeature({ title: "Legacy", slug: "legacy", projectDir: "/p", workflow: "wf" })
      // Raw insert, not `legacyStore.insertRun`: the CURRENT `Store` code
      // writes `paused_ms_at_dispatch` (added by 0017, after this
      // schema's checkpoint at 0013) — using it here would insert against
      // a column this pre-migration schema doesn't have yet, which is
      // not what this test is simulating.
      const runId = "legacy-run-1"
      legacyConnection.db.run(
        `INSERT INTO run (id, feature_id, job_id, step_id, step_type, attempt, time_started) VALUES (?, ?, ?, ?, 'agent', 1, ?)`,
        [runId, feature.id, "main", "explore", Date.now()],
      )
      // Raw update for the same reason: the CURRENT `setRunQuestion`
      // touches `time_last_activity` (added by 0018, after this
      // schema's checkpoint) — mirror only what a pre-upgrade daemon
      // would have written.
      legacyConnection.db.run(
        "UPDATE run SET pending_question = ?, asked_at = ? WHERE id = ?",
        ["Pre-migration question?", Date.now(), runId],
      )
      legacyConnection.db.run(
        "UPDATE feature SET status = 'waiting_human', state = json_set(state, '$.status', 'waiting_human') WHERE id = ?",
        [feature.id],
      )
      legacyConnection.close()

      const upgraded = openMigratedDatabase({ path: dbPath })
      const upgradedStore = new Store(upgraded.db)
      expect(upgradedStore.getRunById(runId)!.pendingQuestion).toBe("Pre-migration question?")
      expect(upgradedStore.getFeature(feature.id)!.status).toBe("waiting_human")
      // A fresh answer accepts fine post-migration.
      const accepted = upgradedStore.acceptAnswer(runId, "answered post-upgrade")
      expect(accepted.kind).toBe("accepted")
      upgraded.close()
    } finally {
      rmSync(preMigrationDirectory, { recursive: true, force: true })
    }
  })
})
