## ADDED Requirements

### Requirement: Jobs form an acyclic dependency graph
A workflow's `jobs` SHALL form a directed acyclic graph through `needs`. Every
referenced job SHALL exist; cycles SHALL be rejected with the full cycle path.
Jobs with no dependencies may become ready independently; a job with multiple
dependencies becomes ready only when all required dependencies reach terminal
states compatible with its condition.

#### Scenario: Fan-out and fan-in
- **WHEN** jobs `test-a` and `test-b` both need `build`, and `review` needs both
  test jobs
- **THEN** the test jobs may execute concurrently after `build`, and `review`
  cannot start until both are terminal and its condition evaluates true

#### Scenario: Dependency cycle is rejected
- **WHEN** job A needs B and B needs A
- **THEN** validation rejects the workflow and reports `A → B → A`

### Requirement: Readiness and skip propagation are deterministic
For a persisted workflow state and event, the pure interpreter SHALL always
produce the same set of readiness/transition decisions. A dependency failure
or skip SHALL propagate according to explicit conditions; no job may start
based on iteration order or wall-clock timing.

#### Scenario: Failed dependency skips default consumer
- **WHEN** a required job fails and a dependent job has no condition allowing
  failure
- **THEN** the dependent job is marked skipped with an auditable reason

#### Scenario: Cleanup explicitly runs after failure
- **WHEN** a cleanup job declares a condition equivalent to `always()`
- **THEN** it becomes ready after all dependencies terminate, regardless of
  success/failure/skip

### Requirement: Loops remain explicit and bounded
Verdict/failure routes MAY return to an earlier step or job only when a
tries-and-time budget bounds the cycle. Validation SHALL reject every reachable
cycle without a counter/budget.

#### Scenario: Review/fix loop is bounded
- **WHEN** a review verdict routes to a fixer and back to review with a maximum
  round and wall-time budget
- **THEN** the workflow may loop until approval or budget exhaustion, then
  escalates durably
