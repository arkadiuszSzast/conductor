## ADDED Requirements

### Requirement: The service runs independently of every agent runtime
Conductor SHALL run as a standalone daemon process that owns workflow state,
interprets transitions, executes deterministic actions, reconciles external
state and exposes its control surface over a versioned HTTP API. Stopping or
restarting any connected runner SHALL NOT stop the daemon or lose workflow
state.

#### Scenario: Daemon starts without opencode
- **WHEN** the daemon starts on a host where no opencode process is running
- **THEN** it loads registered projects and durable workflow state, serves its
  API and reports runners as unavailable rather than failing to start

#### Scenario: Runner restarts during an agent step
- **WHEN** a runner process disappears while an agent step is active
- **THEN** the daemon preserves the run, observes the session as missing
  through reconciliation, applies the configured retry/escalation policy and
  never loses the feature's state

### Requirement: The API is the primary control surface
The daemon SHALL expose a versioned HTTP API for starting and inspecting
workflow runs, reporting step outcomes, approving/rejecting human gates,
pausing/resuming/abandoning runs, listing findings and reading the audit
timeline. The CLI, runner adapters and UI SHALL be clients of the same API.

#### Scenario: CLI and API yield the same state transition
- **WHEN** a human approves a waiting gate through `conductor approve`
- **THEN** the CLI calls the same API operation available to third-party
  clients and the transition is recorded once in the audit log

#### Scenario: Live state is observable
- **WHEN** a workflow transition, finding or escalation is persisted
- **THEN** API clients subscribed to the daemon's event stream receive a
  notification and can fetch the authoritative state

### Requirement: The daemon has an operational lifecycle
The daemon SHALL expose liveness and readiness endpoints, validate all project
configurations before executing work, shut down gracefully without beginning
new steps, and emit structured logs that identify project, feature, step and
run where applicable.

#### Scenario: Invalid project does not block valid projects
- **WHEN** one registered project's configuration is invalid at daemon start
- **THEN** that project is reported unavailable with diagnostics while valid
  projects continue reconciling

#### Scenario: Graceful shutdown
- **WHEN** the daemon receives a termination signal
- **THEN** it stops accepting new work, finishes persistence already in
  progress, closes listeners and SQLite cleanly, leaving active runs
  recoverable on restart
