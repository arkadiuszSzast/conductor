## Context

See proposal.md for the motivation and the production data behind it.

Today:

- A feature is started by `POST /v1/features` → `Engine.startFeature(projectDir, input)`, which validates inputs against the registered `conductor.yaml` snapshot and dispatches `feature.start`. The OpenSpec plugin calls that API from its panel (`plugins/openspec/serve.ts`, `handleStartWork`) and fills `inputs.change_slug`/`change` from the workflow projection.
- The daemon owns a timer that calls `Engine.reconcile()` every cycle (`packages/server/src/daemon.ts`); the engine never owns time.
- The interpreter is pure over `(workflow IR, feature state, event)`. Side effects live in the engine and reconciler.
- A gloam feature archives its change on the feature branch (`ship/archive_change`) and merges through a PR, so after merge the default branch contains `openspec/changes/archive/<date>-<name>/`. The pipeline's `cleanup` job fast-forwards the local clone, but only when it runs.
- The OpenSpec CLI (1.10) tolerates extra keys in `.openspec.yaml`; `depends_on` round-trips through `openspec new`/`status`/`list` unchanged (checked in a scratch repo).

## Goals / Non-Goals

**Goals:**
- Start queued changes autonomously when their dependencies have merged, within a per-project limit, with no human in the loop.
- Keep scheduling decisions in a pure, unit-testable function; keep git, the store and feature creation in the server.
- Make every non-start explainable: each entry carries a reason.
- Survive restarts and concurrent reconcile passes without double starts.

**Non-Goals:**
- Changing how a single change is executed. The workflow, its gates and its merge policy are untouched.
- Splitting changes, per-task scheduling, cost/time budgets, cross-project graphs (see proposal: out of scope).
- A generic job queue for non-OpenSpec work. The queue is OpenSpec-shaped on purpose; a generic shape can be extracted when a second source exists.

## Decisions

### D1 — Dependencies live in `.openspec.yaml`, not in prose or in SQLite

`depends_on: [name, …]` in the change's own `.openspec.yaml`.

- **Why:** OpenSpec owns intent. The dependency is part of the plan, travels with the change through review and archive, and is visible in the PR diff. The scheduler re-reads it on each pass, so editing it is enough to change the graph.
- **Rejected — parse "Depends on:" from `proposal.md`:** prose is ambiguous ("assumed shipped", "if X has not shipped, …" in gloam's `add-standings`); a scheduler must not guess.
- **Rejected — store dependencies only in SQLite:** a second source of intent next to the files; it would drift from what reviewers see.
- **Rejected — Beads or another task tracker:** the graph is small (changes, not tasks), it lives next to feature state, and an external tracker would add a process and a second completion authority for no gain. This closes Stage 5 of `docs/development-roadmap.md` for the change level.

### D2 — "Merged" means archived on the remote default branch

A dependency is merged when `git ls-tree` on `origin/<default>` (after a bounded `git fetch`) lists `openspec/changes/archive/*-<name>/`.

- **Why:** this is exactly what a merged gloam PR produces, it does not depend on Conductor having watched the merge (a human may merge by hand), and it does not depend on the local checkout being current.
- **Default branch:** read once per pass via `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`.
- **Fetch cost:** one `git fetch --quiet origin <default>` per project per scheduler pass, and only while the project has queue entries that are not terminal. The scheduler runs on its own interval (default 60 s), not on every reconcile cycle.
- **Rejected — feature status `done`:** a `done` feature does not prove a merge (a workflow without a merge step finishes `done` too).
- **Rejected — GitHub API:** ties the queue to one forge; git works for any remote.

### D3 — Pure scheduler in `@conductor/core`

```
planQueue(input) → { start: EntryId[], states: Map<EntryId, EntryState> }

input:
  entries:   ordered queue entries {id, change, status, featureId?}
  graph:     change → depends_on (already read from files)
  known:     set of active + archived change names
  merged:    set of merged change names (D2)
  features:  featureId → status (running/paused/escalated/done/abandoned)
  limit:     integer ≥ 1
  paused:    boolean
```

The function validates (cycles via DFS over active changes, unknown names), propagates `blocked` transitively from stuck features, computes `waiting` reasons, and selects starts in queue order while the count of non-terminal queue-started features is below `limit`. It has no I/O and is covered by table-driven unit tests, the same discipline as `interpret()`.

- **Rejected — scheduling inside the workflow interpreter:** the queue is a graph of features, not of jobs. Folding it into the workflow IR would make the backlog a second rule engine (see `docs/task-contract-design.md` §4.3).

### D4 — Server side: tables, scheduler hook, exactly-once start

- **Tables (additive migration):**
  - `change_queue(project_dir PK, paused, parallelism, time_updated)`
  - `change_queue_entry(id PK, project_dir, change, position, status, reason, feature_id NULL, time_created, time_updated, UNIQUE(project_dir, change) WHERE status NOT IN ('merged','removed'))`
  - transitions are appended to the existing `transition_log`-style audit (one row per state change).
- **Hook:** the daemon's timer calls a new `ChangeQueueScheduler.tick()` on its own interval. It gathers inputs (store, files via the existing process port, git per D2), calls `planQueue`, persists the states, then starts the selected entries.
- **Exactly-once start:** for each selected entry, in one SQLite transaction, move it `waiting → starting` with a fresh claim token; then call `Engine.startFeature` with the change's title/description/inputs computed the same way the plugin does today; then, in a second transaction, link `feature_id` and move to `running`. On restart, a `starting` entry is reconciled by looking up a feature whose `inputs` carry the change slug and was created after the claim; if found it is linked, otherwise the claim is released. A unique partial index guarantees one live entry per change.
- **Start inputs:** the scheduler reuses the plugin's derivation (title from the change name, description from the proposal's *Why*, the `change_slug`/`change` input from the workflow projection). That logic moves from `plugins/openspec/serve.ts` into a small shared module the plugin and the server both import.

### D5 — HTTP API

- `GET /v1/projects/queue?dir=` → queue settings and entries (state, reason, dependencies, feature id).
- `POST /v1/projects/queue/entries` `{dir, change}` → add (validated, D3).
- `DELETE /v1/projects/queue/entries/:id` → remove (refused while `starting`/`running`).
- `PATCH /v1/projects/queue` `{dir, paused?, parallelism?, order?}`.
- Errors use the existing envelope; validation failures return `422` with the diagnostic naming the offending changes.

### D6 — Plugin

The panel calls the queue API through the existing proxy, shows `depends_on` read from `.openspec.yaml`, and renders each entry's state and reason. The plugin keeps using only the public contract.

### D7 — Concurrency, durability and side effects

- The scheduler runs inside the daemon's single reconcile loop, so two passes never overlap in one process; the claim transaction in D4 still protects against a second daemon on the same DB.
- Feature lifecycle events (escalated, paused, abandoned, done) are not pushed to the queue; the scheduler derives entry state from feature status on each pass. This keeps the engine unaware of the queue.
- A merged dependency is final: once `merged`, an entry never leaves that state.

## Risks / Trade-offs

- **[Autonomous runs merge broken work while nobody watches]** → The queue does not merge anything; merge policy remains in `conductor.yaml`. A project that removes its human merge gate accepts that risk explicitly. The default parallelism of 1 keeps the blast radius to one change at a time.
- **[A dependant starts from a `main` that has not yet absorbed a just-merged dependency]** → Readiness is computed from `origin/<default>` (D2), and the gloam workflow already syncs `main` before creating the worktree (`prepare/sync_main`).
- **[Merge conflicts between parallel independent changes]** → Independent by declaration does not mean conflict-free. The second PR's CI and review loop handle conflicts as they do today; the limit defaults to 1 so projects opt into parallelism knowingly.
- **[Fetch load on the remote]** → Only projects with live queue entries fetch, one ref, on a 60 s interval.
- **[An entry stuck in `starting` after a crash]** → Restart reconciliation (D4) links or releases it; the state carries the claim timestamp for diagnosis.
- **[Dependency declared only in prose]** → Not scheduled. The panel shows declared `depends_on` for every change, so a missing declaration is visible before queueing.

## Migration Plan

- Additive DB migration (two new tables). No existing table changes; in-flight features are unaffected.
- The feature is inert until a project queues something.
- gloam-idle: add `depends_on` to the queued changes' `.openspec.yaml`; optionally remove the `merge` human gate to run fully unattended.
- Rollback: stop queueing (pause), revert; the tables can stay.

## Open Questions

- The scheduler interval (60 s) and the fetch timeout are defaults to confirm on the dogfood host; they are configuration, not shape.
