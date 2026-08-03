## ADDED Requirements

### Requirement: Runners implement a small versioned contract
A runner SHALL implement protocol-version negotiation, capability
registration/heartbeat and the session operations create, prompt, status,
note and cancel. The contract SHALL NOT expose the workflow interpreter,
SQLite store, graph state or action registry.

#### Scenario: Compatible runner registers
- **WHEN** a runner registers a supported protocol version, runtime identity
  and capabilities
- **THEN** the daemon records it as available and may assign matching agent
  steps

#### Scenario: Incompatible protocol is rejected
- **WHEN** a runner supports no protocol version overlapping the daemon
- **THEN** registration is rejected with both supported ranges and no work is
  assigned

### Requirement: Capabilities are negotiated before assignment
A runner SHALL declare supported runtime, project-directory routing, parent
sessions, model/variant selection, tool-surface injection, notes and
cancellation. A step SHALL be assigned only to a runner satisfying all of its
required capabilities.

#### Scenario: Required tool surface unavailable
- **WHEN** an agent step requires `conductor_report` in a worktree and a runner
  cannot inject that tool there
- **THEN** the step remains unassigned with an actionable availability reason;
  it is not dispatched hoping the tool exists

#### Scenario: Opaque model binding
- **WHEN** a role specifies a runner-specific model identifier
- **THEN** the daemon carries the value unchanged and the selected runner
  validates/resolves it

### Requirement: Runner errors use stable failure classes
Runner operations SHALL return a stable class (`transient_upstream`,
`transient_transport`, `capacity`, `invalid_request`, `session_missing`,
`cancelled`, `internal`) plus human diagnostics. The engine SHALL make retry
policy decisions from the class, not parse message text.

#### Scenario: Provider outage is classified
- **WHEN** the runtime reports a retryable upstream 5xx/provider outage
- **THEN** the runner returns `transient_upstream` with retry hints and the
  daemon applies patient retry policy
