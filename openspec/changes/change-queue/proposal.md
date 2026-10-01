## Why

A large OpenSpec change takes about a day from start to merge on gloam-idle (30 finished features: 23.4 h average, up to 92 h). Data from the production daemon shows the delay is not implementation time:

| Where the 703 h went | Hours |
|---|---|
| First implementation turn | 71 h (~10%) |
| Later implementer fix rounds | 193 h |
| First review round | 42 h |
| Later review rounds | 153 h |
| Idle (no run active: escalated, waiting for a human, waiting to start) | **254 h (36%)** |

Today a human has to notice that a change is done and start the next one. Nothing runs overnight unless someone queues it by hand, and a stuck change stalls all work instead of only the work that depends on it. gloam-idle already has a backlog of eight changes with declared dependencies (`unify-content-gates` → `dialogue-node-atomic-commit` → `quest-outcomes` → …), but the dependencies live only in proposal prose.

Conductor should pull that work itself: start every change whose dependencies have merged, run independent ones in parallel within a limit, and move on to the next change without a human. This is the "agents pull work themselves under human-set limits" pillar from the product context.

## What Changes

- **Change dependencies become data.** A change declares `depends_on: [<change>, …]` in its own `.openspec.yaml`, which the OpenSpec CLI already tolerates. The proposal prose stays the human-readable explanation; nothing parses it.
- **A per-project change queue.** The operator queues changes from the OpenSpec panel ("queue" next to today's "start"). Conductor stores the queue, the dependency graph and each entry's state in SQLite.
- **An autonomous scheduler.** On each reconcile pass Conductor starts every queued change whose dependencies are all *merged* (archived on the project's default branch), up to a per-project parallelism limit. Each start creates an ordinary feature through the existing start path, with the project's usual `conductor.yaml`. The workflow is unchanged.
- **Failure isolation.** An escalated or abandoned feature blocks only the changes that depend on it, directly or transitively; independent changes keep starting. Resolving the escalation (recover/resume) or removing the entry unblocks its dependants.
- **Guard rails a human sets.** Per project: the queue can be paused, the parallelism limit is configured (default 1), and a validation step rejects cycles, unknown dependencies and dependencies on changes that are neither active nor archived.
- **Merge policy stays in the workflow.** Auto-merge is not a Conductor feature: a project opts in by removing the human merge gate from its own `conductor.yaml`. The queue only needs to know when a change has merged.
- **Visibility.** The OpenSpec panel shows each change's queue state, its dependencies and why it is waiting ("waiting for `quest-outcomes`", "blocked: `unify-content-gates` escalated", "queue paused", "parallelism limit reached").

Out of scope (separate later changes):
- an agent that splits an oversized change into several smaller dependent changes;
- per-task execution inside a change (see `docs/task-contract-design.md`; the data above shows it would only shorten the ~10% spent on first implementation);
- token or cost budgets and time windows for overnight runs;
- cross-project dependencies.

## Capabilities

### New Capabilities
- `change-queue`: change dependency declaration, the per-project queue and its states, readiness (all dependencies merged), the scheduler with its parallelism limit and pause, failure isolation, queue validation, and the queue HTTP API.

### Modified Capabilities
- `openspec-plugin`: the panel can queue and dequeue changes, shows each change's queue state, dependencies and waiting reason, and exposes the queue pause and parallelism controls; "start work" remains for running a change immediately.

## Impact

- **`packages/core`:** a pure scheduling function (queue + dependency graph + merged set + running features + limit → changes to start, with a reason for every change not started), and pure queue validation (cycles, unknown references).
- **`packages/server`:** queue tables and store accessors (additive migration), queue HTTP endpoints, and a scheduler hook in the reconcile cycle that calls the existing feature-start path. Merged state is read from the project's default branch (`openspec/changes/archive/*-<name>/` present) through the existing git process port.
- **`plugins/openspec`:** queue actions, queue state and waiting reasons in the panel; reading `depends_on` from `.openspec.yaml`.
- **Conductor DB:** additive migration only (new tables); in-flight features are untouched.
- **gloam-idle:** no required change. To run unattended, a project adds `depends_on` to its changes' `.openspec.yaml` and, if it wants auto-merge, removes the `merge_gate` human step from `conductor.yaml`. Both are the project's own choice.
- **opencode-conductor carry-over:** none. The seed had no queue; this is new behaviour.
- **Confirmed decisions:** no change. The product context already lists pull-scheduling as a later phase; this change is its first step and it keeps `conductor.yaml` as the only execution format.
