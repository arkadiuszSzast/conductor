## Purpose

Defines the stable machine-readable vocabulary used to distinguish executable failures from temporarily unavailable resources across every Conductor effect boundary.

## ADDED Requirements

### Requirement: Every executable failure has a stable machine-readable class
Actions, commands, runners and daemon operations SHALL report one class from a documented taxonomy independent of human message text. The initial taxonomy SHALL distinguish transient upstream/provider, transient transport, capacity/rate limit, timeout, deterministic command/gate, invalid configuration/request, missing external session, cancellation and internal defects.

#### Scenario: Upstream provider 503
- **WHEN** a runner observes a provider HTTP 503
- **THEN** it reports `transient_upstream` with diagnostic context and an optional retry hint, and policy evaluation never parses "503" from message text

#### Scenario: Quality gate exits non-zero
- **WHEN** a command deterministically exits non-zero
- **THEN** it reports `deterministic_failure`, and default policy does not repeatedly delay and re-run it as transient weather

### Requirement: Resource unavailability is distinct from an attempt failure
When an execution cannot start because a required compatible resource is unavailable, Conductor SHALL record a stable resource-wait reason instead of concluding a step attempt as failed. Initial resource reasons SHALL include compatible runner unavailable, workflow/action binding unavailable and temporary dependency unavailability.

#### Scenario: No runner is registered at dispatch time
- **WHEN** an agent step becomes executable but no compatible runner is available
- **THEN** the step enters durable resource wait, no agent run attempt is failed, and its retry-attempt budget is unchanged

#### Scenario: Runner rejects a valid assignment transiently
- **WHEN** a compatible runner is selected but its operation fails with a classified transient transport or capacity error
- **THEN** Conductor records a retryable executable failure under policy rather than reclassifying it as mere absence of a runner

### Requirement: Unknown failures default safely
A failure without a valid class SHALL be recorded as `internal` with its original diagnostic and SHALL use a conservative finite policy. It SHALL never be silently treated as success or infinitely retried.

#### Scenario: Adapter returns malformed failure
- **WHEN** an adapter omits or invents a failure class
- **THEN** the daemon records a protocol/internal defect, applies the finite internal-error policy and surfaces diagnostics to operators

### Requirement: Classification is visible and secret-safe
API, CLI, UI and timeline projections SHALL expose the stable class or resource reason and a bounded human diagnostic without leaking credentials or relying on unstructured logs.

#### Scenario: Operator inspects a blocked task
- **WHEN** a feature is waiting for a compatible runner
- **THEN** its projections identify the blocked job/step, runner resource reason, first and latest observation times and recovery expectation
