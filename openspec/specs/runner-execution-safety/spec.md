# runner-execution-safety Specification

## Purpose
Prevents uncertain runner effects from being automatically duplicated by preserving operation identity, execution ownership and explicit recovery requirements across process and daemon failures.

## Requirements

### Requirement: Attempt ownership and operation identity are durable
Conductor SHALL durably bind each new attempt to its selected transport before execution-capable writes. Create and prompt operations SHALL have distinct stable logical identities. Concurrent duplicate requests for the same operation SHALL NOT issue duplicate external writes; different payloads under one identity SHALL conflict. Transport selection changes SHALL NOT reroute existing attempts.

#### Scenario: Concurrent dispatch
- **WHEN** multiple reconciliation paths attempt the same step or operation
- **THEN** at most one attempt binding and one external write for that logical operation are made

#### Scenario: Configuration changes after dispatch
- **WHEN** a project's configured transport changes while an ACP run exists
- **THEN** the existing run remains bound to ACP and is not sent through the native runner

### Requirement: Unknown effects are fenced outside automatic failure routing
A potentially delivered create or prompt whose outcome cannot be established SHALL produce durable execution uncertainty and operator escalation, not ordinary failed-run retry. Fencing SHALL prevent automatic replay, fresh attempts, nudges, answer delivery and downstream execution for that target. Cancellation or process death SHALL NOT be treated as proof that prior effects did not occur.

#### Scenario: Lost create response
- **WHEN** a session may have been created but its response is lost
- **THEN** Conductor records uncertainty and does not create another session automatically

#### Scenario: Effect before lost prompt response
- **WHEN** a prompt may have caused external changes before the connection is lost
- **THEN** no retry budget, workflow failure branch or TTL policy automatically dispatches replacement work

#### Scenario: Proven no-write failure
- **WHEN** the adapter proves a request never entered the write boundary
- **THEN** bounded ordinary retry or resource waiting remains available without representing that failure as successful delivery

### Requirement: Restart does not establish live execution ownership
After a process or daemon restart, persisted session identifiers SHALL NOT imply a live worker or resumed execution. Unfinished potentially delivered ACP operations SHALL be fenced before reconciliation can dispatch work. Conversation loading or history replay SHALL NOT clear uncertainty or trigger prompt replay.

#### Scenario: Daemon restart with an unfinished turn
- **WHEN** the daemon starts with a previously submitted ACP turn and no committed authoritative report
- **THEN** it exposes uncertain execution, revokes the prior worker credential, and sends no replacement create or prompt

#### Scenario: Report committed before crash
- **WHEN** a report committed successfully before daemon failure
- **THEN** restart preserves the result and completes only pending durable engine decisions without repeating agent work

### Requirement: Unknown observation is distinct from idle or missing
An unavailable or ambiguous observation SHALL be represented conservatively and SHALL NOT trigger speculative nudges or missing-session failure. Time bounds SHALL lead to visible uncertainty/escalation for potentially executed ACP work, not unbounded invisible busy state or automatic retry.

#### Scenario: Silent or disconnected peer
- **WHEN** no trustworthy live turn observation is available
- **THEN** silence is not interpreted as idle, missing or safe-to-prompt and the configured safety deadline leads to an operator-visible fence

### Requirement: Recovery of uncertain execution is explicitly acknowledged
Recovery SHALL require operator notes, current version, an idempotency key, acknowledgment of uncertain effects and confirmed or operator-attested orphan cleanup. It SHALL retain the old uncertain run and audit evidence while creating a new attempt with new credentials. Plain resume SHALL NOT clear a fence.

#### Scenario: Unsafe recovery request
- **WHEN** an operator requests recovery without uncertainty acknowledgment or cleanup evidence
- **THEN** no new work is created and the response explains the missing prerequisite

#### Scenario: Acknowledged recovery is retried
- **WHEN** the same valid recovery request is submitted twice with the same key
- **THEN** exactly one new attempt is armed and the old operation is never resent

#### Scenario: Late old worker result
- **WHEN** a fenced or replaced worker submits a late result
- **THEN** it cannot modify the replacement run or overwrite the fenced disposition
