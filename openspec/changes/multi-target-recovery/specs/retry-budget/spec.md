# retry-budget Specification (delta) — multi-target recovery

## MODIFIED Requirements

### Requirement: Resume and recover have distinct semantics

`resume` SHALL only remove a deliberate pause and SHALL preserve retry
episodes and budgets. `recover` SHALL target one or more recoverable
escalated job/step targets, require an operator note, create a new
audited episode with default reset or explicit finite override for EACH
recovered target, and make one attempt or resource observation eligible
per target. All targets selected in one recover request SHALL be
re-armed in a single atomic transaction under one idempotency key and
one version check — a partial re-arm MUST NOT be observable. Recovery
SHALL reject stale or terminal-success targets; a request naming several
candidates where any single one is stale SHALL be rejected wholesale
(no partial fallback). An ambiguous request (several candidates, no
selection, no `all`) SHALL be rejected listing the current candidates
AND offering the recover-all form.

#### Scenario: Operator resumes a paused retry wait

- **WHEN** an operator resumes a paused feature whose retry was already scheduled
- **THEN** the same episode and remaining budget continue without resetting attempts

#### Scenario: Operator recovers after provider restoration

- **WHEN** a transient-outage escalation is recovered after service restoration
- **THEN** the selected failed step receives a new finite budget, one attempt becomes eligible and old failure history remains in the timeline

#### Scenario: Operator recovers a no-runner escalation

- **WHEN** a compatible runner now exists and the operator recovers a feature whose resource wait expired
- **THEN** Conductor starts a new finite recovery episode and assigns the blocked step exactly once

#### Scenario: Historical resource wait is not the current failure

- **WHEN** an escalated feature has a closed historical resource wait but its current durable frontier identifies a different failed step
- **THEN** recovery does not select the historical wait and only offers the current failed target

#### Scenario: Parallel failures recover together or by explicit selection

- **WHEN** an escalated feature has more than one independent recoverable
  job/step target and the operator passes `all` (or selects several
  targets explicitly)
- **THEN** every selected target is re-armed in one transaction, each
  with a fresh finite budget, cascade-skipped downstream jobs reset to
  pending exactly once, and the feature transitions to running with all
  recovered steps armed

#### Scenario: Ambiguous request offers recover-all

- **WHEN** an escalated feature has more than one independent recoverable
  job/step target and the operator omits both the target selection and `all`
- **THEN** recovery rejects the ambiguous request without re-arming any
  step, exposes the current targets for explicit selection, and names
  the recover-all option

#### Scenario: Selected recovery target became stale

- **WHEN** the operator selects a job/step (alone or within a multi-target
  selection) that is no longer a current recoverable target
- **THEN** recovery rejects the whole request without re-arming any target
  and without falling back to another historical or current candidate

### Requirement: Failure classification recognizes runner-connection failures

The engine's execution-boundary classification SHALL classify runner
connection failures — connection-refused / unreachable-endpoint error
shapes thrown when prompting or dispatching to a session runner (e.g.
"Unable to connect", `ConnectionRefused`, "Connection closed") — as
`transient_transport`, not `internal`, so a temporarily absent runner
follows transient backoff and resource-wait behaviour instead of
consuming the step's deterministic attempt budget.

#### Scenario: Dead runner does not burn the attempt budget as internal

- **WHEN** dispatching or prompting a run fails because the runner
  endpoint cannot be reached ("Unable to connect. Is the computer able
  to access the url?")
- **THEN** the resulting failure envelope carries class
  `transient_transport` and the step follows the transient backoff
  budget rather than the `internal` class default
