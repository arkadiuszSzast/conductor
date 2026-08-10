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
  it("creates the graph-state schema and migration ledger", () => {
    const connection = openMigratedDatabase({ path: temporaryPath() })
    expect(tableNames(connection.db)).toEqual(expect.arrayContaining([
      "feature", "finding", "review_thread", "run", "schema_migration", "transition_log",
    ]))
    expect(tableNames(connection.db)).not.toContain("pr_head")
    expect(tableNames(connection.db)).not.toContain("step_run")
    expect(columnNames(connection.db, "feature")).toEqual(expect.arrayContaining(["state", "feedback", "workflow", "description"]))
    expect(columnNames(connection.db, "run")).toEqual(expect.arrayContaining([
      "job_id", "step_id", "nudges", "completion_event", "completion_decisions", "action_handled",
    ]))
    const ledger = connection.db.query("SELECT id FROM schema_migration ORDER BY position").all() as Array<{ id: string }>
    expect(ledger.map(row => row.id)).toEqual(migrations.map(migration => migration.id))
    connection.close()
  })

  it("the ledger is an append-only exact prefix of the compiled migration list", () => {
    expect(migrations[0]!.id).toBe("0001_legacy_pipeline_schema")
    expect(migrations.map(m => m.id)).toContain("0008_graph_state_schema")
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

describe("graph feature state round-trips through the store", () => {
  it("persists and reads back a feature's full graph state across a close/reopen", () => {
    const path = temporaryPath()
    const connection = openMigratedDatabase({ path })
    const store = new Store(connection.db)
    const feature = store.createFeature({ title: "Graph", slug: "graph", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "implement" }],
      patch: { status: "running", jobs: { main: { status: "running", currentStep: "implement", steps: { implement: { status: "running" } } } } },
    })
    connection.close()

    const reopened = openMigratedDatabase({ path })
    const reopenedStore = new Store(reopened.db)
    const recovered = reopenedStore.getFeature(feature.id)
    expect(recovered?.jobs["main"]).toMatchObject({ status: "running", currentStep: "implement" })
    reopened.close()
  })
})
