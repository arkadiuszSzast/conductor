## Purpose

Defines durable runner identity and leased availability so runner disappearance and return are observable, safe and automatically recoverable.

## ADDED Requirements

### Requirement: Runner availability is leased, not assumed
A registered runner SHALL renew a bounded availability lease through heartbeats. Expiry SHALL mark it unavailable without deleting runner identity or active assignment history. The daemon SHALL not assign new work to an expired runner.

#### Scenario: Runner dies without deregistering
- **WHEN** heartbeats stop and the availability lease expires
- **THEN** the daemon marks the runner unavailable, preserves active runs and reconciles their sessions according to generic policy

#### Scenario: Runner returns
- **WHEN** the same stable runner identity registers after restart
- **THEN** it may reconcile sessions it still knows and accept new work without creating a duplicate identity

### Requirement: Availability changes wake compatible waiting work
Runner registration, capability change, lease renewal and lease expiry SHALL trigger or expedite reconciliation of affected unassigned agent steps. Heartbeat reconciliation SHALL remain the correctness path if a wake-up signal is lost.

#### Scenario: Runner starts after a task
- **WHEN** a task is waiting for a compatible runner and one registers with the required project and tools
- **THEN** the daemon makes the assignment eligible promptly and atomically binds at most one runner

#### Scenario: Incompatible runner registers
- **WHEN** a waiting task requires capabilities absent from the newly registered runner
- **THEN** the task remains blocked with updated diagnostics and no executable retry is consumed

### Requirement: Session creation and prompting are idempotent
Every create and prompt request SHALL carry a daemon-issued idempotency key bound to a run attempt. Re-delivery SHALL return the original effect or a stable terminal error and SHALL NOT create a second session or duplicate the prompt.

#### Scenario: Response is lost after session creation
- **WHEN** the runner creates a session but the response is lost and the daemon retries with the same idempotency key
- **THEN** the runner returns the existing session reference

#### Scenario: Prompt acceptance response is lost
- **WHEN** a prompt was accepted but its response is lost
- **THEN** reconciliation observes the idempotent operation or session state and does not blindly send a second prompt

### Requirement: Unknown status is handled in the safe direction
Status SHALL distinguish busy, idle, provider-retrying and missing. If a status endpoint is unavailable or ambiguous, the runner SHALL return an explicit unknown/transient error; the daemon SHALL NOT nudge or reap based on missing information.

#### Scenario: Runtime status endpoint fails
- **WHEN** the runner cannot determine a live session's status
- **THEN** it reports a transient status failure and the daemon treats the run as potentially busy until policy schedules another observation

### Requirement: Cancellation is best-effort and audited
The daemon SHALL be able to request session cancellation, but completion of pause or workflow abandonment SHALL not depend on runner availability. Both request and observed result SHALL be recorded.

#### Scenario: Runner is offline during abandon
- **WHEN** a human abandons a feature whose runner is unavailable
- **THEN** the durable workflow becomes abandoned immediately and cancellation remains an auditable best-effort cleanup
