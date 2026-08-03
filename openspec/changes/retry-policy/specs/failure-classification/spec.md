## ADDED Requirements

### Requirement: Every failure has a stable machine-readable class
Actions, runners and daemon operations SHALL report one class from a documented
taxonomy independent of human message text. The initial taxonomy SHALL
distinguish transient upstream/provider, transient transport, capacity/rate
limit, timeout, deterministic command/gate, invalid configuration/request,
missing external resource/session, cancellation and internal defects.

#### Scenario: Upstream provider 503
- **WHEN** a runner observes a provider HTTP 503
- **THEN** it reports `transient_upstream` with diagnostic context and optional
  retry hint; policy evaluation never parses "503" from message text

#### Scenario: Quality gate exits non-zero
- **WHEN** a command action deterministically exits non-zero
- **THEN** it reports `deterministic_failure`, and default policy does not
  repeatedly sleep/re-run it as if it were weather

### Requirement: Unknown failures default safely
A failure without a valid class SHALL be recorded as `internal` with its
original diagnostic and SHALL use a conservative finite policy. It SHALL never
be silently treated as success or infinitely retried.

#### Scenario: Adapter returns malformed failure
- **WHEN** an adapter omits or invents a failure class
- **THEN** the daemon records a protocol/internal defect, applies the finite
  internal-error policy and surfaces diagnostics to operators
