## MODIFIED Requirements

### Requirement: Reporting readiness precedes task inference
Conductor SHALL verify that the attempt's reporting surface is ready before sending the first task prompt. For an injected stdio bridge, that means it initialized and its tools were listed for the correct attempt. For a runtime reporting plugin, that means the server reports the plugin active for the session's location and the attempt's credential is bound to the session. Missing readiness SHALL fail closed within a bounded startup period. Readiness SHALL not be represented as proof of real model compatibility.

#### Scenario: MCP connection is delayed or ignored
- **WHEN** session creation succeeds but the reporting bridge never becomes ready
- **THEN** no task prompt is sent and an actionable reporting-readiness diagnostic is exposed

#### Scenario: Reporting plugin not loaded
- **WHEN** an opencode session is created for a location where the reporting plugin is not active
- **THEN** no task prompt is sent and an actionable reporting-readiness diagnostic is exposed

#### Scenario: Concurrent attempts use the same directory
- **WHEN** two attempts are prepared in the same allowed directory
- **THEN** their reporting bridge identities and credentials remain distinct and neither can report for the other

## ADDED Requirements

### Requirement: Session-bound credentials are not model-supplied
When the reporting surface is a runtime plugin, the attempt credential SHALL be bound to the session by the daemon at creation and resolved by the plugin from the calling session. A run identifier or credential supplied in tool arguments SHALL NOT widen or replace that scope. A tool call from a session with no bound credential SHALL be refused without contacting the run endpoint.

#### Scenario: Model passes another run id
- **WHEN** a worker calls conductor_report with a run id that differs from its session's bound attempt
- **THEN** the report is rejected and neither run changes

#### Scenario: Unbound interactive session
- **WHEN** a user's own session, not created by Conductor, calls conductor_report
- **THEN** the call is refused with an instructive message
