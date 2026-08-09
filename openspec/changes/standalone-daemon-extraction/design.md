# Design — standalone-daemon-extraction

## Context

The seed is a single Bun/TypeScript package. `src/pipeline/*` is already pure;
`engine.ts` owns effects; `store.ts` wraps all SQL; `db.ts` owns migrations;
`index.ts` is the opencode plugin and process-wide daemon; `dashboard.ts` is a
zero-dependency HTTP server. There are 100 tests across interpreter, engine,
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
`FeatureState`/transition types for the extracted store. This avoids
misrepresenting the seed's single `current_step` and attempts/rounds maps as the
new core graph state while preserving the store's observable semantics for the
engine extraction.

### Pipeline engine execution model

`@conductor/server` now hosts opencode-conductor's engine/reconciler/builtins/
GitHub client/findings-publication as an isolated `engine/` module
(`Engine`, `builtins`, `RealGh`, `makePublishReview`),
deliberately separate from `@conductor/core`'s graph workflow IR
(`WorkflowDef`/`JobDef`). It runs the seed's single-`current_step`
pipeline/attempts/rounds model against the extracted SQLite store while the
graph engine is built out under the `workflow-format` change; nothing in
`engine/` may grow DAG/graph concepts.

Every side effect crosses an injected port: `StorePort` (a structural
interface `Store` satisfies, so tests and a future backing store can
substitute), a `Clock` (`now()`, defaulting to `systemClock`) used for
recovery and TTL/reap timing, `SessionClient` as a runtime-neutral
session runner (no opencode SDK type crosses this boundary — opencode today,
other runners later implement it against their own client), `GhClient` as
the GitHub port (`RealGh` implements it over `ProcessRunner`), `ProcessRunner`
for all filesystem/process/git execution (`exec` for argv, `shell` for
`command` pipeline steps — never a bare `spawn`, never an implicit
`process.cwd()`), a `Logger`, `ConfigResolver` as the per-project config
resolver (`projectDir → EngineConfig | null`; one engine serves every project
sharing the DB, each feature runs under its own project's pipeline/roles/
limits), and an injectable `PublishReview` (defaults to the gh-backed
`makePublishReview`, override-able in tests).

`Engine` owns no singleton, timer or daemon lifecycle: it holds no
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

**Accepted risk — untrusted text in `command` step templates:** template
rendering does no shell-escaping, and the template context includes values
that are not purely project-config-controlled: `{{human.<step>}}` (free-text
human gate notes), `{{steps.<id>.output}}` (agent-reported text, which can
itself echo untrusted repo/PR content back via prompt injection), and
`{{findings.*}}` (finding bodies extracted from a PR diff/comment). A
`command` step's `run:` entries interpolating any of these into shell syntax
(e.g. `` echo "{{steps.review.output}}" | some-tool ``) lets a crafted
finding body, human note, or agent note containing shell metacharacters
(`` ` ``, `$()`, `;`) execute as command injection in the feature's
worktree. This is preserved, not fixed, by this extraction: `command` steps
are authored by the project (trusted `run:` shell text), but the *values*
substituted into that text are not all trusted. Config authors must not
interpolate `{{human.*}}`, `{{steps.*.output}}`, or `{{findings.*}}` into
shell syntax in a `command` step's `run:`; prefer a deterministic `builtin`
argv action (or pass the value via an env var / file, never inline shell
text) wherever the value may contain untrusted content.

`Store.applyTransition` still writes the feature-state update and transition
audit inside one transaction. Run completion paths additionally use
`Store.concludeRun`: a conditional `status = 'running'` claim, the durable
completion event, feature transition and audit are committed together. This
closes both duplicate-report races and the restart window where a concluded run
could otherwise remain on its old current step. Agent runs are inserted before
session setup begins, so a concurrent reconcile pass observes the in-flight run
instead of dispatching the step twice.

This task does not touch `ActionRegistry`/graph-reservation
(`workflow-reservation.ts`, `action-registry.ts`): that machinery belongs to
`@conductor/core`'s graph workflow IR and is claimed by a separate task; the
pipeline engine and the graph reservation model are not unified here and must
not be conflated.

**Known inherited boundary:** the idle-cycle debounce counter
(`idleCycles: Map<runId, count>`) is in-memory only, inherited unchanged from
the seed. A daemon restart resets it to zero for any in-flight agent run —
the safe direction of error (an extra idle cycle before a nudge, never a
missed reap) — but it means idle-debounce state does not survive restart the
way `runTtlMs`-based reaping does. This is a known seed characteristic
carried forward, not a gap introduced by the extraction; a durable idle-cycle
store is out of scope for this task.

### Extraction test parity

The seed inventory contains 100 tests: engine 42, interpreter 23, store 6,
worktree built-ins 4, review publication/parsing 7, templates 5, structural
validation 9 and presets 4. The extracted direct counterparts contain 146 tests:
server engine 50, pipeline interpreter 25, store 18, built-ins 17, review
publication 18, templates 5, pipeline validation 9 and presets 4. Additional
server tests cover database migrations, GitHub error redaction, process limits,
action registries and architecture constraints; graph workflow-format tests in
`@conductor/core` remain separate and are not counted as pipeline-engine parity.

| Seed tests | Extracted counterpart | Parity |
| --- | --- | --- |
| `engine.test.ts` (42) | `packages/server/engine.test.ts` (50) | Same observable routing, sessions, reports, gates, recovery, findings, publication and reaping through injected `SessionClient`, `GhClient`, `Clock`, `ProcessRunner`, `PublishReview` and `ConfigResolver`; concurrency/outbox cases are stricter. |
| `interpret.test.ts` (23) | `packages/server/interpret.test.ts` (25) | Direct single-current-step event/patch parity; graph interpreter tests are intentionally separate. |
| `store.test.ts` (6) | `packages/server/store.test.ts` (18) | Direct parity plus rollback, atomic conclusion and durable action-outbox coverage. |
| `builtins-worktree.test.ts` (4) | `packages/server/builtins.test.ts` (17) | Real local-git freshness/divergence/layout assertions preserved; other deterministic actions use injected argv execution and add injection checks. |
| `publishReview.test.ts` (7) | `packages/server/publish-review.test.ts` (18) | Parser and severity assertions preserved; injected GitHub/process publication adds token and review-projection failure coverage. |
| `template.test.ts` (5) | `packages/server/template.test.ts` (5) | Direct parity. |
| `validate.test.ts` (9) | `packages/server/validate.test.ts` (9) | Pipeline structural validator extracted directly and remains separate from the graph validator. |
| `presets.test.ts` (4) | `packages/server/presets.test.ts` (4) | Three seed JSON pipeline presets copied unchanged and validated; workflow-format conversion remains a later task. |

The seed config-loader regression asserting that `reviewPublish.tokenCommand`
survives file loading belongs to the explicitly deferred project/config registry
task. Its engine-side merge semantics are covered by the injected-config
publication test, while disk loading and hot reload are not implemented or
claimed here. This is the only structural adaptation not exercised through the
same package boundary; it does not leave an engine behavior untested.

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
