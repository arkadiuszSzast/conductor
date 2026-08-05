import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import { openDatabase, openMigratedDatabase, resolveDatabasePath } from "./src/database.ts"
import { migrations, runMigrations, type Migration } from "./src/migrations.ts"
import { Store } from "./src/store.ts"

const directories: string[] = []

function temporaryPath(name = "state.db"): string {
  const directory = mkdtempSync(join(tmpdir(), "conductor-db-"))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tableNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
}

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
}

describe("database lifecycle and migrations", () => {
  it("creates the complete legacy-compatible schema and migration ledger", () => {
    const connection = openMigratedDatabase({ path: temporaryPath() })
    expect(tableNames(connection.db)).toEqual(expect.arrayContaining([
      "feature", "finding", "pr_head", "review_thread", "schema_migration", "step_run", "transition_log",
    ]))
    expect(columnNames(connection.db, "feature")).toEqual(expect.arrayContaining(["workflow", "description"]))
    expect(columnNames(connection.db, "step_run")).toContain("nudges")
    const ledger = connection.db.query("SELECT id FROM schema_migration ORDER BY position").all() as Array<{ id: string }>
    expect(ledger.map(row => row.id)).toEqual(migrations.map(migration => migration.id))
    connection.close()
  })

  it("is idempotent and executes migrations monotonically in declaration order", () => {
    const connection = openDatabase({ path: temporaryPath() })
    const observed: string[] = []
    const ordered: Migration[] = [
      { id: "one", up: db => { observed.push("one"); db.run("CREATE TABLE ordered_one (id INTEGER)") } },
      { id: "two", up: db => { observed.push("two"); db.run("CREATE TABLE ordered_two (id INTEGER)") } },
    ]
    expect(runMigrations(connection.db, ordered)).toEqual(["one", "two"])
    expect(runMigrations(connection.db, ordered)).toEqual([])
    expect(observed).toEqual(["one", "two"])
    connection.db.run("VACUUM")
    connection.close()
    const reopened = openDatabase({ path: connection.path })
    expect(runMigrations(reopened.db, ordered)).toEqual([])
    reopened.close()
  })

  it("rolls back a failed migration and does not write its ledger entry", () => {
    const connection = openDatabase({ path: temporaryPath() })
    const ordered: Migration[] = [
      { id: "one", up: db => db.run("CREATE TABLE stable (id INTEGER)") },
      { id: "two", up: db => { db.run("CREATE TABLE partial (id INTEGER)"); throw new Error("interrupted") } },
    ]
    expect(() => runMigrations(connection.db, ordered)).toThrow("interrupted")
    expect(tableNames(connection.db)).toContain("stable")
    expect(tableNames(connection.db)).not.toContain("partial")
    expect(connection.db.query("SELECT id FROM schema_migration ORDER BY rowid").all()).toEqual([{ id: "one" }])
    expect(runMigrations(connection.db, [ordered[0]!, { id: "two", up: db => db.run("CREATE TABLE recovered (id INTEGER)") }])).toEqual(["two"])
    connection.close()
  })

  it("rejects a ledger that is not a known ordered prefix", () => {
    const ordered: Migration[] = [{ id: "one", up: () => {} }, { id: "two", up: () => {} }]
    for (const rows of [
      [["two", 0]],
      [["one", 1]],
      [["one", 0], ["two", 2]],
      [["one", 10], ["two", 11]],
    ] as const) {
      const connection = openDatabase({ path: temporaryPath() })
      connection.db.run("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, applied_at INTEGER NOT NULL)")
      for (const [id, position] of rows) connection.db.run("INSERT INTO schema_migration VALUES (?, ?, 1)", [id, position])
      expect(() => runMigrations(connection.db, ordered)).toThrow("not a known monotonic prefix")
      connection.close()
    }
  })

  it("enables WAL and foreign keys on every opened connection", () => {
    const path = temporaryPath()
    const first = openMigratedDatabase({ path })
    expect((first.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal")
    expect((first.db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1)
    first.close()
    const second = openDatabase({ path })
    expect((second.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal")
    expect((second.db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1)
    second.close()
  })

  it("uses only the configured path", () => {
    const configured = temporaryPath("configured.db")
    expect(resolveDatabasePath({ path: configured })).toBe(configured)
    expect(isAbsolute(resolveDatabasePath({ path: "relative.db" }))).toBe(true)
    expect(() => resolveDatabasePath({ path: " " })).toThrow("must not be empty")
  })
})

describe("legacy database adoption", () => {
  it("adopts the populated initial seed schema without a ledger", () => {
    const path = temporaryPath()
    const legacy = new Database(path, { create: true })
    legacy.run(`
      CREATE TABLE feature (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL, project_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', current_step TEXT, session_id TEXT, worktree TEXT,
        branch TEXT, pr INTEGER, attempts TEXT NOT NULL DEFAULT '{}', rounds TEXT NOT NULL DEFAULT '{}',
        escalation TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      )
    `)
    legacy.run(`
      CREATE TABLE step_run (
        id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL, step_type TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'running', role TEXT, model TEXT, session_id TEXT,
        output TEXT, reason TEXT, time_started INTEGER NOT NULL, time_finished INTEGER
      )
    `)
    legacy.run(
      `INSERT INTO feature (id, title, slug, project_dir, status, current_step, attempts, rounds, escalation, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["initial-feature", "Initial", "initial", "/project", "escalated", "review", '{"review":4}', '{"review":2}', "budget exhausted", 1, 2],
    )
    legacy.run(
      `INSERT INTO step_run (id, feature_id, step_id, step_type, attempt, status, time_started)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["initial-run", "initial-feature", "review", "agent", 4, "running", 1],
    )
    legacy.close()

    const adopted = openMigratedDatabase({ path })
    const store = new Store(adopted.db)
    expect(store.getFeature("initial-feature")).toMatchObject({
      status: "escalated",
      currentStep: "review",
      attempts: { review: 4 },
      rounds: { review: 2 },
      workflow: null,
      description: null,
    })
    expect(store.getActiveRun("initial-feature")).toMatchObject({ id: "initial-run", nudges: 0 })
    expect((adopted.db.query("SELECT escalation FROM feature WHERE id = ?").get("initial-feature") as { escalation: string }).escalation).toBe("budget exhausted")
    adopted.close()
  })

  it("preserves in-flight feature, findings, review metadata, audit and restart state", () => {
    const path = temporaryPath()
    const legacy = new Database(path, { create: true })
    legacy.run(`
      CREATE TABLE feature (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL, project_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', current_step TEXT, session_id TEXT, worktree TEXT,
        branch TEXT, pr INTEGER, attempts TEXT NOT NULL DEFAULT '{}', rounds TEXT NOT NULL DEFAULT '{}',
        escalation TEXT, workflow TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      )
    `)
    legacy.run(`
      CREATE TABLE step_run (
        id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL, step_type TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'running', role TEXT, model TEXT, session_id TEXT, output TEXT,
        reason TEXT, nudges INTEGER NOT NULL DEFAULT 0, time_started INTEGER NOT NULL, time_finished INTEGER
      )
    `)
    legacy.run(`
      CREATE TABLE finding (
        id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, step_id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL,
        severity TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new', resolution TEXT, thread_id TEXT,
        synced INTEGER NOT NULL DEFAULT 0, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      )
    `)
    legacy.run(`
      CREATE TABLE review_thread (
        thread_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
        pr INTEGER NOT NULL, path TEXT NOT NULL DEFAULT '', opened_by TEXT NOT NULL DEFAULT '',
        last_reply_by TEXT NOT NULL DEFAULT '', last_reply TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', time_seen INTEGER NOT NULL, time_resolved INTEGER
      )
    `)
    legacy.run(`
      CREATE TABLE transition_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, event TEXT NOT NULL,
        decision TEXT NOT NULL, detail TEXT, time_created INTEGER NOT NULL
      )
    `)
    const now = 1_700_000_000_000
    legacy.run(
      `INSERT INTO feature (id, title, slug, project_dir, status, current_step, session_id, worktree, branch, pr, attempts, rounds, escalation, workflow, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["legacy-feature", "Legacy", "legacy", "/projects/example", "waiting_human", "merge", "session-1", "/worktrees/legacy", "feat/legacy", 42, '{"review":2}', '{"review":3}', null, "consensus", now, now],
    )
    legacy.run(
      `INSERT INTO step_run (id, feature_id, step_id, step_type, attempt, status, role, session_id, output, reason, nudges, time_started)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["run-1", "legacy-feature", "merge", "agent", 2, "running", "reviewer", "child-1", null, null, 1, now],
    )
    legacy.run(
      `INSERT INTO finding (id, feature_id, seq, step_id, path, line, severity, tags, body, status, resolution, thread_id, synced, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["legacy-feature:F1", "legacy-feature", 1, "review", "src/app.ts", 12, "major", '["security"]', "Fix this", "reopened", "needs follow-up", "thread-1", 0, now, now],
    )
    legacy.run(
      `INSERT INTO review_thread (thread_id, feature_id, pr, path, opened_by, last_reply_by, last_reply, status, time_seen, time_resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["thread-1", "legacy-feature", 42, "src/app.ts", "bot", "human", "still open", "reopened", now, null],
    )
    legacy.run(
      "INSERT INTO transition_log (feature_id, event, decision, detail, time_created) VALUES (?, ?, ?, ?, ?)",
      ["legacy-feature", '{"kind":"feature.start"}', "execute", "review", now],
    )
    legacy.close()

    const adopted = openMigratedDatabase({ path })
    const store = new Store(adopted.db)
    expect(store.getFeature("legacy-feature")).toEqual({
      id: "legacy-feature",
      title: "Legacy",
      slug: "legacy",
      projectDir: "/projects/example",
      workflow: "consensus",
      description: null,
      status: "waiting_human",
      currentStep: "merge",
      sessionId: "session-1",
      worktree: "/worktrees/legacy",
      branch: "feat/legacy",
      pr: 42,
      attempts: { review: 2 },
      rounds: { review: 3 },
    })
    expect(store.getActiveRun("legacy-feature")).toMatchObject({ id: "run-1", attempt: 2, nudges: 1 })
    expect((adopted.db.query("SELECT escalation FROM feature WHERE id = ?").get("legacy-feature") as { escalation: string | null }).escalation).toBeNull()
    expect(store.listFindings("legacy-feature")).toEqual([expect.objectContaining({ id: "F1", status: "reopened", resolution: "needs follow-up", threadId: "thread-1", tags: ["security"] })])
    expect(store.getTransitions("legacy-feature")).toEqual([expect.objectContaining({ decision: "execute", detail: "review" })])
    expect((adopted.db.query("SELECT status, last_reply FROM review_thread WHERE thread_id = ?").get("thread-1") as { status: string; last_reply: string })).toEqual({ status: "reopened", last_reply: "still open" })
    adopted.close()

    const restarted = openMigratedDatabase({ path })
    expect(new Store(restarted.db).getFeature("legacy-feature")?.currentStep).toBe("merge")
    expect(restarted.db.query("SELECT COUNT(*) AS count FROM schema_migration").get()).toEqual({ count: migrations.length })
    restarted.close()
  })
})
