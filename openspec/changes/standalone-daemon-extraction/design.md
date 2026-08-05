# Design — standalone-daemon-extraction

## Context

The seed is a single Bun/TypeScript package. `src/pipeline/*` is already pure;
`engine.ts` owns effects; `store.ts` wraps all SQL; `db.ts` owns migrations;
`index.ts` is the opencode plugin and process-wide daemon; `dashboard.ts` is a
zero-dependency HTTP server. There are 98 tests across interpreter, engine,
store, validation, templates, built-ins, presets and review publication.

Three observed production bugs are architectural constraints, not anecdotes:
(1) opencode session directory belongs in the request query, not body;
(2) child sessions need the correct tool surface inside worktrees; (3) a
process-global dashboard's bind configuration must not depend on project
registration order. The extraction must preserve their fixes.

## Goals / Non-goals

**Goals:** standalone lifecycle, versioned API, additive DB adoption, thin
opencode adapter, CLI client, test parity, same-day gloam dogfooding.

**Non-goals:** changing workflow semantics, adding DAG scheduling, board UI,
webhook ingress, distributed execution or replacing SQLite.

## Decisions

### Package boundary

- `@conductor/core`: workflow types, pure interpreter, validator, template
  renderer. No Bun APIs, filesystem, SQL, network or clock.
- `@conductor/server`: SQLite DB/migrations/store, engine/reconciler, action
  execution, config registry, HTTP API/SSE, daemon lifecycle.
- `@conductor/runner-opencode`: opencode SDK session transport and tool
  registration. HTTP client only; no DB or interpreter.
- `@conductor/cli`: HTTP client and process entry point.

This maps existing seams instead of inventing new ones. The core can be tested
without SQLite or a runtime; the server depends on core; runners depend only on
the wire contract/client.

### API and process topology

One daemon owns one SQLite database and many projects. REST under `/v1` covers
commands and resources; SSE `/v1/events` is an invalidation/event stream. The
API returns durable IDs, machine-readable error codes and request correlation
IDs. CLI and UI have no privileged in-process path.

The opencode plugin registers its runner endpoint/capability with the daemon.
For v1, the daemon and opencode run on the same host; runner requests may use a
local authenticated callback transport. Authentication shape is explicit even
for localhost and is designed before exposing any bind beyond loopback.

### Database adoption

Keep legacy tables and columns intact. Introduce a `schema_migration` ledger;
each migration runs in one transaction and is monotonic. New generalized
naming is represented in domain/API types first; destructive table/column
renames are deferred. The legacy DB path is importable/configurable — never
hardcoded as the daemon's universal default. Before migrating a real gloam DB,
copy it and run migration + recovery contract tests against the copy.

The extracted persistence API separates `openDatabase`/connection close,
`migrateDatabase`/`runMigrations`, and injected `Store` construction. Database
paths are explicit configuration; the server does not infer a home directory.
Every opened connection enables WAL and foreign keys before use.

Migration IDs are stable ordered strings (`0001_...` onward). The ledger must
be an exact prefix of the compiled migration list; unknown, missing or reordered
history fails startup rather than guessing. Each migration body and its ledger
insert share one Bun SQLite transaction, so an exception or interruption marks
neither as applied. Historical seed schema stages are represented as additive,
idempotent migrations: base legacy tables, `workflow`, `nudges`, review threads,
findings and `description`. Existing tables and columns are neither renamed nor
rebuilt, and the workflow-format job/step graph schema remains deferred.

Until the graph persistence task lands, `@conductor/server` exports explicit
`LegacyFeatureState`/transition types for the extracted store. This avoids
misrepresenting the seed's single `current_step` and attempts/rounds maps as the
new core graph state while preserving the store's observable semantics for the
engine extraction.

### Reconciler ownership

The daemon owns one lifecycle-managed reconciler. The existing confirmation of
effect rule stays: decision and audit are atomic; external effect is retried or
reconciled; success requires explicit report. Project configs are cached with
safe reload: an invalid new config does not replace the last valid one for
active work. A step removed under an active feature still escalates loudly.

### Configuration migration

A converter reads `.opencode/conductor.json` and emits `conductor.yaml`. It
preserves step IDs, routing, roles/models, prompts, human gates, findings
publishing and worktree settings. It validates both forms and emits a semantic
diff/warnings; migration is opt-in and keeps the original file. Workflow YAML
semantics are specified by the separate `workflow-format` change.

## Alternatives considered

1. **Keep the plugin as daemon host** — rejected: it cannot be runtime-agnostic
   and reproduces lifecycle/binding/tool-surface coupling.
2. **Rewrite around Temporal/LangGraph** — rejected: topology is the easy part;
   they discard the battle-tested operational layer and violate extraction
   over rewrite.
3. **Rename/rebuild the DB schema immediately** — rejected: it risks in-flight
   state. Additive compatibility is the platform-grade path.
4. **Unix socket only** — deferred: excellent local transport but HTTP is
   required for runner/runtime neutrality and future remote clients. A Unix
   socket can be an additional listener.

## Durability, concurrency and observability

- Interpreter remains pure; engine owns all effects.
- SQLite WAL + foreign keys; transitions and audit rows share a transaction.
- Reconciliation is idempotent and per-feature failures are isolated.
- Structured logs carry `project_id`, `feature_id`, `step_id`, `run_id`.
- Health reports DB migration state, reconciler heartbeat and runner
  availability. Metrics hooks record transition counts, step duration,
  retries/nudges/reaps, and queue wait without hardcoding a telemetry backend.

## Rollout

1. Move pure code/tests to core, preserving imports and semantics.
2. Move DB/store/engine/actions/tests to server behind interfaces.
3. Start daemon/API/CLI around the extracted engine.
4. Turn plugin into HTTP adapter; run `conductor-test` and `quotes-api` canary.
5. Copy and migrate gloam DB; run shadow/read-only inspection; switch gloam
   config and plugin; keep rollback (old plugin + untouched DB copy).
6. Dogfood Conductor's next own OpenSpec change through the daemon.
