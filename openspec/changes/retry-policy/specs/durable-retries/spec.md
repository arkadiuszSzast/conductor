## Purpose

Makes retries, temporary resource waits and pause-aware recovery durable so daemon or runner restarts cannot lose work, duplicate attempts or falsely imply active execution.

## ADDED Requirements

### Requirement: Retry scheduling is durable state
When policy chooses retry, the daemon SHALL persist attempt count, budget start, last failure class/time, computed delay and `next_attempt_at` in the same transaction as the failed attempt's terminal state. No correctness SHALL depend on an in-memory timer or sleep.

#### Scenario: Daemon restarts during backoff
- **WHEN** the daemon stops after scheduling a retry and restarts before `next_attempt_at`
- **THEN** it reconstructs the wait, does not dispatch early and executes at most one next attempt when eligible

#### Scenario: Restart after retry is due
- **WHEN** the daemon starts after `next_attempt_at` passed
- **THEN** reconciliation makes the attempt eligible once, subject to normal concurrency claims

### Requirement: Resource waits are durable and recover automatically
When required execution infrastructure is unavailable before an attempt starts, Conductor SHALL persist a resource wait containing the target job/step, stable reason, first/latest observation, next observation time and finite deadline. The reconciler SHALL re-evaluate it without consuming the step attempt budget and SHALL dispatch once when a compatible resource becomes available.

#### Scenario: Runner starts after task submission
- **WHEN** an agent step is waiting because no compatible runner exists and a compatible runner later registers
- **THEN** reconciliation transactionally claims the wait and creates exactly one first attempt without human intervention

#### Scenario: Daemon restarts while waiting for runner
- **WHEN** the daemon restarts with a persisted runner wait
- **THEN** the feature remains visibly blocked and resumes observation from SQLite without becoming failed or losing its deadline

#### Scenario: Resource wait deadline expires
- **WHEN** a required resource remains unavailable until the configured finite wait deadline
- **THEN** Conductor escalates the feature with the blocked target, duration and latest diagnostic and offers explicit recovery

### Requirement: Exponential backoff has bounded jitter
A retry or resource-observation policy SHALL define base delay, multiplier, maximum delay and jitter range. Computed delays SHALL grow exponentially until capped, use jitter to avoid synchronized work and never be negative or exceed configured bounds. The random source SHALL be injectable for deterministic tests.

#### Scenario: Delays reach cap
- **WHEN** repeated retryable failures or unavailable observations exceed the exponential growth range
- **THEN** subsequent base delays remain at the configured cap while bounded jitter is applied

#### Scenario: Retry-After hint
- **WHEN** a capacity failure includes a provider retry-after hint
- **THEN** policy considers it but clamps the resulting schedule to configured minimum/maximum bounds and records the decision source

### Requirement: Due-work reconciliation never duplicates execution
Eligibility and claim SHALL be transactional. Concurrent reconcile passes or workers observing one due retry or resource wait SHALL produce exactly one new attempt.

#### Scenario: Two reconcile passes see due work
- **WHEN** two workers evaluate the same due retry or satisfiable resource wait at once
- **THEN** one claims and dispatches it and the other observes the claim without creating another run

### Requirement: Pause is a scheduling barrier
While a feature is paused, Conductor SHALL NOT dispatch missing or due executions, observe actions or resource waits, nudge or reap sessions, consume retry/wait budget, or apply downstream side effects. Conclusions that arrive after pause SHALL remain durably pending and SHALL be applied once after resume.

#### Scenario: Agent reports while feature is paused
- **WHEN** an active agent reports completion after the feature was paused
- **THEN** Conductor records the conclusion exactly once but does not start dependent work until resume

#### Scenario: Retry becomes due while paused
- **WHEN** `next_attempt_at` passes during a pause
- **THEN** no attempt starts, pause time is excluded from the remaining elapsed budget, and the eligible retry is claimed after resume

### Requirement: Reconciliation detects stranded active features
An active feature with no live run, human gate, retry schedule, resource wait or executable decision SHALL not remain silently `running`. Reconciliation SHALL either reconstruct provably missing execution or escalate with an actionable invariant diagnostic.

#### Scenario: Legacy feature has only failed and skipped jobs
- **WHEN** reconciliation observes a `running` feature whose jobs are all terminal and at least one failed
- **THEN** it normalizes the feature to `escalated` without replaying completed work
