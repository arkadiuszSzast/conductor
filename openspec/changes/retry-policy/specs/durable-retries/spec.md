## ADDED Requirements

### Requirement: Retry scheduling is durable state
When policy chooses retry, the daemon SHALL persist attempt count, budget start,
last failure class/time, computed delay and `next_attempt_at` in the same
transaction as the failed attempt's terminal state. No correctness SHALL
depend on an in-memory timer or sleep.

#### Scenario: Daemon restarts during backoff
- **WHEN** the daemon stops after scheduling a retry and restarts before
  `next_attempt_at`
- **THEN** it reconstructs the wait, does not dispatch early and executes at
  most one next attempt when eligible

#### Scenario: Restart after retry is due
- **WHEN** the daemon starts after `next_attempt_at` passed
- **THEN** reconciliation makes the attempt eligible once, subject to normal
  concurrency claims

### Requirement: Exponential backoff has bounded jitter
A retry policy SHALL define base delay, multiplier, maximum delay and jitter
range. Computed delays SHALL grow exponentially until capped, use jitter to
avoid synchronized retries and never be negative or exceed configured bounds.
The random source SHALL be injectable for deterministic tests.

#### Scenario: Delays reach cap
- **WHEN** repeated retryable failures exceed the exponential growth range
- **THEN** subsequent base delays remain at the configured cap while bounded
  jitter is applied

#### Scenario: Retry-After hint
- **WHEN** a capacity failure includes a provider retry-after hint
- **THEN** policy considers it but clamps the resulting schedule to configured
  minimum/maximum bounds and records the decision source

### Requirement: Reconciliation never duplicates a retry
Eligibility and claim SHALL be transactional. Concurrent reconcile passes or
workers observing one due retry SHALL produce exactly one new attempt.

#### Scenario: Two reconcile passes see a due retry
- **WHEN** two workers evaluate the same retry at once
- **THEN** one claims and dispatches it and the other observes the claim
  without creating another run
