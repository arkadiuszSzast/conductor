## ADDED Requirements

### Requirement: Every assignment is self-contained
An agent assignment SHALL include immutable run/attempt IDs, project and
working directory, role binding, optional model/variant, rendered prompt,
required capabilities/tools, reporting endpoint/instructions and lease/deadline.
A runner SHALL not need to query engine internals to execute it.

#### Scenario: Fresh session receives report instruction
- **WHEN** a runner accepts an assignment
- **THEN** the prompted agent receives the exact run ID and an unambiguous
  instruction to report outcome/verdict through the daemon before completion

#### Scenario: Project directory is preserved
- **WHEN** the daemon assigns work for project A while the runner also serves
  project B
- **THEN** create and prompt operations carry A's exact worktree directory and
  cannot default to B or registration order

### Requirement: Assignment acceptance is leased and atomic
The daemon SHALL offer an assignment to one compatible runner under a durable
lease. Acceptance SHALL atomically bind runner/session ownership to the run
attempt. Lease expiry before acceptance permits reassignment; after acceptance,
reassignment requires reconciliation and a new attempt/idempotency key.

#### Scenario: Two runners race for one assignment
- **WHEN** two compatible runners attempt to accept the same offer
- **THEN** exactly one succeeds and the other receives an already-claimed
  result without creating a session

### Requirement: Timeline notes do not trigger inference
Where supported, the daemon MAY append informational notes to a feature/session
for human readability. A note operation SHALL be explicitly non-inferential
and best-effort; failure SHALL never block workflow progression.

#### Scenario: Timeline projection fails
- **WHEN** the runtime refuses a non-inferential note
- **THEN** the durable timeline remains in SQLite, a diagnostic is logged and
  no agent prompt is triggered
