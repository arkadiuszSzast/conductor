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

### Legacy compatibility execution model

`@conductor/server` now hosts opencode-conductor's engine/reconciler/builtins/
GitHub client/findings-publication as an isolated `legacy/` module
(`LegacyEngine`, `legacyBuiltins`, `RealGh`, `makePublishReviewLegacy`),
deliberately separate from `@conductor/core`'s graph workflow IR
(`WorkflowDef`/`JobDef`). It runs the seed's single-`current_step`
pipeline/attempts/rounds model against the extracted SQLite store while the
graph engine is built out under the `workflow-format` change; nothing in
`legacy/` may grow DAG/graph concepts.

Every side effect crosses an injected port: `LegacyStorePort` (a structural
interface `Store` satisfies, so tests and a future backing store can
substitute), a `Clock` (`now()`, defaulting to `systemClock`) used for
recovery and TTL/reap timing, `LegacySessionClient` as a runtime-neutral
session runner (no opencode SDK type crosses this boundary — opencode today,
other runners later implement it against their own client), `LegacyGh` as
the GitHub port (`RealGh` implements it over `ProcessRunner`), `ProcessRunner`
for all filesystem/process/git execution (`exec` for argv, `shell` for
`command` pipeline steps — never a bare `spawn`, never an implicit
`process.cwd()`), a `Logger`, `LegacyConfigResolver` as the per-project config
resolver (`projectDir → LegacyConfig | null`; one engine serves every project
sharing the DB, each feature runs under its own project's pipeline/roles/
limits), and an injectable `LegacyPublishReview` (defaults to the gh-backed
`makePublishReviewLegacy`, override-able in tests).

`LegacyEngine` owns no singleton, timer or daemon lifecycle: it holds no
`setInterval`/`setTimeout` and starts nothing on construction. `reconcile()`
is a plain async method the daemon calls on an interval and after startup
recovery (daemon lifecycle, task 3) — the engine has no opinion on when or
how often it runs.

The confirmation-of-effect rule is exact and unchanged from the seed: an
agent step only concludes through the daemon's `report()` path — never
because a session merely went idle. Idle sessions are debounced
(`nudgeIdleCycles` consecutive idle reconcile cycles before a nudge), nudged
up to `maxNudges` times, then reaped; a session reported `"missing"` (gone —
server restart, deletion) is reaped immediately without nudging; runs that
exceed `runTtlMs` with no reported effect are reaped regardless of session
status. Every reap feeds a `step.failed` event back through the same
interpreter path as a real failure.

Review findings persist to SQLite as the source of truth before any GitHub
call; publishing (`postReview`/`postComment`) is a best-effort projection
that never blocks the pipeline — a failed publish is recorded as a status
line, not a stall. `findings.sync`/resolution updates follow the same order:
DB row first, GitHub thread projection second.

Deterministic builtins (`worktree.create`, `git.push`, `pr.create`, …) run
fixed git subcommands as argv through `ProcessRunner.exec`, never
interpolated into a shell string; refs are validated with
`git check-ref-format` before they are ever placed in an argv position.
`command`-type pipeline steps are the one path that legitimately renders a
shell string, via `ProcessRunner.shell`.

`Store.applyTransition` is unchanged by this extraction: it still writes the
feature-state UPDATE and the transition-log INSERT inside one
`db.transaction`, so decision and audit remain atomic (see "Durability,
concurrency and observability" below).

This task does not touch `ActionRegistry`/graph-reservation
(`workflow-reservation.ts`, `action-registry.ts`): that machinery belongs to
`@conductor/core`'s graph workflow IR and is claimed by a separate task; the
legacy engine and the graph reservation model are not unified here and must
not be conflated.

**Known inherited boundary:** the idle-cycle debounce counter
(`idleCycles: Map<runId, count>`) is in-memory only, inherited unchanged from
the seed. A daemon restart resets it to zero for any in-flight agent run —
the safe direction of error (an extra idle cycle before a nudge, never a
missed reap) — but it means idle-debounce state does not survive restart the
way `runTtlMs`-based reaping does. This is a known seed characteristic
carried forward, not a gap introduced by the extraction; a durable idle-cycle
store is out of scope for this task.

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
