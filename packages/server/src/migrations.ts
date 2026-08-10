import type { Database } from "bun:sqlite"

export interface Migration {
  readonly id: string
  readonly up: (db: Database) => void
}

interface MigrationRow {
  id: string
  position: number
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
}

function addColumn(db: Database, table: string, name: string, definition: string): void {
  if (!columns(db, table).includes(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}

export const migrations: readonly Migration[] = [
  {
    id: "0001_legacy_pipeline_schema",
    up(db) {
      db.run(`
        CREATE TABLE IF NOT EXISTS feature (
          id            TEXT PRIMARY KEY,
          title         TEXT NOT NULL,
          slug          TEXT NOT NULL,
          project_dir   TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'running'
                          CHECK(status IN ('running','paused','waiting_human','escalated','done','abandoned')),
          current_step  TEXT,
          session_id    TEXT,
          worktree      TEXT,
          branch        TEXT,
          pr            INTEGER,
          attempts      TEXT NOT NULL DEFAULT '{}',
          rounds        TEXT NOT NULL DEFAULT '{}',
          escalation    TEXT,
          time_created  INTEGER NOT NULL,
          time_updated  INTEGER NOT NULL
        )
      `)
      db.run(`
        CREATE TABLE IF NOT EXISTS step_run (
          id            TEXT PRIMARY KEY,
          feature_id    TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          step_id       TEXT NOT NULL,
          step_type     TEXT NOT NULL CHECK(step_type IN ('builtin','command','agent')),
          attempt       INTEGER NOT NULL DEFAULT 1,
          status        TEXT NOT NULL DEFAULT 'running'
                          CHECK(status IN ('running','succeeded','failed','reaped')),
          role          TEXT,
          model         TEXT,
          session_id    TEXT,
          output        TEXT,
          reason        TEXT,
          time_started  INTEGER NOT NULL,
          time_finished INTEGER
        )
      `)
      db.run(`
        CREATE TABLE IF NOT EXISTS pr_head (
          feature_id    TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          pr            INTEGER NOT NULL,
          head_sha      TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'awaiting_ci'
                          CHECK(status IN ('awaiting_ci','ci_failed','ci_green','review_pending',
                                           'in_review','approved','changes_requested',
                                           'superseded','timed_out')),
          time_created  INTEGER NOT NULL,
          time_updated  INTEGER NOT NULL,
          PRIMARY KEY (pr, head_sha)
        )
      `)
      db.run(`
        CREATE TABLE IF NOT EXISTS transition_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          feature_id    TEXT NOT NULL,
          event         TEXT NOT NULL,
          decision      TEXT NOT NULL,
          detail        TEXT,
          time_created  INTEGER NOT NULL
        )
      `)
      db.run("CREATE INDEX IF NOT EXISTS idx_step_run_feature ON step_run(feature_id, time_started)")
      db.run("CREATE INDEX IF NOT EXISTS idx_transition_feature ON transition_log(feature_id, time_created)")
    },
  },
  {
    id: "0002_feature_workflow",
    up(db) {
      addColumn(db, "feature", "workflow", "TEXT")
    },
  },
  {
    id: "0003_step_run_nudges",
    up(db) {
      addColumn(db, "step_run", "nudges", "INTEGER NOT NULL DEFAULT 0")
    },
  },
  {
    id: "0004_review_thread",
    up(db) {
      db.run(`
        CREATE TABLE IF NOT EXISTS review_thread (
          thread_id     TEXT PRIMARY KEY,
          feature_id    TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          pr            INTEGER NOT NULL,
          path          TEXT NOT NULL DEFAULT '',
          opened_by     TEXT NOT NULL DEFAULT '',
          last_reply_by TEXT NOT NULL DEFAULT '',
          last_reply    TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'open'
                          CHECK(status IN ('open','auto_resolved','reopened')),
          time_seen     INTEGER NOT NULL,
          time_resolved INTEGER
        )
      `)
    },
  },
  {
    id: "0005_finding",
    up(db) {
      db.run(`
        CREATE TABLE IF NOT EXISTS finding (
          id            TEXT PRIMARY KEY,
          feature_id    TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          seq           INTEGER NOT NULL,
          step_id       TEXT NOT NULL,
          path          TEXT NOT NULL,
          line          INTEGER NOT NULL,
          severity      TEXT NOT NULL,
          tags          TEXT NOT NULL DEFAULT '[]',
          body          TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'new'
                          CHECK(status IN ('new','fixed','dismissed','reopened')),
          resolution    TEXT,
          thread_id     TEXT,
          synced        INTEGER NOT NULL DEFAULT 0,
          time_created  INTEGER NOT NULL,
          time_updated  INTEGER NOT NULL
        )
      `)
      db.run("CREATE INDEX IF NOT EXISTS idx_finding_feature ON finding(feature_id, seq)")
    },
  },
  {
    id: "0006_feature_description",
    up(db) {
      addColumn(db, "feature", "description", "TEXT")
    },
  },
  {
    id: "0007_step_run_completion_event",
    up(db) {
      // Durable completion event and decision outbox for atomic transition recovery.
      addColumn(db, "step_run", "completion_event", "TEXT")
      addColumn(db, "step_run", "completion_decision", "TEXT")
      addColumn(db, "step_run", "action_handled", "INTEGER NOT NULL DEFAULT 0")
    },
  },
  {
    id: "0008_graph_state_schema",
    up(db) {
      // The seed pipeline model (single current_step, attempts/rounds maps,
      // pr_head tracking) is deleted outright — greenfield, no data exists
      // anywhere. `feature` and `step_run` are dropped and recreated for
      // the @conductor/core graph FeatureState model; `transition_log`
      // gains room for multi-decision (fan-out) transitions. `finding`
      // and `review_thread` are untouched (kept read-only for now).
      db.run("DROP TABLE IF EXISTS pr_head")
      db.run("DROP TABLE IF EXISTS step_run")
      db.run("DROP TABLE IF EXISTS transition_log")
      db.run("DROP TABLE IF EXISTS feature")

      db.run(`
        CREATE TABLE feature (
          id            TEXT PRIMARY KEY,
          slug          TEXT NOT NULL,
          project_dir   TEXT NOT NULL,
          title         TEXT NOT NULL,
          workflow      TEXT,
          description   TEXT,
          status        TEXT NOT NULL DEFAULT 'running'
                          CHECK(status IN ('running','paused','waiting_human','escalated','done','abandoned')),
          pr            INTEGER,
          escalation    TEXT,
          state         TEXT NOT NULL,
          feedback      TEXT,
          time_created  INTEGER NOT NULL,
          time_updated  INTEGER NOT NULL
        )
      `)
      db.run(`
        CREATE TABLE run (
          id                    TEXT PRIMARY KEY,
          feature_id            TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id                TEXT NOT NULL,
          step_id               TEXT NOT NULL,
          step_type             TEXT NOT NULL CHECK(step_type IN ('agent','command')),
          attempt               INTEGER NOT NULL DEFAULT 1,
          status                TEXT NOT NULL DEFAULT 'running'
                                  CHECK(status IN ('running','succeeded','failed','reaped')),
          session_id            TEXT,
          outputs               TEXT NOT NULL DEFAULT '{}',
          reason                TEXT,
          nudges                INTEGER NOT NULL DEFAULT 0,
          completion_event      TEXT,
          completion_decisions  TEXT,
          action_handled        INTEGER NOT NULL DEFAULT 0,
          time_started          INTEGER NOT NULL,
          time_finished         INTEGER
        )
      `)
      db.run(`
        CREATE TABLE transition_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          feature_id    TEXT NOT NULL,
          event         TEXT NOT NULL,
          decisions     TEXT NOT NULL,
          time_created  INTEGER NOT NULL
        )
      `)
      db.run("CREATE INDEX IF NOT EXISTS idx_run_feature ON run(feature_id, time_started)")
      db.run("CREATE INDEX IF NOT EXISTS idx_transition_feature ON transition_log(feature_id, time_created)")
    },
  },
  {
    id: "0009_run_action_metadata",
    up(db) {
      // `action` joins `agent`/`command` as a step type, and an action run
      // records its resolved identity (uses, manifest version, content
      // digest) as JSON metadata. SQLite cannot ALTER a CHECK constraint in
      // place, so the table is rebuilt — same technique as 0008, this time
      // preserving any existing rows.
      db.run("ALTER TABLE run RENAME TO run_old")
      db.run(`
        CREATE TABLE run (
          id                    TEXT PRIMARY KEY,
          feature_id            TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id                TEXT NOT NULL,
          step_id               TEXT NOT NULL,
          step_type             TEXT NOT NULL CHECK(step_type IN ('agent','command','action')),
          attempt               INTEGER NOT NULL DEFAULT 1,
          status                TEXT NOT NULL DEFAULT 'running'
                                  CHECK(status IN ('running','succeeded','failed','reaped')),
          session_id            TEXT,
          outputs               TEXT NOT NULL DEFAULT '{}',
          reason                TEXT,
          nudges                INTEGER NOT NULL DEFAULT 0,
          completion_event      TEXT,
          completion_decisions  TEXT,
          action_handled        INTEGER NOT NULL DEFAULT 0,
          metadata              TEXT,
          time_started          INTEGER NOT NULL,
          time_finished         INTEGER
        )
      `)
      db.run(`
        INSERT INTO run (id, feature_id, job_id, step_id, step_type, attempt, status, session_id,
                          outputs, reason, nudges, completion_event, completion_decisions, action_handled,
                          time_started, time_finished)
        SELECT id, feature_id, job_id, step_id, step_type, attempt, status, session_id,
               outputs, reason, nudges, completion_event, completion_decisions, action_handled,
               time_started, time_finished
        FROM run_old
      `)
      db.run("DROP TABLE run_old")
      db.run("CREATE INDEX IF NOT EXISTS idx_run_feature ON run(feature_id, time_started)")
    },
  },
]

function validateMigrations(ordered: readonly Migration[]): void {
  const ids = new Set<string>()
  for (const migration of ordered) {
    if (ids.has(migration.id)) throw new Error(`duplicate migration id: ${migration.id}`)
    ids.add(migration.id)
  }
}

export function runMigrations(db: Database, ordered: readonly Migration[] = migrations): readonly string[] {
  validateMigrations(ordered)
  db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        id         TEXT PRIMARY KEY,
        position   INTEGER NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      )
    `)
  })()

  const applied = db.query("SELECT id, position FROM schema_migration ORDER BY position").all() as MigrationRow[]
  for (const [index, row] of applied.entries()) {
    if (row.position !== index || ordered[index]?.id !== row.id) {
      throw new Error(`migration ledger is not a known monotonic prefix at ${row.id}`)
    }
  }

  const newlyApplied: string[] = []
  for (const [offset, migration] of ordered.slice(applied.length).entries()) {
    db.transaction(() => {
      migration.up(db)
      db.run("INSERT INTO schema_migration (id, position, applied_at) VALUES (?, ?, ?)", [
        migration.id,
        applied.length + offset,
        Date.now(),
      ])
    })()
    newlyApplied.push(migration.id)
  }
  return newlyApplied
}
