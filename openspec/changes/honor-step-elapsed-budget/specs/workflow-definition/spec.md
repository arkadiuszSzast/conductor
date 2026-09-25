## ADDED Requirements

### Requirement: A step's retry policy bounds elapsed time

When a step declares `retry.maxElapsed`, that ISO-8601 duration SHALL be the
elapsed deadline for the step's retry episode: retries stop once the time since
the first attempt in the episode (excluding paused spans) would exceed it, and
the step routes through its configured terminal failure route. When
`maxElapsed` is absent, the classified failure's class-default elapsed budget
SHALL govern. The deadline SHALL bound when a further attempt may start, on the
same episode anchor and pause accounting as the class default.

Validation SHALL reject a `retry.maxElapsed` that is not an ISO-8601 duration
before the workflow starts.

#### Scenario: A step extends its elapsed budget for a long job

- **WHEN** an `implement` step declares `retry.maxElapsed: PT6H` and its first
  attempt is reaped as a `timeout` failure after 20 minutes
- **THEN** the failure is retried (subject to `maxAttempts`) instead of being
  escalated, because 20 minutes is inside the step's own 6-hour deadline

#### Scenario: A step without an override keeps the class default

- **WHEN** a step declares `retry` with only `maxAttempts`/`backoff` and its
  first attempt fails as `timeout` after exceeding the class-default elapsed
  budget
- **THEN** no retry is scheduled and the step escalates, exactly as before

#### Scenario: Operator recovery keeps the step's deadline

- **WHEN** an operator recovers an escalated step whose retry declared
  `retry.maxElapsed`
- **THEN** the new recovery episode carries that step deadline, not the class
  default
