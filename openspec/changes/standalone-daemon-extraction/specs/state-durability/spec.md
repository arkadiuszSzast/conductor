## ADDED Requirements

### Requirement: Existing conductor state is adopted additively
The standalone daemon SHALL open a database created by
`opencode-conductor`, apply only additive migrations and reconstruct every
in-flight feature with the same status, current step, attempts, rounds,
session references, worktree, branch, pull request, findings, review threads
and audit history. A failed migration SHALL roll back atomically and SHALL NOT
leave the database partially upgraded.

#### Scenario: In-flight feature survives migration
- **WHEN** a legacy database contains a feature waiting at a human gate with
  open findings
- **THEN** the standalone daemon presents the same feature at the same gate
  with the same findings and accepts approval without replaying completed
  steps

#### Scenario: Migration is interrupted
- **WHEN** the daemon terminates while applying an additive migration
- **THEN** SQLite rolls the migration back and the next start can apply it
  safely from the previous valid schema

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

### Requirement: Legacy behaviour remains covered by tests
The seed's interpreter, engine, store, validator, template, built-in action,
findings-publishing and preset tests SHALL be moved with the extracted code and
remain green. Any intentional semantic change SHALL have a named spec and new
tests; extraction itself SHALL NOT silently change behaviour.

#### Scenario: Extraction test parity
- **WHEN** the extracted packages run their test suite
- **THEN** every migrated seed test passes against the extracted implementation
  or is replaced by a stricter equivalent documenting the same behaviour
