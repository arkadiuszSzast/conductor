# interactive-steps Specification

## Purpose
TBD - created by archiving change interactive-agent-steps. Update Purpose after archive.
## Requirements
### Requirement: A running agent step can ask instead of concluding

The runner protocol SHALL accept an `ask` report for a running agent run
**only when the step is declared `interactive: true` in the workflow**: a
question text payload (typically carrying a `conductor-questions` block)
instead of an outcome. An `ask` SHALL NOT conclude the run or the step:
the run stays the step's active run and its session is preserved. The
feature SHALL enter `waiting_human` and the question SHALL be persisted
with the run so it survives a daemon restart. An `ask` against a run that
is not running SHALL be rejected the same way a stale report is.

An `ask` from a run whose step is NOT interactive SHALL be refused
without any state change: the run stays running, the feature status is
untouched, no question is persisted, and the response text instructs the
agent that the step is autonomous — it must decide on its own and report
an outcome. When the step no longer resolves in the workflow (changed
since dispatch), the ask SHALL be refused the same way.

#### Scenario: Ask parks the feature without concluding the run

- **WHEN** an agent run of an `interactive: true` step reports `ask` with
  a question
- **THEN** the run remains active with its session id, the feature status
  is `waiting_human`, and the question is readable from the run and the
  feature detail projections

#### Scenario: Ask survives a restart

- **WHEN** a run has asked and the daemon restarts
- **THEN** the feature is still `waiting_human`, the question is still
  available, and the run is not treated as orphaned by reconciliation

#### Scenario: Stale ask is rejected

- **WHEN** an `ask` arrives for a run that already concluded
- **THEN** it is rejected with the already-concluded response and no state
  changes

#### Scenario: Ask from an autonomous step is refused instructively

- **WHEN** an agent run of a step without `interactive: true` reports
  `ask`
- **THEN** no question is persisted, the run stays running, the feature
  status is unchanged, and the response tells the agent the step is
  autonomous and it must decide and report an outcome

### Requirement: Answers resume the same session

An answer operation SHALL durably accept a human's notes for an asking run before delivery. The engine SHALL forward the notes into the run's existing session and clear only the corresponding pending question after the runner's required confirmation. The answer SHALL remain recorded on the run's delivery history. Answering a run without a pending question, or with an already accepted open answer, SHALL be rejected.

For native execution, a confirmed missing session SHALL continue to fail the run through normal step-failed routing rather than silently restarting. For ACP execution, local write submission SHALL NOT count as confirmed delivery: the matching turn response SHALL be required, while a newer question or already-concluded run SHALL be preserved. Potentially delivered answers SHALL NOT be replayed on lease expiry, lost response or restart. Uncertain ACP ownership/delivery SHALL retain accepted notes, fence execution and escalate instead of failing into automatic retry. Delivery acceptance while paused SHALL remain durable without prompting until safely eligible.

#### Scenario: Answer flows into the live session
- **WHEN** a human answers an asking run and the runner confirms delivery
- **THEN** the notes are sent to the same session, the corresponding pending question is cleared, and the feature returns to running if no other human attention is required

#### Scenario: Answer with a dead session fails the step honestly
- **WHEN** a human answers but the native runner confirms its session no longer exists
- **THEN** the run concludes failed with a reason naming the lost session and the step's failure routing applies; lost ACP ownership instead follows the uncertainty barrier

#### Scenario: Answering a non-asking run is rejected
- **WHEN** an answer targets a run with no pending question
- **THEN** the operation is rejected with a conflict-class error

#### Scenario: Answer arrives before ACP asking turn ends
- **WHEN** a human answers while the turn which asked is still active
- **THEN** acceptance is durable but no overlapping prompt is sent; delivery waits for confirmed turn completion on the same live connection

#### Scenario: Lost ACP answer response
- **WHEN** an answer may have reached ACP but the response is lost, including across daemon restart
- **THEN** the delivery becomes visibly unknown, accepted notes remain available and neither answer replay nor automatic step retry occurs

#### Scenario: New question precedes answer confirmation
- **WHEN** question N+1 is recorded before delivery confirmation for question N
- **THEN** confirming N does not erase N+1 or its pending answer state

#### Scenario: Completion persisted before confirmation crash
- **WHEN** answer turn completion is durable but the daemon crashes before question confirmation
- **THEN** restart performs only eligible database confirmation and does not send the answer again or claim that the unfinished step has resumed execution

### Requirement: Waiting on an answer suspends idleness, not the TTL

While a run has a pending question, the engine SHALL NOT nudge or reap it for idleness. The run's TTL SHALL continue to bound unattended waiting. Native asking runs SHALL retain existing reaped-run semantics. An ACP run with potentially executed work and no authoritative report SHALL be fenced and escalated at that bound rather than entering automatic retry; pending or unknown answer deliveries SHALL not bypass this safety barrier.

#### Scenario: No nudges while asking
- **WHEN** a run has a pending question across many reconcile cycles
- **THEN** no nudge is sent and the run is not reaped for idleness

#### Scenario: TTL still bounds an abandoned question
- **WHEN** a native run's pending question is never answered and its TTL elapses
- **THEN** the run follows the existing expired-run reaping behavior; ACP execution follows the uncertainty barrier instead of automatic retry

#### Scenario: TTL bounds an ACP question without replay
- **WHEN** an ACP question or uncertain answer reaches its safety deadline
- **THEN** the run is visibly fenced/escalated and no replacement attempt or answer prompt is automatically issued

### Requirement: Asking runs surface on the answering surfaces

The feature detail projection SHALL carry the pending question of an
asking run. The web UI SHALL present the same answer form used for gate
prompts (options plus custom answer when a `conductor-questions` block
parses; plain notes otherwise) and submit through the answer operation.
The CLI SHALL print the pending question in feature status and provide an
answer command. The opencode runner plugin SHALL expose an ask tool so
agents can ask mid-step.

#### Scenario: Web UI answers an asking run

- **WHEN** a feature waits on an asking run whose question embeds a
  `conductor-questions` block
- **THEN** the web UI renders the option/custom-answer form and submitting
  sends the composed notes to the answer operation

#### Scenario: CLI answers an asking run

- **WHEN** `conductor answer <run-id> --notes "..."` targets an asking run
- **THEN** the answer is delivered and the command reports the feature's
  new status
