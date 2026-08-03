## ADDED Requirements

### Requirement: Workflows declare their start conditions
A workflow SHALL declare one or more triggers under `on`. v1 SHALL execute
`manual` and `schedule` triggers. Event trigger names such as `issue.labeled`
and `pr.opened` SHALL be representable and validated, but SHALL remain inactive
until a matching ingress adapter is configured.

#### Scenario: Manual trigger carries validated inputs
- **WHEN** a user starts a workflow through CLI/API with declared inputs
- **THEN** Conductor validates types/defaults/required values, persists the
  trigger event and creates exactly one workflow run

#### Scenario: Schedule survives restart
- **WHEN** a scheduled fire time passes while the daemon is stopped
- **THEN** restart applies the workflow's explicit catch-up policy (skip or one
  catch-up run) and never creates an unbounded burst

### Requirement: Trigger delivery is idempotent
Every trigger event SHALL have a durable idempotency key. Re-delivery of the
same event SHALL yield the existing run and SHALL NOT start duplicate work.

#### Scenario: Duplicate webhook delivery
- **WHEN** an ingress adapter delivers the same provider event ID twice
- **THEN** the second delivery returns the first event/run reference and no
  second workflow run is created
