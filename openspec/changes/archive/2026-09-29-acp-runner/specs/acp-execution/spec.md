## Purpose

Enables explicitly configured local ACP agents to execute Conductor workflow steps without replacing native integrations or transferring workflow authority to the agent protocol.

## ADDED Requirements

### Requirement: ACP execution is explicitly selected and capability checked
Conductor SHALL support stable ACP protocol major 1 over a daemon-managed local process. Native execution SHALL remain the default when ACP is not configured. ACP selection SHALL preserve the exact project/worktree, role and requested model, reject paths outside configured canonical roots, and reject unsupported required protocol features or bindings before any task prompt. Role bindings SHALL select the exact advertised session mode through `modes.availableModes` (using `session/set_mode` when needed), or otherwise through a select config option whose category or id is `mode`, with `session/set_config_option` confirming the requested `currentValue` in its response before prompting. Neither an unadvertised mode nor an unconfirmed config selection SHALL permit a task prompt. There SHALL be no silent fallback after assignment.

#### Scenario: Unsupported protocol or binding
- **WHEN** the agent returns another protocol major or cannot honor the requested role/model
- **THEN** no task prompt is sent and an actionable incompatibility diagnostic is exposed without silently choosing a different model, mode or runner

#### Scenario: Worktree routing is exact
- **WHEN** a selected project's worktree is outside the configured allowed roots, including through a symlink
- **THEN** execution is refused instead of defaulting to another project

#### Scenario: Capacity is exhausted
- **WHEN** configured process slots are occupied before assignment
- **THEN** work remains durably resource-blocked without consuming executable retry attempts and is reconsidered when capacity returns

### Requirement: Prompt turns do not block orchestration or imply success
Conductor SHALL track prompt submission separately from turn completion, with independent bounded startup, write, turn and cancellation deadlines. A turn lasting longer than ten seconds SHALL NOT fail merely because of a short transport request deadline. Only an accepted explicit report SHALL establish workflow success; turn stop reasons SHALL NOT establish success.

#### Scenario: Long-running turn
- **WHEN** a prompt remains active for minutes within its configured budget
- **THEN** reporting, status, cancellation and reconciliation remain responsive and no overlapping prompt is sent

#### Scenario: End turn without report
- **WHEN** the agent returns end_turn without a report
- **THEN** the step remains incomplete, any allowed idle nudge is a distinct tracked operation, and timeout or nudge exhaustion does not automatically replay potentially executed work

### Requirement: ACP parents and notes are optional and non-inferential
Conductor SHALL NOT require ACP parent sessions or emulate a non-inferential note with a task prompt. Informational history SHALL remain available in Conductor's durable timeline. Native integrations SHALL retain their supported parent and note behavior.

#### Scenario: Agent lacks a note operation
- **WHEN** an informational note is recorded for ACP execution
- **THEN** the timeline records it without model inference and workflow progress is not blocked

### Requirement: Headless permissions fail closed
Permission requests SHALL be denied by default and granted only for explicitly allowed supported request classes using an offered one-time option. Unsupported client filesystem, terminal or interactive protocol requests SHALL be rejected. Pending decisions SHALL be bounded and cancelled during shutdown/cancellation. Documentation SHALL distinguish these controls from an OS sandbox.

#### Scenario: Missing or malformed permission context
- **WHEN** a request lacks required context, references another session, or offers no permitted decision
- **THEN** it is denied or cancelled without granting permanent access or waiting indefinitely

#### Scenario: Explicit one-time allowance
- **WHEN** a valid request matches an operator-configured allowance
- **THEN** only the corresponding offered one-time option is selected and a secret-safe decision record is retained

### Requirement: Processes receive bounded supervised cleanup
Conductor SHALL request cooperative cancellation and perform bounded process-group termination when necessary, recording both requested and observed results. Pause, abandonment and terminal reporting SHALL NOT wait indefinitely for a worker. Unverified process cleanup SHALL be exposed rather than reported as confirmed termination.

#### Scenario: Agent ignores cancellation during a tool
- **WHEN** the cooperative cancellation deadline expires
- **THEN** bounded termination is attempted, cleanup evidence is recorded, and uncertain external effects remain fenced despite process termination

#### Scenario: Cancellation while permission is pending
- **WHEN** cancellation arrives during a permission request
- **THEN** the permission is resolved cancelled or denied and cannot later grant execution

### Requirement: Worker environment and diagnostics are explicit
Worker processes SHALL receive only explicitly selected environment inputs and SHALL NOT receive Conductor administrator credentials. Logs SHALL exclude raw protocol frames, MCP credentials, tool arguments and thought content; diagnostics SHALL be bounded and sanitized before persistence. The integration SHALL NOT promise filesystem or network sandboxing from cwd or permission callbacks alone.

#### Scenario: Sensitive diagnostic output
- **WHEN** a worker emits credentials in a diagnostic or fragmented stream
- **THEN** no raw credential-bearing frame or environment is persisted, and only bounded sanitized diagnostics are exposed
