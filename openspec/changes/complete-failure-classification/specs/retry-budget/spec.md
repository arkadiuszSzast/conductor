## ADDED Requirements

### Requirement: Steps without a retry policy follow their failure class's default budget
A step that declares no `retry:` policy SHALL retry a classified failure under that class's default budget and backoff. The default budgets are:
- transient classes (`transient_upstream`, `transient_transport`, `capacity`, `timeout`): patient, finite retries with backoff;
- `internal`: a small, finite number of delayed retries;
- `deterministic_failure`, `invalid_config`, `missing_session` and `cancelled`: a single attempt, routed immediately.

A step that declares a `retry:` policy SHALL keep using that policy's attempt count for every class. When a class-default budget is exhausted, the step SHALL take its configured terminal route (`onFail`, else job failure) exactly as an exhausted explicit policy does.

#### Scenario: GitHub outage on a step without a retry block
- **WHEN** a `github/pr-create` step without `retry:` fails with class `transient_upstream`
- **THEN** the step is retried under patient backoff instead of escalating the feature on the first failure

#### Scenario: Deterministic failure on a step without a retry block
- **WHEN** a step without `retry:` fails with class `deterministic_failure`
- **THEN** no retry is scheduled and the step takes its terminal route immediately

#### Scenario: Explicit retry policy is unchanged
- **WHEN** a step declaring `retry: { maxAttempts: 2 }` fails twice with class `transient_upstream`
- **THEN** the step takes its terminal route after the second attempt, as it does today

#### Scenario: Transient class budget exhausted
- **WHEN** a step without `retry:` keeps failing with class `transient_transport` until the class-default budget is exhausted
- **THEN** the step takes its terminal route and escalation reports the class, the attempts and the last diagnostic
