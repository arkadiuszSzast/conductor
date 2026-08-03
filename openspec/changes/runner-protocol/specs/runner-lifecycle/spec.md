## ADDED Requirements

### Requirement: Runner availability is leased, not assumed
A registered runner SHALL renew a bounded availability lease through
heartbeats. Expiry SHALL mark it unavailable without deleting runner identity
or active assignment history. The daemon SHALL not assign new work to an
expired runner.

#### Scenario: Runner dies without deregistering
- **WHEN** heartbeats stop and the availability lease expires
- **THEN** the daemon marks the runner unavailable, preserves active runs and
  reconciles their sessions according to policy

#### Scenario: Runner returns
- **WHEN** the same runner identity registers after restart
- **THEN** it may reconcile sessions it still knows and accept new work; the
  daemon does not create duplicate runner identities

### Requirement: Session creation is idempotent
Every create request SHALL carry a daemon-issued idempotency key bound to a run
attempt. Re-delivery SHALL return the original session reference or a stable
terminal error; it SHALL NOT create a second session for the same attempt.

#### Scenario: Response is lost after session creation
- **WHEN** the runner creates a session but the response is lost and the daemon
  retries with the same idempotency key
- **THEN** the runner returns the existing session reference

### Requirement: Unknown status is handled in the safe direction
Status SHALL distinguish busy, idle, provider-retrying and missing. If a
status endpoint is unavailable or ambiguous, the runner SHALL return an
explicit unknown/transient error; the daemon SHALL NOT nudge or reap based on
missing information.

#### Scenario: Runtime status endpoint fails
- **WHEN** the runner cannot determine a live session's status
- **THEN** it reports a transient status failure and the daemon treats the run
  as potentially busy until policy schedules another observation

### Requirement: Cancellation is best-effort and audited
The daemon SHALL be able to request session cancellation, but completion of a
workflow cancellation SHALL not depend on runner availability. Both request
and observed result SHALL be recorded.

#### Scenario: Runner is offline during abandon
- **WHEN** a human abandons a feature whose runner is unavailable
- **THEN** the durable workflow becomes abandoned immediately and cancellation
  remains an auditable best-effort cleanup
