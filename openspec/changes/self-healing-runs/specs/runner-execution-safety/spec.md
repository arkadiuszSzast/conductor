## MODIFIED Requirements

### Requirement: Unknown effects are fenced outside automatic failure routing
A potentially delivered create or prompt whose outcome cannot be established SHALL produce durable execution uncertainty, not ordinary failed-run retry. Fencing SHALL prevent automatic replay, fresh attempts, nudges, answer delivery and downstream execution for that target, with one exception: self-healing MAY recover a fence classified `no_effect` or `replay_safe` (see `self-healing-runs`). Every other fence SHALL escalate to the operator.

- **Process death:** cancellation or process death alone SHALL NOT be treated as proof that prior effects did not occur.
- **Absence of a session:** proof of no effect requires that no session was ever bound and no prompt left the `prepared` phase.
- **Cleanup:** automatic recovery requires confirmed process termination.

#### Scenario: Lost create response
- **WHEN** a session may have been created but its response is lost
- **THEN** Conductor records uncertainty and does not create another session until the fence is classified and, if `no_effect` with confirmed termination, a healing attempt is scheduled with fresh credentials

#### Scenario: Effect before lost prompt response
- **WHEN** a prompt may have caused external changes before the connection is lost on a step not declared `replaySafe`
- **THEN** no retry budget, workflow failure branch, TTL policy or healing schedule automatically dispatches replacement work

#### Scenario: Proven no-write failure
- **WHEN** the adapter proves a request never entered the write boundary
- **THEN** bounded ordinary retry or resource waiting remains available without representing that failure as successful delivery

### Requirement: Unknown observation is distinct from idle or missing
An unavailable or ambiguous observation SHALL be represented conservatively and SHALL NOT trigger speculative nudges or missing-session failure. Time bounds SHALL lead to visible uncertainty for potentially executed ACP work, never to an unbounded invisible busy state. Automatic retry after such a bound SHALL occur only through self-healing of a `no_effect` or `replay_safe` fence.

#### Scenario: Silent or disconnected peer
- **WHEN** no trustworthy live turn observation is available
- **THEN** silence is not interpreted as idle, missing or safe-to-prompt and the configured safety deadline leads to an operator-visible fence

#### Scenario: Turn deadline on a replay-safe review
- **WHEN** a `replaySafe` review step exceeds its turn deadline and its process is confirmed terminated
- **THEN** the run is fenced visibly and a healing attempt is scheduled instead of escalating
