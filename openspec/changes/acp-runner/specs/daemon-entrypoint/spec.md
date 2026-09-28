## ADDED Requirements

### Requirement: Daemon configuration selects managed ACP execution explicitly
The daemon configuration SHALL accept an optional runners section defining explicit project routing, local ACP executable and argument vectors, allowed roots, environment selection, role bindings, concurrency, deadlines, permission policy and reporting bridge command. Omission SHALL preserve native execution. Unknown or unsafe configuration SHALL fail validation with the offending field named. No model gateway or host-specific executable SHALL be assumed.

#### Scenario: Existing native configuration
- **WHEN** an existing daemon configuration omits runners
- **THEN** native registration and execution remain available with no configuration migration

#### Scenario: Configured OpenCode execution
- **WHEN** an operator selects a configured OpenCode ACP profile for a project
- **THEN** the daemon can launch that executable with the exact worktree directory and run-scoped reporting bridge without requiring the native Conductor plugin

#### Scenario: Invalid profile or root
- **WHEN** configuration references an unknown profile, invalid deadline or relative executable/root
- **THEN** startup fails with a readable field-specific error before any worker is launched

### Requirement: Reporting is ready before ACP dispatch and remains available during cleanup
Daemon startup SHALL bind reporting before activating ACP work, and SHALL process prior execution uncertainty before new dispatch. Shutdown SHALL stop new dispatch, perform bounded worker cleanup and finish persistence before closing SQLite. The daemon SHALL NOT wait for an entire long-running turn before honoring shutdown.

#### Scenario: Startup recovery needs reporting
- **WHEN** restart recovery makes a new ACP assignment eligible
- **THEN** the reporting endpoint is already bound and prior uncertain ownership has been fenced before dispatch

#### Scenario: Shutdown during a turn
- **WHEN** a termination signal arrives during an ACP prompt
- **THEN** new work stops, bounded cleanup and durable disposition recording occur, and the database closes after those writes

### Requirement: CLI packages a run-scoped reporting entrypoint
The CLI SHALL provide conductor report-mcp as a stdio MCP entrypoint usable from both a source checkout and compiled distribution. It SHALL require injected run-scoped connection inputs, bypass ordinary administrator configuration discovery and emit only protocol data on stdout.

#### Scenario: Source and compiled bridge startup
- **WHEN** either supported distribution starts report-mcp with valid synthetic run credentials
- **THEN** an MCP client can list exactly the permitted worker tools without starting a daemon or reading administrator settings
