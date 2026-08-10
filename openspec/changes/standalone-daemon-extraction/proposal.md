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
standalone daemon drives real repos (the `conductor-test` / `quotes-api`
benches, then this repo's own changes) end to end on `conductor.yaml`
workflows, and the old plugin's tool surface is re-exposed through the
daemon's API plus a `conductor` CLI.

**Greenfield decision (recorded mid-change):** this project has no users and
no deployed databases. The seed's `.opencode/conductor.json` pipeline format
and the pipeline engine extracted from it were scaffolding for the
extraction, not a product surface. Instead of converting the seed format to
`conductor.yaml` (the original task 15), the seed format and its engine are
**removed outright** and the daemon is rewired to execute `conductor.yaml`
(the `@conductor/core` graph IR from the `workflow-format` change) natively.
No converter, no compatibility layer, no DB adoption of seed databases.

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
- The seed pipeline engine (`packages/server/src/engine/`), the seed config
  registry (`.opencode/conductor.json` loading, `extends`, `conductor:<name>`
  presets) and the bundled seed presets are **deleted**. The daemon executes
  `conductor.yaml` through `@conductor/core`'s graph interpreter; the engine
  keeps the seed's operational behaviours (confirmation-of-effect,
  nudge/reap, atomic run conclusion) on the new model.
- The database schema is defined for the graph model directly (jobs, steps,
  attempts, reruns, feedback snapshots). No seed database is ever adopted.

## Non-goals

- No new workflow features in this change (those are `workflow-format`).
- No board UI (phase 2) and no scheduler (phase 3).
- No webhook triggers yet; work starts via CLI/API and schedule.
- No multi-host or cloud; single-machine self-hosted daemon, one SQLite DB.
