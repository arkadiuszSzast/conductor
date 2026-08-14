## Purpose

Defines the small versioned and runtime-neutral contract through which Conductor discovers runner capabilities and controls disposable agent sessions.

## ADDED Requirements

### Requirement: Runners implement a small versioned contract
A runner SHALL implement protocol-version negotiation, capability registration/heartbeat and the session operations create, prompt, status, note and cancel. The contract SHALL NOT expose the workflow interpreter, SQLite store, graph state or action registry.

#### Scenario: Compatible runner registers
- **WHEN** a runner registers a supported protocol version, stable runtime identity and capabilities
- **THEN** the daemon records it as leased available and may assign matching agent steps

#### Scenario: Incompatible protocol is rejected
- **WHEN** a runner supports no protocol version overlapping the daemon
- **THEN** registration is rejected with both supported ranges and no work is assigned

### Requirement: Capabilities are negotiated before assignment
A runner SHALL declare supported runtime, project-directory routing, parent sessions, model/variant selection, tool-surface injection, notes and cancellation. A step SHALL be assigned only to a leased runner satisfying all required capabilities.

#### Scenario: Required tool surface unavailable
- **WHEN** an agent step requires `conductor_report` in a worktree and no leased runner can inject that tool there
- **THEN** the step remains durably unassigned with an actionable compatibility reason and no run attempt is failed

#### Scenario: Opaque model binding
- **WHEN** a role specifies a runner-specific model identifier
- **THEN** the daemon carries the value unchanged and the selected runner validates or resolves it

### Requirement: Runner errors use the shared failure model
Runner operations SHALL return a stable executable failure class plus bounded human diagnostics and optional retry hint. The engine SHALL apply the generic policy from `retry-policy` and SHALL NOT parse message text. Absence of any compatible runner SHALL be represented as resource unavailability rather than an operation failure.

#### Scenario: Provider outage is classified
- **WHEN** the runtime reports a retryable upstream provider outage after accepting an assignment
- **THEN** the runner returns `transient_upstream` with retry hints and the daemon applies patient retry policy

#### Scenario: No compatible runner exists
- **WHEN** assignment selection finds no runner with a live lease and required capabilities
- **THEN** no runner operation is attempted and Conductor records a compatible-runner resource wait
