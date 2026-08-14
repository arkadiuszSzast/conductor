## Purpose

Defines durable, self-contained and atomically accepted agent assignments that survive runner and daemon restarts without losing or duplicating work.

## ADDED Requirements

### Requirement: Every assignment is self-contained
An agent assignment SHALL include immutable run/attempt IDs, project and working directory, role binding, optional model/variant, rendered prompt, required capabilities/tools, reporting endpoint/instructions and lease/deadline. A runner SHALL not need to query engine internals to execute it.

#### Scenario: Fresh session receives report instruction
- **WHEN** a runner accepts an assignment
- **THEN** the prompted agent receives the exact run ID and an unambiguous instruction to report outcome or verdict through the daemon before completion

#### Scenario: Project directory is preserved
- **WHEN** the daemon assigns work for project A while the runner also serves project B
- **THEN** create and prompt operations carry A's exact worktree directory and cannot default to B or registration order

### Requirement: Unassigned work is durable and visible
If no compatible leased runner is available, Conductor SHALL persist the assignment target and compatibility requirements without creating a failed run. The feature SHALL expose that no agent is active, why assignment is blocked and when it will be observed again or escalate.

#### Scenario: Task starts before opencode runner
- **WHEN** an agent step becomes ready while the opencode runner is offline
- **THEN** the task remains recoverably blocked and starts automatically after a compatible runner registers within its wait budget

#### Scenario: Daemon restarts before assignment
- **WHEN** the daemon restarts while an agent step is unassigned
- **THEN** it reconstructs the offer from SQLite and neither loses the task nor invents an active session

### Requirement: Assignment acceptance is leased and atomic
The daemon SHALL offer an assignment to one compatible runner under a durable lease. Acceptance SHALL atomically bind runner/session ownership to the run attempt. Lease expiry before acceptance permits reassignment; after acceptance, reassignment requires reconciliation and a new attempt/idempotency key.

#### Scenario: Two runners race for one assignment
- **WHEN** two compatible runners become eligible for the same offer
- **THEN** exactly one is bound and the other observes an already-claimed result without creating a session

#### Scenario: Runner disappears before acceptance
- **WHEN** the selected runner's lease expires before assignment acceptance
- **THEN** the offer becomes eligible for another compatible runner without consuming an executable attempt

### Requirement: Timeline notes do not trigger inference
Where supported, the daemon MAY append informational notes to a feature/session for human readability. A note operation SHALL be explicitly non-inferential and best-effort; failure SHALL never block workflow progression.

#### Scenario: Timeline projection fails
- **WHEN** the runtime refuses a non-inferential note
- **THEN** the durable timeline remains in SQLite, a diagnostic is logged and no agent prompt is triggered
