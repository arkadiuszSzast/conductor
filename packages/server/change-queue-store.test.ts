import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { FeatureStatus, QueueEntryState } from "@conductor/core"
import { openDatabase, openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { migrations, runMigrations } from "./src/migrations.ts"
import { reconcileStartingEntries } from "./src/change-queue-reconcile.ts"
import { ChangeQueueError, Store } from "./src/store.ts"

const P = "/proj"

let directory: string
let connection: DatabaseConnection
let store: Store
let now = 1_000

function open(path: string): void {
  connection = openMigratedDatabase({ path })
  store = new Store(connection.db, { now: () => now })
}

beforeEach(() => {
  now = 1_000
  directory = mkdtempSync(join(tmpdir(), "conductor-queue-"))
  open(join(directory, "state.db"))
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

const waiting = (reason: string): QueueEntryState => ({ kind: "waiting", why: "limit", waitingOn: [], reason })

function createFeatureFor(change: string, time: number, projectDir = P): string {
  now = time
  return store.createFeature({ title: change, slug: change, projectDir, workflow: "wf", input: { change_slug: change } }).id
}

describe("change queue store", () => {
  it("returns defaults and no entries for an unknown project", () => {
    expect(store.getQueue(P)).toEqual({
      settings: { projectDir: P, paused: false, parallelism: 1, timeUpdated: null },
      entries: [],
    })
    expect(store.listQueuedProjects()).toEqual([])
  })

  it("appends entries in order and lists queued projects", () => {
    const a = store.addEntry(P, "a")
    const b = store.addEntry(P, "b")
    store.addEntry("/other", "a")
    expect(a.status).toBe("waiting")
    expect(store.getQueue(P).entries.map(e => [e.change, e.position])).toEqual([["a", 0], ["b", 1]])
    expect(b.position).toBe(1)
    expect(store.listQueuedProjects()).toEqual(["/other", P])
  })

  it("stores the initial state it is given, with the matching status and audit row", () => {
    const waitingState: QueueEntryState = { kind: "waiting", why: "dependencies", waitingOn: ["base"], reason: "waiting for `base`" }
    const a = store.addEntry(P, "a", waitingState)
    expect(a).toMatchObject({ status: "waiting", reason: "waiting for `base`", state: waitingState })
    const blockedState: QueueEntryState = { kind: "blocked", by: "base", stuck: "escalated", reason: "blocked: `base` escalated" }
    const b = store.addEntry(P, "b", blockedState)
    expect(b).toMatchObject({ status: "blocked", state: blockedState })
    expect(store.getQueueTransitions(b.id).map(t => [t.toStatus, t.reason])).toEqual([["blocked", "blocked: `base` escalated"]])
    expect(() => store.addEntry(P, "c", { kind: "running", reason: "x" })).toThrow()
    expect(store.addEntry(P, "d").reason).toBe("queued; not yet evaluated")
  })

  it("rejects a second live entry for the same change with a typed error", () => {
    const first = store.addEntry(P, "a")
    let error: unknown
    try {
      store.addEntry(P, "a")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ChangeQueueError)
    expect((error as ChangeQueueError).code).toBe("duplicate_entry")
    expect((error as ChangeQueueError).entryId).toBe(first.id)
    expect(store.getQueue(P).entries).toHaveLength(1)
    // other projects are independent
    expect(store.addEntry("/other", "a").change).toBe("a")
  })

  it("the partial unique index itself rejects a duplicate live entry", () => {
    store.addEntry(P, "a")
    expect(() =>
      connection.db.run(
        `INSERT INTO change_queue_entry (id, project_dir, change, position, status, time_created, time_updated) VALUES ('x', ?, 'a', 9, 'running', 1, 1)`,
        [P],
      ),
    ).toThrow()
  })

  it("allows re-adding a change whose entry is merged or removed", () => {
    const a = store.addEntry(P, "a")
    expect(store.removeEntry(a.id).removed).toBe(true)
    const again = store.addEntry(P, "a")
    expect(again.id).not.toBe(a.id)
    store.applyPlannedStates(P, new Map([[again.id, { kind: "merged" } as QueueEntryState]]))
    expect(store.getQueueEntry(again.id)?.status).toBe("merged")
    const third = store.addEntry(P, "a")
    expect(store.getQueue(P).entries.map(e => e.status)).toEqual(["removed", "merged", "waiting"])
    expect(third.position).toBe(2)
    expect(store.listQueuedProjects()).toEqual([P])
  })

  it("lists no queued project once every entry is final", () => {
    const a = store.addEntry(P, "a")
    store.removeEntry(a.id)
    expect(store.listQueuedProjects()).toEqual([])
  })

  describe("removeEntry", () => {
    it("removes waiting, blocked and invalid entries", () => {
      const ids = ["a", "b", "c"].map(c => store.addEntry(P, c).id)
      store.applyPlannedStates(
        P,
        new Map<string, QueueEntryState>([
          [ids[1]!, { kind: "blocked", by: "z", stuck: "escalated", reason: "blocked: `z` escalated" }],
          [ids[2]!, { kind: "invalid", diagnostics: [], reason: "invalid: x" }],
        ]),
      )
      for (const id of ids) expect(store.removeEntry(id).removed).toBe(true)
      expect(store.getQueue(P).entries.every(e => e.status === "removed" && e.state !== null)).toBe(true)
    })

    it("is refused while starting or running, and writes nothing", () => {
      const a = store.addEntry(P, "a")
      expect(store.claimEntry(a.id, "t1", 5)).toBe(true)
      const starting = store.removeEntry(a.id)
      expect(starting).toMatchObject({ removed: false, refusal: "started" })
      expect(store.linkEntry(a.id, "t1", "f1")).toBe(true)
      const running = store.removeEntry(a.id)
      expect(running).toMatchObject({ removed: false, refusal: "started" })
      expect(store.getQueueEntry(a.id)?.status).toBe("running")
      expect(store.getQueueTransitions(a.id).map(t => t.toStatus)).toEqual(["waiting", "starting", "running"])
    })

    it("reports unknown and already-final entries", () => {
      expect(store.removeEntry("nope")).toEqual({ removed: false, refusal: "not_found" })
      const a = store.addEntry(P, "a")
      store.removeEntry(a.id)
      expect(store.removeEntry(a.id)).toMatchObject({ removed: false, refusal: "final" })
    })

    function startedEntry(change: string, featureStatus: FeatureStatus | null): { entryId: string; featureId: string } {
      const featureId = createFeatureFor(change, 10)
      if (featureStatus !== null) {
        connection.db.run("UPDATE feature SET status = ? WHERE id = ?", [featureStatus, featureId])
      }
      const entry = store.addEntry(P, change)
      store.claimEntry(entry.id, `t-${change}`)
      store.linkEntry(entry.id, `t-${change}`, featureId)
      return { entryId: entry.id, featureId }
    }

    it("refuses a running or escalated entry whose feature is not terminal", () => {
      for (const status of ["running", "paused", "waiting_human", "escalated"] as const) {
        const { entryId } = startedEntry(`c-${status}`, status)
        if (status === "escalated") {
          store.applyPlannedStates(P, new Map<string, QueueEntryState>([[entryId, { kind: "escalated", reason: "feature escalated" }]]))
        }
        expect(store.removeEntry(entryId)).toMatchObject({ removed: false, refusal: "started" })
        expect(store.getQueueEntry(entryId)?.status).toBe(status === "escalated" ? "escalated" : "running")
      }
    })

    it("allows removing an entry whose linked feature is terminal (done without merge, or abandoned)", () => {
      const done = startedEntry("d", "done")
      expect(store.removeEntry(done.entryId).removed).toBe(true)
      const abandoned = startedEntry("e", "abandoned")
      store.applyPlannedStates(
        P,
        new Map<string, QueueEntryState>([[abandoned.entryId, { kind: "escalated", featureStatus: "abandoned", reason: "feature abandoned" }]]),
      )
      expect(store.getQueueEntry(abandoned.entryId)?.status).toBe("escalated")
      expect(store.removeEntry(abandoned.entryId).removed).toBe(true)
      expect(store.getQueueTransitions(done.entryId).map(t => t.toStatus)).toEqual(["waiting", "starting", "running", "removed"])
    })

    it("reads the feature status in the same transaction as the removal", () => {
      const { entryId, featureId } = startedEntry("f", "running")
      expect(store.removeEntry(entryId).removed).toBe(false)
      connection.db.run("UPDATE feature SET status = 'abandoned' WHERE id = ?", [featureId])
      expect(store.removeEntry(entryId).removed).toBe(true)
    })

    it("treats a linked feature that cannot be found as not terminal", () => {
      const entry = store.addEntry(P, "ghost")
      store.claimEntry(entry.id, "t")
      store.linkEntry(entry.id, "t", "missing-feature")
      expect(store.removeEntry(entry.id)).toMatchObject({ removed: false, refusal: "started" })
    })
  })

  describe("reorder", () => {
    it("reorders unstarted entries and keeps started ones in place", () => {
      const [a, b, c, d] = ["a", "b", "c", "d"].map(c => store.addEntry(P, c).id) as [string, string, string, string]
      store.claimEntry(b, "t")
      store.reorder(P, [d, c, a])
      expect(store.getQueue(P).entries.map(e => e.change)).toEqual(["d", "b", "c", "a"])
    })

    it("rejects started, foreign, unknown and repeated entries without changes", () => {
      const a = store.addEntry(P, "a")
      const b = store.addEntry(P, "b")
      const foreign = store.addEntry("/other", "a")
      store.claimEntry(b.id, "t")
      for (const order of [[a.id, b.id], [a.id, foreign.id], ["nope"], [a.id, a.id]]) {
        let error: unknown
        try {
          store.reorder(P, order)
        } catch (caught) {
          error = caught
        }
        expect((error as ChangeQueueError).code).toBe("invalid_order")
      }
      expect(store.getQueue(P).entries.map(e => e.change)).toEqual(["a", "b"])
    })
  })

  describe("settings", () => {
    it("persists paused and parallelism independently", () => {
      now = 7
      expect(store.setQueueSettings(P, { paused: true })).toEqual({ projectDir: P, paused: true, parallelism: 1, timeUpdated: 7 })
      expect(store.setQueueSettings(P, { parallelism: 3 })).toMatchObject({ paused: true, parallelism: 3 })
      expect(store.setQueueSettings(P, { paused: false })).toMatchObject({ paused: false, parallelism: 3 })
      expect(store.getQueue(P).settings.parallelism).toBe(3)
    })

    it("rejects parallelism below 1 or non-integer, and the CHECK backs it up", () => {
      for (const parallelism of [0, -1, 1.5, Number.NaN]) {
        expect(() => store.setQueueSettings(P, { parallelism })).toThrow(ChangeQueueError)
      }
      expect(store.getQueueSettings(P).timeUpdated).toBeNull()
      expect(() => connection.db.run("INSERT INTO change_queue (project_dir, parallelism, time_updated) VALUES ('x', 0, 1)")).toThrow()
    })
  })

  describe("applyPlannedStates", () => {
    it("persists status, reason and state JSON and writes one audit row per status change", () => {
      const a = store.addEntry(P, "a")
      const b = store.addEntry(P, "b")
      const stateA: QueueEntryState = { kind: "waiting", why: "dependencies", waitingOn: ["x"], reason: "waiting for `x`" }
      const stateB: QueueEntryState = { kind: "blocked", by: "x", stuck: "paused", reason: "blocked: `x` paused" }
      now = 2_000
      const changes = store.applyPlannedStates(P, new Map<string, QueueEntryState>([[a.id, stateA], [b.id, stateB]]))
      expect(changes).toEqual([{ entryId: b.id, from: "waiting", to: "blocked" }])
      expect(store.getQueueEntry(a.id)).toMatchObject({ status: "waiting", reason: "waiting for `x`", state: stateA, timeUpdated: 2_000 })
      expect(store.getQueueEntry(b.id)).toMatchObject({ status: "blocked", reason: stateB.reason, state: stateB })
      expect(store.getQueueTransitions(a.id)).toHaveLength(1)
      expect(store.getQueueTransitions(b.id).map(t => [t.fromStatus, t.toStatus, t.reason, t.time])).toEqual([
        [null, "waiting", "queued; not yet evaluated", 1_000],
        ["waiting", "blocked", stateB.reason, 2_000],
      ])
    })

    it("is idempotent: re-applying the same plan writes nothing", () => {
      const a = store.addEntry(P, "a")
      const plan = new Map<string, QueueEntryState>([[a.id, waiting("limit 1")]])
      store.applyPlannedStates(P, plan)
      now = 5_000
      expect(store.applyPlannedStates(P, plan)).toEqual([])
      expect(store.getQueueEntry(a.id)?.timeUpdated).toBe(1_000)
      expect(store.getQueueTransitions(a.id)).toHaveLength(1)
    })

    it("updates the reason without an audit row when the status is unchanged", () => {
      const a = store.addEntry(P, "a")
      store.applyPlannedStates(P, new Map([[a.id, waiting("one")]]))
      store.applyPlannedStates(P, new Map([[a.id, waiting("two")]]))
      expect(store.getQueueEntry(a.id)?.reason).toBe("two")
      expect(store.getQueueTransitions(a.id)).toHaveLength(1)
    })

    it("never claims, never moves claimed or final entries, ignores foreign and unknown ids", () => {
      const a = store.addEntry(P, "a")
      const b = store.addEntry(P, "b")
      const c = store.addEntry(P, "c")
      const foreign = store.addEntry("/other", "a")
      store.claimEntry(b.id, "t")
      store.removeEntry(c.id)
      const starting: QueueEntryState = { kind: "starting", reason: "starting: all dependencies merged" }
      store.applyPlannedStates(
        P,
        new Map<string, QueueEntryState>([
          [a.id, starting],
          [b.id, waiting("x")],
          [c.id, { kind: "merged" }],
          [foreign.id, waiting("y")],
          ["nope", waiting("z")],
        ]),
      )
      expect(store.getQueueEntry(a.id)?.status).toBe("waiting")
      expect(store.getQueueEntry(b.id)?.status).toBe("starting")
      expect(store.getQueueEntry(c.id)?.status).toBe("removed")
      expect(store.getQueueEntry(foreign.id)?.reason).toBe("queued; not yet evaluated")
    })

    it("round-trips a started entry through running, escalated and merged", () => {
      const a = store.addEntry(P, "a")
      store.claimEntry(a.id, "t")
      store.linkEntry(a.id, "t", "f1")
      const escalated: QueueEntryState = { kind: "escalated", featureStatus: "escalated", reason: "feature escalated" }
      store.applyPlannedStates(P, new Map([[a.id, escalated]]))
      expect(store.getQueueEntry(a.id)).toMatchObject({ status: "escalated", state: escalated, featureId: "f1" })
      store.applyPlannedStates(P, new Map<string, QueueEntryState>([[a.id, { kind: "merged" }]]))
      expect(store.getQueueEntry(a.id)).toMatchObject({ status: "merged", reason: null, state: { kind: "merged" }, featureId: "f1" })
      expect(store.getQueueTransitions(a.id).map(t => t.toStatus)).toEqual(["waiting", "starting", "running", "escalated", "merged"])
    })

    it("rolls back every row when a write fails mid-transaction", () => {
      const a = store.addEntry(P, "a")
      const b = store.addEntry(P, "b")
      connection.db.run(
        `CREATE TRIGGER fail_audit BEFORE INSERT ON change_queue_transition WHEN NEW.to_status = 'invalid' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      )
      expect(() =>
        store.applyPlannedStates(
          P,
          new Map<string, QueueEntryState>([
            [a.id, { kind: "blocked", by: "x", stuck: "escalated", reason: "r" }],
            [b.id, { kind: "invalid", diagnostics: [], reason: "bad" }],
          ]),
        ),
      ).toThrow()
      expect(store.getQueue(P).entries.map(e => e.status)).toEqual(["waiting", "waiting"])
    })
  })

  describe("claim / link / release", () => {
    it("claims exactly once under two competing claims, across store instances", () => {
      const a = store.addEntry(P, "a")
      const second = new Store(connection.db, { now: () => now })
      const results = [store.claimEntry(a.id, "t1", 10), second.claimEntry(a.id, "t2", 11)]
      expect(results).toEqual([true, false])
      expect(store.getQueueEntry(a.id)).toMatchObject({ status: "starting", claimToken: "t1", claimedAt: 10 })
      expect(store.getQueueTransitions(a.id).filter(t => t.toStatus === "starting")).toHaveLength(1)
    })

    it("claims exactly once across two connections to the same file", () => {
      const a = store.addEntry(P, "a")
      const other = openDatabase({ path: connection.path })
      try {
        const second = new Store(other.db)
        const results = [store.claimEntry(a.id, "t1"), second.claimEntry(a.id, "t2")]
        expect(results.filter(Boolean)).toHaveLength(1)
      } finally {
        other.close()
      }
    })

    it("only claims a waiting entry", () => {
      const a = store.addEntry(P, "a")
      const b = store.addEntry(P, "b")
      store.removeEntry(b.id)
      expect(store.claimEntry(b.id, "t")).toBe(false)
      expect(store.claimEntry("nope", "t")).toBe(false)
      store.claimEntry(a.id, "t")
      store.linkEntry(a.id, "t", "f")
      expect(store.claimEntry(a.id, "t2")).toBe(false)
    })

    it("links only with the matching token and only from starting", () => {
      const a = store.addEntry(P, "a")
      expect(store.linkEntry(a.id, "t", "f1")).toBe(false)
      store.claimEntry(a.id, "t", 10)
      expect(store.linkEntry(a.id, "other", "f1")).toBe(false)
      expect(store.linkEntry(a.id, "t", "f1")).toBe(true)
      expect(store.getQueueEntry(a.id)).toMatchObject({ status: "running", featureId: "f1", claimToken: null })
      expect(store.linkEntry(a.id, "t", "f2")).toBe(false)
      expect(store.getQueueEntry(a.id)?.featureId).toBe("f1")
    })

    it("failClaim parks a claimed entry as invalid atomically, only with the matching token", () => {
      const a = store.addEntry(P, "a")
      const invalid = {
        kind: "invalid" as const,
        diagnostics: [{ kind: "start-failed" as const, changes: ["a"] as [string], message: "boom" }],
        reason: "invalid: boom",
      }
      expect(store.failClaim(a.id, "t", invalid)).toBe(false)
      store.claimEntry(a.id, "t", 10)
      expect(store.failClaim(a.id, "wrong", invalid)).toBe(false)
      expect(store.getQueueEntry(a.id)).toMatchObject({ status: "starting", claimToken: "t" })
      expect(store.failClaim(a.id, "t", invalid, 20)).toBe(true)
      expect(store.getQueueEntry(a.id)).toMatchObject({
        status: "invalid",
        reason: "invalid: boom",
        state: invalid,
        claimToken: null,
        claimedAt: null,
      })
      expect(store.getQueueTransitions(a.id).map(t => [t.fromStatus, t.toStatus, t.reason])).toEqual([
        [null, "waiting", "queued; not yet evaluated"],
        ["waiting", "starting", "starting: claimed, feature not created yet"],
        ["starting", "invalid", "invalid: boom"],
      ])
      expect(store.failClaim(a.id, "t", invalid)).toBe(false)
    })

    it("releases only with the matching token, back to waiting", () => {
      const a = store.addEntry(P, "a")
      store.claimEntry(a.id, "t", 10)
      expect(store.releaseClaim(a.id, "wrong")).toBe(false)
      expect(store.releaseClaim(a.id, "t")).toBe(true)
      expect(store.getQueueEntry(a.id)).toMatchObject({ status: "waiting", claimToken: null, claimedAt: null })
      expect(store.releaseClaim(a.id, "t")).toBe(false)
      expect(store.claimEntry(a.id, "t3")).toBe(true)
      expect(store.getQueueTransitions(a.id).map(t => t.toStatus)).toEqual(["waiting", "starting", "waiting", "starting"])
    })
  })
})

describe("0025_change_queue migration", () => {
  it("is additive over the previous schema and leaves existing rows untouched", () => {
    const previous = migrations.slice(0, migrations.findIndex(m => m.id === "0025_change_queue"))
    expect(previous.length).toBeGreaterThan(0)
    const raw = openDatabase({ path: join(directory, "old.db") })
    try {
      runMigrations(raw.db, previous)
      raw.db.run(
        `INSERT INTO feature (id, slug, project_dir, title, status, state, time_created, time_updated)
         VALUES ('f1', 'f', '/p', 'F', 'running', '{}', 1, 1)`,
      )
      expect(runMigrations(raw.db, migrations)).toContain("0025_change_queue")
      const old = new Store(raw.db, { now: () => 50 })
      expect(raw.db.query("SELECT COUNT(*) AS n FROM feature").get()).toEqual({ n: 1 })
      expect(old.getQueue(P).entries).toEqual([])
      const entry = old.addEntry(P, "a")
      expect(old.claimEntry(entry.id, "t", 60)).toBe(true)
      expect(old.linkEntry(entry.id, "t", "f1")).toBe(true)
      expect(runMigrations(raw.db, migrations)).toEqual([])
    } finally {
      raw.close()
    }
  })
})

describe("reconcileStartingEntries", () => {
  function claimed(change: string, token: string, claimedAt: number): string {
    const entry = store.addEntry(P, change)
    expect(store.claimEntry(entry.id, token, claimedAt)).toBe(true)
    return entry.id
  }

  it("releases the claim when the daemon crashed before the feature was created", () => {
    const id = claimed("a", "t", 100)
    createFeatureFor("a", 50) // an older feature for the change is not the one the claim started
    createFeatureFor("other", 150)
    createFeatureFor("a", 150, "/another-project")
    const result = reconcileStartingEntries(store)
    expect(result).toEqual({ linked: [], released: [id] })
    expect(store.getQueueEntry(id)).toMatchObject({ status: "waiting", claimToken: null, featureId: null })
    expect(connection.db.query("SELECT COUNT(*) AS n FROM feature").get()).toEqual({ n: 3 })
  })

  it("links the feature created after the claim when the crash was before the link, without a duplicate", () => {
    const id = claimed("a", "t", 100)
    const featureId = createFeatureFor("a", 120)
    const result = reconcileStartingEntries(store)
    expect(result).toEqual({ linked: [{ entryId: id, featureId }], released: [] })
    expect(store.getQueueEntry(id)).toMatchObject({ status: "running", featureId, claimToken: null })
    expect(connection.db.query("SELECT COUNT(*) AS n FROM feature").get()).toEqual({ n: 1 })
  })

  it("also matches the `change` input and a feature created in the claim's own millisecond", () => {
    const id = claimed("a", "t", 100)
    now = 100
    const featureId = store.createFeature({ title: "A", slug: "a", projectDir: P, workflow: "wf", input: { change: "a" } }).id
    expect(reconcileStartingEntries(store).linked).toEqual([{ entryId: id, featureId }])
  })

  it("leaves an entry that was already linked untouched", () => {
    const id = claimed("a", "t", 100)
    const featureId = createFeatureFor("a", 120)
    expect(store.linkEntry(id, "t", featureId)).toBe(true)
    const before = store.getQueueEntry(id)
    const transitions = store.getQueueTransitions(id)
    expect(reconcileStartingEntries(store)).toEqual({ linked: [], released: [] })
    expect(store.getQueueEntry(id)).toEqual(before)
    expect(store.getQueueTransitions(id)).toEqual(transitions)
  })

  it("never links a feature that another entry already owns", () => {
    const first = claimed("a", "t1", 100)
    const featureId = createFeatureFor("a", 120)
    store.linkEntry(first, "t1", featureId)
    store.applyPlannedStates(P, new Map<string, QueueEntryState>([[first, { kind: "merged" }]]))
    const second = claimed("a", "t2", 200)
    expect(reconcileStartingEntries(store)).toEqual({ linked: [], released: [second] })
  })

  it("uses the injected finder and is idempotent", () => {
    const id = claimed("a", "t", 100)
    const calls: unknown[] = []
    const result = reconcileStartingEntries(store, (projectDir, change, claimedAt) => {
      calls.push([projectDir, change, claimedAt])
      return "feature-x"
    })
    expect(calls).toEqual([[P, "a", 100]])
    expect(result.linked).toEqual([{ entryId: id, featureId: "feature-x" }])
    expect(reconcileStartingEntries(store)).toEqual({ linked: [], released: [] })
  })

  it("survives a real restart of the database", () => {
    const id = claimed("a", "t", 100)
    const featureId = createFeatureFor("a", 120)
    const path = connection.path
    connection.close()
    open(path)
    expect(store.listStartingEntries().map(e => e.id)).toEqual([id])
    expect(reconcileStartingEntries(store).linked).toEqual([{ entryId: id, featureId }])
  })
})
