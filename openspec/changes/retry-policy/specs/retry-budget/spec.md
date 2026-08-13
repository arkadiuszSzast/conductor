## Purpose

Defines finite retry and wait budgets plus explicit, audited operator recovery after automatic recovery has safely exhausted its allowance.

## ADDED Requirements

### Requirement: Retry budgets constrain tries and elapsed time
A retry policy SHALL specify finite `max_attempts` and `max_elapsed`; both are upper bounds and the first exhausted bound stops retry. The elapsed budget SHALL measure from the first attempt in the retry episode using an injected clock and SHALL include execution and unpaused waiting time.

#### Scenario: Try limit exhausts first
- **WHEN** max attempts is reached before the elapsed deadline
- **THEN** no further retry is scheduled and the configured terminal route runs with a budget summary

#### Scenario: Elapsed budget exhausts during backoff
- **WHEN** the next computed attempt would start after the elapsed deadline
- **THEN** it is not scheduled, and the workflow reaches its configured terminal route at the deadline without one extra attempt

### Requirement: Resource-wait budgets are finite but do not consume attempt budgets
A resource-wait policy SHALL bound elapsed wait and observation cadence separately from executable retry attempts. Observing an unavailable resource SHALL NOT increment step attempts; expiry SHALL escalate instead of waiting forever.

#### Scenario: Runner remains absent through many observations
- **WHEN** Conductor observes runner unavailability repeatedly before the resource-wait deadline
- **THEN** the step's attempt count remains unchanged while the wait history and elapsed wait advance

### Requirement: Policies may vary by failure class
A step SHALL have a default policy and MAY override behaviour per failure class. Configuration SHALL support patient retries for transient upstream, transport and capacity failures while routing deterministic failures immediately. Invalid configuration SHALL be rejected before workflow start.

#### Scenario: Same step handles weather and code failure differently
- **WHEN** an agent operation first receives `transient_upstream` and later reports a deterministic task failure
- **THEN** the upstream failure is delayed under patient backoff while the deterministic failure follows its immediate failure route

### Requirement: Resume and recover have distinct semantics
`resume` SHALL only remove a deliberate pause and SHALL preserve retry episodes and budgets. `recover` SHALL target a recoverable escalated job/step, require an operator note, create a new audited episode with default reset or explicit finite override, and make one attempt or resource observation eligible. Recovery SHALL reject ambiguous, stale or terminal-success targets.

#### Scenario: Operator resumes a paused retry wait
- **WHEN** an operator resumes a paused feature whose retry was already scheduled
- **THEN** the same episode and remaining budget continue without resetting attempts

#### Scenario: Operator recovers after provider restoration
- **WHEN** a transient-outage escalation is recovered after service restoration
- **THEN** the selected failed step receives a new finite budget, one attempt becomes eligible and old failure history remains in the timeline

#### Scenario: Operator recovers a no-runner escalation
- **WHEN** a compatible runner now exists and the operator recovers a feature whose resource wait expired
- **THEN** Conductor starts a new finite recovery episode and assigns the blocked step exactly once

### Requirement: Escalation explains available recovery
Budget or resource-wait exhaustion SHALL persist attempts, elapsed time, class/reason counts, last diagnostic, failed or blocked targets and allowed next actions. API, CLI and UI SHALL expose that summary and SHALL NOT describe an escalated feature as actively running.

#### Scenario: Operator opens an exhausted feature
- **WHEN** a feature has escalated after retries or resource waiting
- **THEN** the UI identifies that no agent is active, explains why automation stopped and offers recover when the target is recoverable
