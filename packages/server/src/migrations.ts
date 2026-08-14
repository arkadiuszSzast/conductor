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
  {
    id: "0010_run_pending_observation",
    up(db) {
      // Durable pending observation: a polling action's run row stays
      // 'running' across observations instead of accumulating a new run
      // row per poll or holding its detached execution open for the
      // whole window. `pending_state` is the opaque JSON the action asked
      // for back; `next_observation` is when the reconciler should
      // re-invoke it.
      addColumn(db, "run", "pending_state", "TEXT")
      addColumn(db, "run", "next_observation", "INTEGER")
    },
  },
  {
    id: "0011_run_log",
    up(db) {
      // Per-run narrative log: command output, action-host chatter, agent
      // transcripts and step-author lines. Append-only with a monotonic
      // per-run seq (the read API's cursor); the composite PK doubles as
      // the (run_id, seq) index. A per-run size cap is enforced at write
      // time in the store — the schema itself stays unbounded.
      db.run(`
        CREATE TABLE run_log (
          run_id  TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
          seq     INTEGER NOT NULL,
          time    INTEGER NOT NULL,
          source  TEXT NOT NULL,
          chunk   TEXT NOT NULL,
          PRIMARY KEY (run_id, seq)
        )
      `)
    },
  },
  {
    id: "0012_run_pending_question",
    up(db) {
      // Interactive steps: a running agent run may ask a human a question
      // and stay alive waiting for the answer. The question is run state
      // (the step stays running with the same active run) — persisted so
      // an ask survives a daemon restart.
      addColumn(db, "run", "pending_question", "TEXT")
      addColumn(db, "run", "asked_at", "INTEGER")
    },
  },
  {
    id: "0013_retry_resource_wait_pause",
    up(db) {
      // retry-policy durable state (openspec/changes/retry-policy): a
      // classified failure's envelope on `run`, durable retry episodes/
      // schedules, durable resource waits (no executable attempt begun —
      // distinct from a failed run) and pause-time accounting on
      // `feature`. Additive only: existing rows read back with nullable
      // metadata, nothing here is required for the seed pipeline paths
      // already committed to SQLite.

      // The classified failure an attempt concluded with — `reason`
      // (0008) already carries the bounded human diagnostic; these three
      // add the machine-readable class/source/hint the retry-policy
      // taxonomy defines (packages/core/src/failure.ts). CHECK mirrors
      // FAILURE_CLASSES; kept in sync by convention since a shipped
      // migration is never edited — a future class needs a new migration.
      addColumn(
        db, "run", "failure_class",
        `TEXT CHECK(failure_class IS NULL OR failure_class IN (
          'transient_upstream','transient_transport','capacity','timeout',
          'deterministic_failure','invalid_config','missing_session','cancelled','internal'
        ))`,
      )
      addColumn(db, "run", "failure_source", "TEXT")
      addColumn(db, "run", "failure_retry_hint_ms", "INTEGER")

      // One executing attempt per job+step, durable at the DB level —
      // "enforce one active attempt per target" (durable-retries design).
      // Existing dispatch already keeps this true in practice
      // (getActiveRunForStep guards re-dispatch); this makes it a
      // constraint instead of a convention.
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_run_one_active_target
        ON run(feature_id, job_id, step_id) WHERE status = 'running'
      `)

      // A retry episode: the durable state behind decideFailureRoute's
      // route intent (packages/core/src/lifecycle.ts). `attempts`/
      // `started_at`/`paused_ms` mirror RetryEpisodeState so the engine
      // can round-trip a row straight into the pure decision function.
      // `next_attempt_at`/`delay_ms`/`schedule_source` are null once
      // claimed or closed — a claimed/closed episode is not "due" by
      // construction. `recovered_from` chains an operator-recovered
      // episode to the one it replaced (retry-budget spec: "old failure
      // history remains in the timeline").
      db.run(`
        CREATE TABLE IF NOT EXISTS retry_episode (
          id                          TEXT PRIMARY KEY,
          feature_id                  TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id                      TEXT NOT NULL,
          step_id                     TEXT NOT NULL,
          status                      TEXT NOT NULL DEFAULT 'scheduled'
                                        CHECK(status IN ('scheduled','claimed','closed')),
          attempts                    INTEGER NOT NULL,
          started_at                  INTEGER NOT NULL,
          paused_ms                   INTEGER NOT NULL DEFAULT 0,
          next_attempt_at             INTEGER,
          delay_ms                    INTEGER,
          schedule_source             TEXT CHECK(schedule_source IS NULL OR schedule_source IN ('backoff','retry_hint')),
          max_attempts                INTEGER NOT NULL,
          max_elapsed_ms              INTEGER NOT NULL,
          last_failure_class          TEXT CHECK(last_failure_class IS NULL OR last_failure_class IN (
                                         'transient_upstream','transient_transport','capacity','timeout',
                                         'deterministic_failure','invalid_config','missing_session','cancelled','internal'
                                       )),
          last_failure_source         TEXT,
          last_failure_diagnostic     TEXT,
          last_failure_retry_hint_ms  INTEGER,
          last_failure_at             INTEGER,
          recovered_from              TEXT REFERENCES retry_episode(id),
          version                     INTEGER NOT NULL DEFAULT 0,
          closed_reason               TEXT,
          time_created                INTEGER NOT NULL,
          time_updated                INTEGER NOT NULL
        )
      `)
      // "one active attempt per target" extends to scheduling: at most
      // one open (not yet claimed-and-concluded) episode per job+step.
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_episode_open_target
        ON retry_episode(feature_id, job_id, step_id) WHERE status IN ('scheduled','claimed')
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_retry_episode_due
        ON retry_episode(status, next_attempt_at) WHERE status = 'scheduled'
      `)
      db.run("CREATE INDEX IF NOT EXISTS idx_retry_episode_feature ON retry_episode(feature_id, time_created)")

      // A resource wait: no executable attempt began (failure.ts:
      // ResourceReason), so it is tracked separately from a failed run
      // and never touches a step's retry-attempt budget. `deadline_at`
      // and `first_observed_at` are fixed once at creation; only
      // `latest_observed_at`/`observation_count`/`next_observation_at`/
      // `diagnostic` move on repeated observation.
      db.run(`
        CREATE TABLE IF NOT EXISTS resource_wait (
          id                    TEXT PRIMARY KEY,
          feature_id            TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id                TEXT NOT NULL,
          step_id                TEXT NOT NULL,
          status                TEXT NOT NULL DEFAULT 'waiting'
                                  CHECK(status IN ('waiting','claimed','closed')),
          reason                TEXT NOT NULL
                                  CHECK(reason IN ('runner_unavailable','binding_unavailable','dependency_unavailable')),
          first_observed_at     INTEGER NOT NULL,
          latest_observed_at    INTEGER NOT NULL,
          observation_count     INTEGER NOT NULL DEFAULT 1,
          next_observation_at   INTEGER,
          deadline_at           INTEGER NOT NULL,
          diagnostic            TEXT,
          version               INTEGER NOT NULL DEFAULT 0,
          closed_reason         TEXT,
          time_created          INTEGER NOT NULL,
          time_updated          INTEGER NOT NULL
        )
      `)
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_wait_open_target
        ON resource_wait(feature_id, job_id, step_id) WHERE status IN ('waiting','claimed')
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_resource_wait_due
        ON resource_wait(status, next_observation_at) WHERE status = 'waiting'
      `)
      db.run("CREATE INDEX IF NOT EXISTS idx_resource_wait_feature ON resource_wait(feature_id, time_created)")

      // Pause-time accounting (design.md: "budget clocks store
      // accumulated paused duration"). `paused_at` is set the instant a
      // feature enters `paused` and cleared on the instant it leaves;
      // `paused_ms` accumulates the closed spans. Both live outside
      // `FeatureState` (interpreter never writes them) same as
      // `escalation`/timestamps already do.
      addColumn(db, "feature", "paused_at", "INTEGER")
      addColumn(db, "feature", "paused_ms", "INTEGER NOT NULL DEFAULT 0")
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
