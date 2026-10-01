## Purpose

Lets Conductor pull OpenSpec changes from a per-project queue on its own: it starts every change whose dependencies have merged, runs independent changes in parallel within a human-set limit, and keeps working when an unrelated change gets stuck.

## ADDED Requirements

### Requirement: A change declares its dependencies as data

A change SHALL declare the changes it depends on in its own `.openspec.yaml` as `depends_on`: a list of change names. An absent `depends_on` SHALL mean "no dependencies". A dependency SHALL name a change that exists in the same project, either active (`openspec/changes/<name>/`) or archived (`openspec/changes/archive/<date>-<name>/`). Conductor SHALL NOT derive dependencies from proposal prose.

#### Scenario: Dependencies read from the change

- **WHEN** `quest-outcomes/.openspec.yaml` contains `depends_on: [unify-content-gates, dialogue-node-atomic-commit]`
- **THEN** the queue records exactly those two dependencies for `quest-outcomes`

#### Scenario: No declaration means no dependencies

- **WHEN** a queued change's `.openspec.yaml` has no `depends_on` key
- **THEN** the change has no dependencies and is ready as soon as it is queued

#### Scenario: Dependency on an already archived change

- **WHEN** a change depends on a change that is already archived on the default branch
- **THEN** that dependency counts as merged

### Requirement: The queue is validated before it is accepted

Adding a change to the queue SHALL be refused, with a diagnostic naming the offending changes, when the change's dependency graph (following `depends_on` transitively through active changes) contains a cycle, or when a dependency names a change that is neither active nor archived. Validation SHALL be repeated whenever the scheduler reads a change's `depends_on`, and an entry whose graph has become invalid SHALL be marked `invalid` with the diagnostic instead of being started.

#### Scenario: Cycle is refused

- **WHEN** the operator queues `a`, and `a` depends on `b` while `b` depends on `a`
- **THEN** the request is refused with a diagnostic naming `a` and `b`, and nothing is queued

#### Scenario: Unknown dependency is refused

- **WHEN** the operator queues a change that depends on `does-not-exist`
- **THEN** the request is refused with a diagnostic naming `does-not-exist`

#### Scenario: A dependency edited into a cycle after queueing

- **WHEN** a queued change's `.openspec.yaml` is later edited so that its graph contains a cycle
- **THEN** the entry becomes `invalid` with the cycle diagnostic and is not started

### Requirement: A queued change is ready when all its dependencies have merged

A dependency SHALL count as merged only when the project's default branch contains the dependency's archived directory (`openspec/changes/archive/<date>-<name>/`). A feature that finished as `done` without that archive on the default branch SHALL NOT count as merged. A queued change SHALL be ready when every one of its dependencies has merged.

#### Scenario: Ready after its dependency merges

- **WHEN** `dialogue-node-atomic-commit` depends on `unify-content-gates`, and the PR implementing `unify-content-gates` merges with the change archived
- **THEN** on the next scheduler pass `dialogue-node-atomic-commit` is ready

#### Scenario: Done feature without a merge is not enough

- **WHEN** the feature for a dependency finished as `done` but the default branch has no archived directory for it
- **THEN** the dependant stays waiting, with a reason naming the unmerged dependency

### Requirement: The scheduler starts ready changes within a parallelism limit

On every reconcile pass, for each project with a running (not paused) queue, Conductor SHALL start ready changes in queue order until the number of the project's queue-started features that are not terminal reaches the project's parallelism limit (default 1). Starting a change SHALL create an ordinary feature through the same path as starting work from the panel, with the project's own workflow and its change input filled. A change SHALL be started at most once per queue entry, also across daemon restarts and concurrent reconcile passes.

#### Scenario: Next change starts without a human

- **WHEN** the queue holds `a` and `b`, `b` depends on `a`, the limit is 1, and `a`'s PR merges overnight
- **THEN** the next scheduler pass starts a feature for `b` with no human action

#### Scenario: Independent changes run in parallel

- **WHEN** the limit is 2 and two queued changes are ready and independent
- **THEN** both are started in the same pass

#### Scenario: Limit holds back a ready change

- **WHEN** the limit is 1, one queue-started feature is running and another queued change is ready
- **THEN** the ready change is not started and its waiting reason says the parallelism limit is reached

#### Scenario: Restart does not start a change twice

- **WHEN** the daemon restarts right after a queued change's feature was created
- **THEN** the entry is linked to that feature and no second feature is created for it

### Requirement: A stuck change blocks only its dependants

When a queue-started feature is escalated, paused or abandoned, its queue entry SHALL be marked accordingly (a paused feature keeps its entry `running`, still holds its parallelism slot, and blocks its dependants until it resumes), and every queued change that depends on it, directly or transitively, SHALL be `blocked` with a reason naming the stuck change. Changes that do not depend on it SHALL keep being scheduled. When the stuck feature resumes or is recovered, its dependants SHALL return to waiting. Removing an abandoned change's entry SHALL leave its dependants blocked until their `depends_on` no longer names it or the operator removes them.

#### Scenario: Unrelated work continues

- **WHEN** `quest-outcomes` escalates while `authoring-condition-editor`, which does not depend on it, is queued and ready
- **THEN** `authoring-condition-editor` is started and `quest-equipment-items`, which depends on `quest-outcomes`, is `blocked` with a reason naming `quest-outcomes`

#### Scenario: Recovery unblocks the dependants

- **WHEN** the escalated feature for `quest-outcomes` is recovered and later merges
- **THEN** `quest-equipment-items` becomes ready on the following pass

### Requirement: Every entry has an explainable state

Each queue entry SHALL be in exactly one state: `waiting` (with a reason: unmerged dependencies, parallelism limit, or queue paused), `blocked` (with the stuck dependency), `invalid` (with a diagnostic), `running` (linked to its feature), `escalated` (linked to its feature), `merged`, or `removed`. Every state other than `merged` and `removed` SHALL carry a human-readable reason. Entry state and every transition SHALL be stored durably and survive daemon restarts.

#### Scenario: Waiting reason names the missing dependency

- **WHEN** a queued change waits on two dependencies and one of them has merged
- **THEN** its reason names only the dependency that has not merged

#### Scenario: Merged entry

- **WHEN** a queue-started change's archive appears on the default branch
- **THEN** its entry becomes `merged`

### Requirement: The operator controls the queue

The operator SHALL be able to add a change to a project's queue, remove an entry that has not started or whose linked feature is terminal (`done` or `abandoned`), pause and resume a project's queue, set the project's parallelism limit (an integer of at least 1), and reorder entries that have not started. Pausing SHALL stop new starts only; running features SHALL continue. These operations SHALL be available through the HTTP API, and the queue with each entry's state, dependencies and reason SHALL be readable through it.

#### Scenario: Pause stops new starts only

- **WHEN** the operator pauses a queue with one running feature and one ready change
- **THEN** the running feature continues and the ready change is not started, with the reason "queue paused"

#### Scenario: Removing a running entry is refused

- **WHEN** the operator tries to remove an entry that is `starting`, or whose linked feature is not terminal (running, waiting for a human, paused or escalated)
- **THEN** the request is refused, and the operator is told to abandon the feature instead

#### Scenario: Removing an entry whose feature ended is allowed

- **WHEN** the operator removes an entry whose linked feature is `done` without a merge, or `abandoned`
- **THEN** the entry is removed
