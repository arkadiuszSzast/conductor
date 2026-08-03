## ADDED Requirements

### Requirement: Retry budgets constrain tries and elapsed time
A policy SHALL specify finite `max_attempts` and/or `max_elapsed`; both are
upper bounds and the first exhausted bound stops retry. The elapsed budget
SHALL measure from the first attempt in the retry episode using an injected
clock and SHALL include execution and waiting time.

#### Scenario: Try limit exhausts first
- **WHEN** max attempts is reached before the elapsed deadline
- **THEN** no further retry is scheduled and the configured terminal route
  (escalate/fail/goto) runs with a budget summary

#### Scenario: Elapsed budget exhausts during backoff
- **WHEN** the next computed attempt would start after the elapsed deadline
- **THEN** it is not scheduled; the workflow reaches its configured terminal
  route at the deadline without one extra attempt

### Requirement: Policies may vary by failure class
A step SHALL have a default policy and MAY override behaviour per failure
class. Configuration SHALL support patient retries for transient upstream,
transport and capacity failures while routing deterministic failures
immediately. Invalid configuration SHALL be rejected before workflow start.

#### Scenario: Same step handles weather and code failure differently
- **WHEN** an agent step first receives `transient_upstream` and later reports a
  deterministic task failure
- **THEN** the upstream failure is delayed under patient backoff while the
  deterministic failure follows its immediate failure route

### Requirement: Escalation explains and can be resumed explicitly
Budget exhaustion SHALL persist an escalation containing attempts, elapsed
time, failure-class counts, last diagnostic and next policy route. A human may
resume with default budget reset or an explicit override; the audit log SHALL
record who changed what.

#### Scenario: Human resumes after provider recovery
- **WHEN** a transient-outage escalation is resumed after recovery
- **THEN** the current retry episode receives a new configured budget, one
  attempt becomes eligible and the old failure history remains in the audit
  timeline
