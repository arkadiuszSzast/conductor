## ADDED Requirements

### Requirement: Schema migrations are atomic and append-only
The daemon SHALL apply schema migrations through an append-only ledger: the
applied history must be an exact prefix of the compiled migration list, each
migration body and its ledger insert SHALL share one transaction, and a failed
migration SHALL roll back atomically and SHALL NOT leave the database
partially upgraded. There is no seed-database adoption path: the daemon owns
its schema from the first migration.

#### Scenario: Migration is interrupted
- **WHEN** the daemon terminates while applying a migration
- **THEN** SQLite rolls the migration back and the next start can apply it
  safely from the previous valid schema

#### Scenario: Divergent ledger fails startup
- **WHEN** the database's migration ledger is not a prefix of the compiled
  migration list
- **THEN** startup fails with a diagnostic instead of guessing

### Requirement: Graph feature state survives restart
The daemon SHALL persist the full graph `FeatureState` — per-job status,
current step, attempts, rerun rounds and outputs; per-step status and outputs;
feedback snapshots — such that a daemon restarted on the same database
presents every feature at the same jobs/steps with the same budgets and
accepts gate decisions without replaying completed work.

#### Scenario: In-flight feature survives restart
- **WHEN** the daemon stops while a feature waits at a human gate with
  completed predecessor jobs
- **THEN** a new daemon on the same database presents the same feature at the
  same gate and accepts approval without re-executing completed steps

### Requirement: SQLite remains the source of truth
Every state transition and its audit entry SHALL be committed in one SQLite
transaction. Sessions, GitHub reviews and dashboard views SHALL be disposable
executors or projections; no one of them may carry authoritative workflow or
finding state unavailable in SQLite.

#### Scenario: Process dies between decision and effect
- **WHEN** the daemon persists an execute decision and terminates before the
  corresponding step run starts
- **THEN** the next reconciliation pass detects the missing run and executes
  the step without losing or duplicating the transition record

#### Scenario: GitHub projection fails
- **WHEN** publishing a recorded finding to GitHub fails
- **THEN** the finding remains authoritative in SQLite, the workflow does not
  lose it, and a later synchronization may project it again

### Requirement: Operational behaviours remain covered by tests
The battle-tested operational behaviours carried forward from the seed —
confirmation-of-effect, idle debounce/nudge/reap, TTL reaping, atomic run
conclusion, duplicate-report rejection, findings lifecycle — SHALL be covered
by tests against the graph engine. Any intentional semantic change SHALL have
a named spec and new tests.

#### Scenario: Behavioural coverage on the graph engine
- **WHEN** the extracted packages run their test suite
- **THEN** every carried-forward operational behaviour passes against the
  graph engine implementation
