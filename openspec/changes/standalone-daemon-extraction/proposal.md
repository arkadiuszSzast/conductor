## Why

`opencode-conductor` proves the model — durable SQLite state machine, a pure
interpreter, a reconciler, human gates, findings, a dashboard — but it is a
**plugin inside one runtime**. It only works where opencode runs, its dashboard
is bound to the plugin's process, and its API is the tool list of a single
agent. The vision for Conductor is a **standalone system**: its own daemon,
its own state, its own HTTP API and UI, with agent runtimes as interchangeable
integrations behind a `Runner` abstraction.

This change performs the extraction. Everything that is not about being an
opencode plugin — the interpreter, the workflow model, validation, templates,
the SQLite store, the engine, the reconciler, the dashboard's data model —
moves into the monorepo as `@conductor/core` and `@conductor/server`. What is
opencode-specific shrinks into `@conductor/runner-opencode`.

The acceptance bar is dogfooding, not refactoring: after this change the
`gloam-idle` repo (and the `conductor-test` / `quotes-api` benches) run on the
standalone daemon, their **in-flight conductor features survive** (the DB is
adopted additively, sessions are disposable executors), and the old plugin's
tool surface is re-exposed through the daemon's API plus a `conductor` CLI.

## What Changes

- The engine, store, DB layer, interpreter, validator, template renderer and
  config loader are extracted 1:1 into `packages/core` (pure) and
  `packages/server` (engine, store, daemon, API), with their ~100 tests moved
  and kept green.
- A daemon process owns the engine: loads every registered project's
  `conductor.yaml`, runs the reconciler loop, serves HTTP API v1 (REST + SSE),
  and owns the SQLite database.
- The opencode plugin becomes a thin **runner**: it receives "create a session,
  prompt it" calls over HTTP and reports back through the daemon's API. The
  `conductor_report` tool is re-registered as a tool that POSTs to the daemon.
- `conductor` CLI: `init` (scaffold `conductor.yaml`), `start`, `status`,
  `approve`, `request-changes`, `report`, `pause`, `resume`, `abandon`,
  `logs`. The CLI is the report-back channel that works from any runtime.
- The existing `~/.config/opencode/conductor.db` is adopted: additive schema
  migration only; in-flight features (status, current step, attempts, rounds,
  escalation, findings, threads) reconstruct exactly.
- `gloam-idle` is migrated: `.opencode/conductor.json` is converted to the
  new workflow format (see `workflow-format` change), the daemon drives it, the
  plugin is turned off. Dogfooding from extraction day.

## Non-goals

- No new workflow features in this change (those are `workflow-format`).
- No board UI (phase 2) and no scheduler (phase 3).
- No webhook triggers yet; work starts via CLI/API and schedule.
- No multi-host or cloud; single-machine self-hosted daemon, one SQLite DB.
