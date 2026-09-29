# run-scoped-reporting Specification

## Purpose
Provides portable worker report, question and own-status tools with attempt-scoped authorization while retaining the existing Conductor engine as the only authority over outcomes and gates.

## Requirements

### Requirement: Reporting tools are scoped to one attempt
The injected MCP surface SHALL expose only conductor_report, conductor_ask and conductor_status for the assigned run. It SHALL NOT expose administrator operations or cross-run information. All requests SHALL authenticate through a high-entropy attempt-specific credential whose persisted form is a hash, not plaintext. Request-supplied identifiers SHALL NOT override credential scope.

#### Scenario: Worker attempts another run or admin action
- **WHEN** a scoped credential is presented for another run, approval, recovery, registration or other administrator operation
- **THEN** access is rejected without reading or mutating the target

#### Scenario: Administrator API is unauthenticated
- **WHEN** an operator enables ACP with an unauthenticated control API
- **THEN** configuration is rejected rather than claiming effective worker least privilege

### Requirement: Existing report and question authority is reused
MCP report and ask SHALL use the existing engine outcome, verdict, structured review, finding lifecycle and interactive-step validation. Ask SHALL not conclude a run. The bridge SHALL not persist a parallel outcome ledger or infer success from transport completion.

#### Scenario: Structured review through MCP
- **WHEN** the worker reports review data
- **THEN** the same reviewed-head and finding lifecycle checks apply as for ordinary HTTP reporting

#### Scenario: Autonomous step asks
- **WHEN** a non-interactive step invokes conductor_ask
- **THEN** it receives the existing instructive refusal and no question or success is recorded

### Requirement: Credentials are revoked and duplicate reports are harmless
Credentials SHALL be invalidated on fencing, replacement, abandonment, expiry and ownership loss. Terminal report acceptance SHALL atomically prevent further worker mutation. A duplicate report after normal conclusion SHALL receive the stable already-concluded disposition without duplicate workflow progression; other revoked credentials SHALL be unauthorized. Verification SHALL be rechecked at mutation time.

#### Scenario: Report acknowledgment is lost
- **WHEN** a report commits but its acknowledgment is lost and the worker repeats it
- **THEN** the result remains committed exactly once and the duplicate receives an explicit already-concluded response

#### Scenario: Token is revoked during a request
- **WHEN** a token is revoked after request parsing begins but before mutation commits
- **THEN** the request cannot change engine state

#### Scenario: Duplicate question request
- **WHEN** the same question invocation is redelivered after a lost acknowledgment
- **THEN** it does not create a new question generation, replace an accepted answer or overwrite a newer question

### Requirement: Reporting readiness precedes task inference
Conductor SHALL verify that the injected stdio bridge initialized and its tools were listed for the correct attempt before sending the first task prompt. Missing readiness SHALL fail closed within a bounded startup period. Readiness SHALL not be represented as proof of real model compatibility.

#### Scenario: MCP connection is delayed or ignored
- **WHEN** session creation succeeds but the reporting bridge never becomes ready
- **THEN** no task prompt is sent and an actionable reporting-readiness diagnostic is exposed

#### Scenario: Concurrent attempts use the same directory
- **WHEN** two attempts are prepared in the same allowed directory
- **THEN** their reporting bridge identities and credentials remain distinct and neither can report for the other

### Requirement: The reporting bridge is usable without administrator configuration
The packaged stdio entrypoint SHALL operate from injected run endpoint and credential inputs only, without reading the normal CLI administrator configuration, starting a daemon or logging secrets. Own-status responses SHALL contain only the assigned run's minimal status and permitted diagnostic fields.

#### Scenario: Standalone bridge invocation
- **WHEN** the runtime launches the configured reporting bridge
- **THEN** it speaks MCP on stdout, sends authenticated requests to the configured run endpoint and requires no administrator token
