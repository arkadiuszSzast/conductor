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
  {
    id: "0014_answer_delivery",
    up(db) {
      // harden-interactive-answer-delivery: an accepted human answer is
      // durable BEFORE the runner prompt side effect is attempted — the
      // confirmation-of-effect split `concludeRun`'s completion-decision
      // outbox already applies to run conclusion, extended here to the
      // answer path. `question_generation` is the asking run's
      // `asked_at` at acceptance time — pending_question has no explicit
      // generation counter, and a run's asked_at is refreshed on every
      // new ask, so it is already the per-run identifier of the CURRENT
      // open question. `delivery_token` is Conductor's own idempotency
      // marker, carried into the prompt so an opencode-side dedup can
      // recognize a redelivered prompt across the narrow at-least-once
      // crash edge (design.md: "Treat confirmation strength as a runner
      // boundary"). No existing `run` row needs rewriting: a delivery
      // row is created only once an answer is accepted, never for the
      // ask itself.
      db.run(`
        CREATE TABLE answer_delivery (
          id                    TEXT PRIMARY KEY,
          feature_id            TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          run_id                TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
          job_id                TEXT NOT NULL,
          step_id               TEXT NOT NULL,
          question_generation   INTEGER NOT NULL,
          notes                 TEXT NOT NULL,
          target_session_id     TEXT,
          delivery_token        TEXT NOT NULL,
          status                TEXT NOT NULL DEFAULT 'pending'
                                  CHECK(status IN ('pending','claimed','delivered','failed','cancelled')),
          failure_detail        TEXT,
          claimed_at            INTEGER,
          lease_expires_at      INTEGER,
          version               INTEGER NOT NULL DEFAULT 0,
          time_created          INTEGER NOT NULL,
          time_updated          INTEGER NOT NULL
        )
      `)
      // One non-terminal (pending/claimed) delivery per run — the
      // acceptance-tx uniqueness a racing duplicate answer loses.
      db.run(`
        CREATE UNIQUE INDEX idx_answer_delivery_open_run
        ON answer_delivery(run_id) WHERE status IN ('pending','claimed')
      `)
      db.run(`
        CREATE INDEX idx_answer_delivery_due
        ON answer_delivery(status, lease_expires_at) WHERE status IN ('pending','claimed')
      `)
      db.run("CREATE INDEX idx_answer_delivery_feature ON answer_delivery(feature_id, time_created)")
    },
  },
  {
    id: "0015_answer_delivery_retry_schedule",
    up(db) {
      // harden-interactive-answer-delivery review fix: a transient prompt
      // failure previously released a delivery straight back to `pending`
      // FOREVER — every reconcile pass re-attempted it immediately with
      // no bound, so a persistently unreachable session/runner retried
      // without limit instead of eventually routing through normal run
      // failure like every other classified failure does (retry-policy's
      // conservative-finite-default discipline, extended here to answer
      // delivery). Three additive columns, same finite-schedule shape
      // `retry_episode` already uses: `attempt_count` (delivery attempts
      // made so far, starts at 0 — mirrors `retry_episode.attempts`),
      // `next_attempt_at` (when this delivery becomes due again; NULL
      // means "due now", matching a fresh `pending` row with no schedule
      // yet), `deadline_at` (the finite wall-clock elapsed deadline from
      // acceptance, computed once at INSERT time from the SAME
      // `transient_upstream`/`transient_transport` class-default budget
      // `behaviourForClass` already returns — never silently infinite).
      // No existing row needs rewriting: every pre-migration delivery is
      // already terminal (delivered/failed/cancelled) or was `pending`
      // with no schedule, which the NULL/0 defaults represent exactly.
      addColumn(db, "answer_delivery", "attempt_count", "INTEGER NOT NULL DEFAULT 0")
      addColumn(db, "answer_delivery", "next_attempt_at", "INTEGER")
      addColumn(db, "answer_delivery", "deadline_at", "INTEGER")
    },
  },
  {
    id: "0016_recovery_dispatch",
    up(db) {
      // Durable recovery-dispatch intent: `store.recoverStepTargets`
      // atomically flips an escalated feature back to `running` with the
      // recovered step armed as its `currentStep`, but the run/resource-
      // wait that anchors it durably is only created AFTERWARD, in
      // `Engine.recover`'s own dispatch call — a crash between that
      // commit and the dispatch leaves a `running` feature with no
      // active run, no resource wait, no due retry and no completion
      // outbox row (the DAG repair cleared any prior anchor for the
      // step), which the active-state invariant then reports as
      // stranded and escalates. This is a run-less outbox: the existing
      // `run.completion_decisions`/`action_handled` outbox is scoped to
      // a concluded run, but recovery has no run yet at commit time, so
      // it needs its own row. One per recovered target (recoverStepTargets
      // takes a list; today's only caller passes one), inserted in the
      // SAME transaction as the DAG repair — the same atomicity
      // discipline the completion outbox already uses. The partial
      // unique index mirrors `idx_run_one_active_target`'s shape: at
      // most one unhandled dispatch per target, so a genuine double-
      // insert (a bug, not the crash this exists to survive) fails loud
      // instead of silently landing a duplicate intent.
      db.run(`
        CREATE TABLE recovery_dispatch (
          id            TEXT PRIMARY KEY,
          feature_id    TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id        TEXT NOT NULL,
          step_id       TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'unhandled' CHECK(status IN ('unhandled','handled')),
          time_created  INTEGER NOT NULL,
          time_updated  INTEGER NOT NULL
        )
      `)
      db.run(`
        CREATE UNIQUE INDEX idx_recovery_dispatch_open_target
        ON recovery_dispatch(feature_id, job_id, step_id) WHERE status = 'unhandled'
      `)
      db.run("CREATE INDEX idx_recovery_dispatch_feature ON recovery_dispatch(feature_id, time_created)")
    },
  },
  {
    id: "0017_retry_episode_paused_ms_snapshot",
    up(db) {
      // Fixes a pause-accounting gap: `applyTransitionTx`'s pause-fold
      // only adds a closed pause span to OPEN (`scheduled`/`claimed`)
      // `retry_episode` rows. A pause spanning an EXECUTING attempt —
      // the first attempt of a streak (no episode row exists yet) or a
      // later attempt (the previous episode already closed
      // `attempt_dispatched`) — has no open row to fold into, so that
      // span is silently lost: the next episode inherits the STALE
      // prior pausedMs, not the pause time that actually elapsed during
      // the streak, and the elapsed budget burns real wall-clock pause
      // time it should have excluded.
      //
      // Fix: track the feature's CUMULATIVE pause total
      // (`feature.paused_ms`, already monotonic — folded on every
      // resume, regardless of what episode is or isn't open) as a
      // SNAPSHOT at the streak's anchor time, and derive an episode's
      // effective paused-during-streak time as (feature cumulative NOW
      // − this snapshot) at read time, rather than trying to keep a
      // per-episode running total in sync with every pause/resume. Two
      // additive columns, both NOT NULL DEFAULT 0 (same convention as
      // `paused_ms`/`nudges` — no existing row needs a real value, this
      // is a greenfield project with no deployed data):
      //
      //  - `run.paused_ms_at_dispatch`: the feature's cumulative
      //    `paused_ms` at the instant THIS run was dispatched
      //    (`insertRun` snapshots it every time, in the same
      //    transaction as the insert). This is what makes a FIRST
      //    attempt's pause-during-execution accountable at all: the
      //    streak anchor for attempt 1 is this run's own dispatch time,
      //    so its `paused_ms_at_dispatch` is the exact baseline needed
      //    — nothing else records what `feature.paused_ms` was at that
      //    past instant.
      //  - `retry_episode.feature_paused_ms_at_start`: set once, when
      //    the FIRST episode of a streak is scheduled, copied straight
      //    from the anchor run's `paused_ms_at_dispatch`; every chained
      //    episode after it copies the SAME value forward (never
      //    re-reads the feature at chain time) so the baseline stays
      //    fixed for the whole streak, exactly like `started_at`
      //    already does.
      addColumn(db, "run", "paused_ms_at_dispatch", "INTEGER NOT NULL DEFAULT 0")
      addColumn(db, "retry_episode", "feature_paused_ms_at_start", "INTEGER NOT NULL DEFAULT 0")
    },
  },
  {
    id: "0018_run_time_last_activity",
    up(db) {
      // resilient-agent-runs: the reaper's TTL measures silence (time
      // since the run last showed life — log appends, question flow,
      // nudges), not age since dispatch. Durable so a daemon restart
      // neither grants stale runs a fresh window nor inherits dispatch
      // time when later activity was recorded. Backfill from
      // time_started: the best known lower bound for legacy rows.
      addColumn(db, "run", "time_last_activity", "INTEGER")
      db.run("UPDATE run SET time_last_activity = time_started WHERE time_last_activity IS NULL")
    },
  },
  {
    id: "0019_run_recover_notes",
    up(db) {
      addColumn(db, "run", "recover_notes", "TEXT")
      addColumn(db, "recovery_dispatch", "notes", "TEXT")
      addColumn(db, "recovery_dispatch", "notes_consumed", "INTEGER NOT NULL DEFAULT 0")
    },
  },
  {
    id: "0020_recovery_note_episodes",
    up(db) {
      addColumn(db, "recovery_dispatch", "episode_closed", "INTEGER NOT NULL DEFAULT 0")
      db.run("UPDATE recovery_dispatch SET episode_closed = notes_consumed")
    },
  },
  {
    id: "0021_structured_findings",
    up(db) {
      addColumn(db, "finding", "blocking", "INTEGER CHECK(blocking IN (0, 1))")
      addColumn(db, "finding", "acceptance_tests", "TEXT NOT NULL DEFAULT '[]'")
      addColumn(db, "finding", "source_job_id", "TEXT")
      addColumn(db, "finding", "source_run_id", "TEXT")
      addColumn(db, "finding", "reviewed_head", "TEXT")
    },
  },
  {
    id: "0022_runner_safety",
    up(db) {
      // acp-runner design.md D5: durable binding/operation/fence/credential
      // records, plus the `uncertain` run status and `submitted`/`unknown`
      // answer-delivery dispositions. SQLite cannot ALTER a CHECK
      // constraint in place, so `run` and `answer_delivery` are rebuilt.
      // Unlike 0008/0009's `ALTER TABLE run RENAME TO run_old` (safe only
      // because no OTHER table referenced `run` by foreign key yet at
      // that point), `run_log`/`answer_delivery`/`retry_episode`/
      // `resource_wait`/`recovery_dispatch` all now hold a live `REFERENCES
      // run(id)` — and SQLite's ALTER TABLE RENAME follows those
      // references, silently repointing every dependent table's foreign
      // key at the renamed `run_old`, permanently orphaning them from the
      // table that is about to become `run` again. The fix: build the
      // replacement under a NEW name, copy rows into it, drop the
      // original, then rename the new table into the vacated `run` name
      // — no dependent table's schema ever mentions `run_old`, so no
      // foreign key needs to (or can) follow a rename. Preserves every
      // existing row: every pre-migration run/delivery keeps its exact
      // status, only new values become newly reachable going forward.
      // Every EXISTING run row implicitly stays "native" transport-less
      // (no runner_binding row at all) — `runner_binding` is populated
      // only for a run dispatched AFTER this migration, which is exactly
      // the "native default, existing native behavior preserved" contract:
      // an absent binding always means native.

      // Preserve cascading children while replacing the parent table.
      db.run("CREATE TEMP TABLE acp_saved_run_log AS SELECT * FROM run_log")
      db.run("CREATE TEMP TABLE acp_saved_answers AS SELECT * FROM answer_delivery")
      db.run(`
        CREATE TABLE run_new (
          id                    TEXT PRIMARY KEY,
          feature_id            TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id                TEXT NOT NULL,
          step_id               TEXT NOT NULL,
          step_type             TEXT NOT NULL CHECK(step_type IN ('agent','command','action')),
          attempt               INTEGER NOT NULL DEFAULT 1,
          status                TEXT NOT NULL DEFAULT 'running'
                                  CHECK(status IN ('running','succeeded','failed','reaped','uncertain')),
          session_id            TEXT,
          outputs               TEXT NOT NULL DEFAULT '{}',
          reason                TEXT,
          nudges                INTEGER NOT NULL DEFAULT 0,
          completion_event      TEXT,
          completion_decisions  TEXT,
          action_handled        INTEGER NOT NULL DEFAULT 0,
          metadata              TEXT,
          pending_state         TEXT,
          next_observation      INTEGER,
          pending_question      TEXT,
          asked_at              INTEGER,
          failure_class         TEXT CHECK(failure_class IS NULL OR failure_class IN (
                                   'transient_upstream','transient_transport','capacity','timeout',
                                   'deterministic_failure','invalid_config','missing_session','cancelled','internal'
                                 )),
          failure_source        TEXT,
          failure_retry_hint_ms INTEGER,
          paused_ms_at_dispatch INTEGER NOT NULL DEFAULT 0,
          time_started          INTEGER NOT NULL,
          time_last_activity    INTEGER,
          time_finished         INTEGER,
          recover_notes         TEXT
        )
      `)
      db.run(`
        INSERT INTO run_new (id, feature_id, job_id, step_id, step_type, attempt, status, session_id,
                          outputs, reason, nudges, completion_event, completion_decisions, action_handled,
                          metadata, pending_state, next_observation, pending_question, asked_at,
                          failure_class, failure_source, failure_retry_hint_ms, paused_ms_at_dispatch,
                          time_started, time_last_activity, time_finished, recover_notes)
        SELECT id, feature_id, job_id, step_id, step_type, attempt, status, session_id,
               outputs, reason, nudges, completion_event, completion_decisions, action_handled,
               metadata, pending_state, next_observation, pending_question, asked_at,
               failure_class, failure_source, failure_retry_hint_ms, paused_ms_at_dispatch,
               time_started, time_last_activity, time_finished, recover_notes
        FROM run
      `)
      db.run("DROP TABLE run")
      db.run("ALTER TABLE run_new RENAME TO run")
      db.run("INSERT INTO run_log SELECT * FROM acp_saved_run_log")
      db.run("DROP TABLE acp_saved_run_log")
      db.run("CREATE INDEX IF NOT EXISTS idx_run_feature ON run(feature_id, time_started)")
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_run_one_active_target
        ON run(feature_id, job_id, step_id) WHERE status = 'running'
      `)

      // answer_delivery: add `submitted` (open, non-reclaimable — a lease
      // cannot resend it) and `unknown` (terminal for automatic handling,
      // fences the run) alongside the existing five statuses. The open-
      // delivery uniqueness index must include `submitted` too (D5:
      // "open uniqueness includes pending/claimed/submitted/unknown") —
      // `unknown` is terminal so it does not need to join that index, but
      // is listed in the design note for completeness; only pending,
      // claimed and submitted are ever "in flight" at once.
      db.run(`
        CREATE TABLE answer_delivery_new (
          id                    TEXT PRIMARY KEY,
          feature_id            TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          run_id                TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
          job_id                TEXT NOT NULL,
          step_id               TEXT NOT NULL,
          question_generation   INTEGER NOT NULL,
          notes                 TEXT NOT NULL,
          target_session_id     TEXT,
          delivery_token        TEXT NOT NULL,
          status                TEXT NOT NULL DEFAULT 'pending'
                                  CHECK(status IN ('pending','claimed','delivered','failed','cancelled','submitted','unknown')),
          failure_detail        TEXT,
          claimed_at            INTEGER,
          lease_expires_at      INTEGER,
          attempt_count         INTEGER NOT NULL DEFAULT 0,
          next_attempt_at       INTEGER,
          deadline_at           INTEGER,
          version               INTEGER NOT NULL DEFAULT 0,
          time_created          INTEGER NOT NULL,
          time_updated          INTEGER NOT NULL
        )
      `)
      db.run(`
        INSERT INTO answer_delivery_new (id, feature_id, run_id, job_id, step_id, question_generation, notes,
                                      target_session_id, delivery_token, status, failure_detail, claimed_at,
                                      lease_expires_at, attempt_count, next_attempt_at, deadline_at, version,
                                      time_created, time_updated)
        SELECT id, feature_id, run_id, job_id, step_id, question_generation, notes,
               target_session_id, delivery_token, status, failure_detail, claimed_at,
               lease_expires_at, attempt_count, next_attempt_at, deadline_at, version,
               time_created, time_updated
        FROM acp_saved_answers
      `)
      db.run("DROP TABLE acp_saved_answers")
      db.run("DROP TABLE answer_delivery")
      db.run("ALTER TABLE answer_delivery_new RENAME TO answer_delivery")
      db.run(`
        CREATE UNIQUE INDEX idx_answer_delivery_open_run
        ON answer_delivery(run_id) WHERE status IN ('pending','claimed','submitted','unknown')
      `)
      db.run(`
        CREATE INDEX idx_answer_delivery_due
        ON answer_delivery(status, lease_expires_at) WHERE status IN ('pending','claimed')
      `)
      db.run("CREATE INDEX idx_answer_delivery_feature ON answer_delivery(feature_id, time_created)")

      // runner_binding: persisted at run insertion, BEFORE process/session
      // awaits (D5) — one row per run, transport tagged permanently.
      // `session_ref` is UNIQUE (opaque per-attempt identity: an ACP
      // process/session identity, or the reporting bridge's own name) so
      // two attempts can never collide on the same reference.
      db.run(`
        CREATE TABLE runner_binding (
          run_id              TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
          transport           TEXT NOT NULL CHECK(transport IN ('native','acp')),
          profile_id          TEXT,
          config_digest       TEXT,
          directory           TEXT NOT NULL,
          daemon_generation   INTEGER NOT NULL,
          session_ref         TEXT UNIQUE,
          remote_session_id   TEXT,
          process_generation  INTEGER NOT NULL DEFAULT 0,
          phase               TEXT NOT NULL DEFAULT 'active' CHECK(phase IN ('active','fenced','concluded')),
          time_created        INTEGER NOT NULL,
          time_updated        INTEGER NOT NULL
        )
      `)
      db.run("CREATE INDEX idx_runner_binding_generation ON runner_binding(daemon_generation)")

      // runner_operation: the durable create/prompt/answer/nudge journal
      // (D5). UNIQUE(run_id, kind, logical_key) is the operation-dedup
      // primitive; "at most one unresolved turn per binding" is enforced
      // in the store layer (task 2.2), not as a second partial index here,
      // because "unresolved" spans multiple kinds (create OR prompt OR
      // answer) which a single-column partial index cannot express
      // without also encoding kind-specific phase sets.
      db.run(`
        CREATE TABLE runner_operation (
          id                TEXT PRIMARY KEY,
          run_id            TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
          kind              TEXT NOT NULL CHECK(kind IN ('create','prompt','answer','nudge')),
          logical_key       TEXT NOT NULL,
          payload_digest    TEXT NOT NULL,
          phase             TEXT NOT NULL DEFAULT 'prepared'
                              CHECK(phase IN ('prepared','sending','submitted','completed','not_sent','unknown')),
          owner_generation  INTEGER NOT NULL,
          stop_reason       TEXT,
          diagnostic_code   TEXT,
          time_created      INTEGER NOT NULL,
          time_updated      INTEGER NOT NULL,
          UNIQUE(run_id, kind, logical_key)
        )
      `)
      db.run("CREATE INDEX idx_runner_operation_run ON runner_operation(run_id, time_created)")
      db.run(
        "CREATE INDEX idx_runner_operation_generation ON runner_operation(owner_generation) WHERE phase IN ('prepared','sending','submitted')",
      )

      // runner_fence: durable fencing survives process/daemon exit.
      // run_id is the primary key — at most one fence per run, matching
      // "the run itself records uncertain" (a run is fenced once, never
      // re-fenced under a new reason while the old fence is unresolved).
      db.run(`
        CREATE TABLE runner_fence (
          run_id           TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
          reason_code      TEXT NOT NULL CHECK(reason_code IN (
                             'lost_create_response','lost_prompt_response','lost_answer_response',
                             'process_or_daemon_restart','turn_deadline_exceeded','no_report_timeout',
                             'cancellation_during_uncertain_write','startup_recovery'
                           )),
          operation_id     TEXT REFERENCES runner_operation(id),
          cleanup_state    TEXT NOT NULL DEFAULT 'unconfirmed'
                             CHECK(cleanup_state IN ('confirmed_terminated','operator_attested','unconfirmed')),
          created_at       INTEGER NOT NULL,
          resolved_at      INTEGER,
          resolution_note  TEXT
        )
      `)
      db.run("CREATE INDEX idx_runner_fence_unresolved ON runner_fence(run_id) WHERE resolved_at IS NULL")

      // run_credential: random high-entropy token digest only — no
      // plaintext recovery requirement (D8). `token_hash` is UNIQUE so a
      // hash collision (astronomically unlikely, but the index is the
      // durable proof) can never authorize two attempts at once.
      db.run(`
        CREATE TABLE run_credential (
          id                  TEXT PRIMARY KEY,
          run_id              TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
          attempt             INTEGER NOT NULL,
          process_generation  INTEGER NOT NULL,
          token_hash          TEXT NOT NULL UNIQUE,
          issued_at           INTEGER NOT NULL,
          expires_at          INTEGER,
          revoked_at          INTEGER,
          revocation_reason   TEXT
        )
      `)
      db.run("CREATE INDEX idx_run_credential_run ON run_credential(run_id)")

      // worker_request_dedup: MCP ask invocation-id dedup (D8: "bridge
      // assigns an invocation id per MCP request and reuses it across
      // bounded HTTP retries, daemon persists dedup scoped to run and
      // question generation"). One row per (run_id, invocation_id);
      // `question_generation` records which ask this invocation created
      // so a late replay can be compared against the run's CURRENT
      // generation and rejected as stale without creating a second one.
      db.run(`
        CREATE TABLE worker_request_dedup (
          run_id                TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
          invocation_id         TEXT NOT NULL,
          question_generation   INTEGER NOT NULL,
          time_created          INTEGER NOT NULL,
          PRIMARY KEY (run_id, invocation_id)
        )
      `)
    },
  },
  {
    id: "0023_runner_operation_version",
    up(db) {
      db.run("ALTER TABLE runner_operation ADD COLUMN version INTEGER NOT NULL DEFAULT 0")
    },
  },
  {
    id: "0024_worker_request_payload",
    up(db) {
      db.run("ALTER TABLE worker_request_dedup ADD COLUMN payload_digest TEXT")
      db.run("ALTER TABLE worker_request_dedup ADD COLUMN disposition TEXT")
    },
  },
  {
    id: "0025_change_queue",
    up(db) {
      db.run(`
        CREATE TABLE change_queue (
          project_dir   TEXT PRIMARY KEY,
          paused        INTEGER NOT NULL DEFAULT 0,
          parallelism   INTEGER NOT NULL DEFAULT 1 CHECK(parallelism >= 1),
          time_updated  INTEGER NOT NULL
        )
      `)
      db.run(`
        CREATE TABLE change_queue_entry (
          id            TEXT PRIMARY KEY,
          project_dir   TEXT NOT NULL,
          change        TEXT NOT NULL,
          position      INTEGER NOT NULL,
          status        TEXT NOT NULL
                          CHECK(status IN ('waiting','blocked','invalid','starting','running','escalated','merged','removed')),
          reason        TEXT,
          state         TEXT,
          feature_id    TEXT,
          claim_token   TEXT,
          claimed_at    INTEGER,
          time_created  INTEGER NOT NULL,
          time_updated  INTEGER NOT NULL
        )
      `)
      // One live entry per change; merged/removed entries are history and
      // never block queueing the same change again.
      db.run(
        `CREATE UNIQUE INDEX idx_change_queue_entry_live ON change_queue_entry(project_dir, change)
         WHERE status NOT IN ('merged','removed')`,
      )
      db.run("CREATE INDEX idx_change_queue_entry_position ON change_queue_entry(project_dir, position)")
      db.run(`
        CREATE TABLE change_queue_transition (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id      TEXT NOT NULL,
          from_status   TEXT,
          to_status     TEXT NOT NULL,
          reason        TEXT,
          time          INTEGER NOT NULL
        )
      `)
      db.run("CREATE INDEX idx_change_queue_transition_entry ON change_queue_transition(entry_id, id)")
    },
  },
  {
    id: "0026_runner_operation_diagnostic",
    up(db) {
      db.run("ALTER TABLE runner_operation ADD COLUMN diagnostic TEXT")
    },
  },
  {
    id: "0027_self_healing",
    up(db) {
      // Fence classification (self-healing D1). NULL = awaiting cleanup
      // evidence; evidence is the JSON the classification was computed from.
      db.run(`ALTER TABLE runner_fence ADD COLUMN classification TEXT
        CHECK(classification IS NULL OR classification IN ('no_effect','replay_safe','unsafe'))`)
      db.run("ALTER TABLE runner_fence ADD COLUMN evidence TEXT")
      db.run("ALTER TABLE runner_fence ADD COLUMN classified_at INTEGER")
      // Healing episodes (D3): one scheduled heal per fenced target. A
      // fresh table rather than retry_episode — healing has no attempt or
      // elapsed budget and must never collide with the one-open-retry
      // uniqueness index or the retry budget arithmetic.
      db.run(`
        CREATE TABLE healing_episode (
          id                   TEXT PRIMARY KEY,
          feature_id           TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id               TEXT NOT NULL,
          step_id              TEXT NOT NULL,
          fence_run_id         TEXT NOT NULL,
          classification       TEXT NOT NULL CHECK(classification IN ('no_effect','replay_safe')),
          status               TEXT NOT NULL CHECK(status IN ('scheduled','claimed','closed')),
          consecutive_failures INTEGER NOT NULL,
          next_attempt_at      INTEGER NOT NULL,
          delay_ms             INTEGER NOT NULL,
          diagnostic           TEXT,
          closed_reason        TEXT,
          time_created         INTEGER NOT NULL,
          time_updated         INTEGER NOT NULL
        )
      `)
      db.run(`CREATE UNIQUE INDEX idx_healing_episode_open ON healing_episode(feature_id, job_id, step_id)
        WHERE status IN ('scheduled','claimed')`)
      db.run("CREATE UNIQUE INDEX idx_healing_episode_fence ON healing_episode(fence_run_id)")
      db.run("CREATE INDEX idx_healing_episode_due ON healing_episode(status, next_attempt_at)")
      // Attention (D4): durable per-target trouble; the API projects a
      // `running` feature with any row here as `attention`.
      db.run(`
        CREATE TABLE feature_attention (
          feature_id           TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
          job_id               TEXT NOT NULL,
          step_id              TEXT NOT NULL,
          source               TEXT NOT NULL CHECK(source IN ('healing','retry')),
          consecutive_failures INTEGER NOT NULL,
          last_diagnostic      TEXT,
          next_attempt_at      INTEGER,
          time_created         INTEGER NOT NULL,
          time_updated         INTEGER NOT NULL,
          PRIMARY KEY (feature_id, job_id, step_id)
        )
      `)
      // Notification outbox (notifications spec).
      db.run(`
        CREATE TABLE notification_outbox (
          id              TEXT PRIMARY KEY,
          feature_id      TEXT NOT NULL,
          kind            TEXT NOT NULL CHECK(kind IN ('attention','recovered','escalated','waiting_human','done','test')),
          channel         TEXT NOT NULL,
          dedup_key       TEXT NOT NULL,
          payload         TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('pending','claimed','sent','suppressed','failed')),
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error      TEXT,
          time_created    INTEGER NOT NULL,
          time_updated    INTEGER NOT NULL,
          time_sent       INTEGER
        )
      `)
      db.run("CREATE UNIQUE INDEX idx_notification_dedup ON notification_outbox(channel, dedup_key)")
      db.run("CREATE INDEX idx_notification_due ON notification_outbox(status, next_attempt_at)")
      db.run("CREATE INDEX idx_notification_feature ON notification_outbox(feature_id, kind, channel, time_sent)")
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
