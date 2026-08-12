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

A new answer operation SHALL deliver a human's notes to an asking run.
The engine SHALL forward the notes as a prompt into the run's existing
session, clear the pending question, and return the feature to `running`.
The answer SHALL be recorded on the run. Answering a run without a
pending question SHALL be rejected. If the session no longer exists at
answer time, the engine SHALL fail the run through the normal step-failed
path (retry/onFail semantics apply) rather than silently restarting.

#### Scenario: Answer flows into the live session

- **WHEN** a human answers an asking run with notes
- **THEN** the notes are sent as a prompt to the run's session, the
  feature returns to `running`, and the run's pending question is cleared

#### Scenario: Answer with a dead session fails the step honestly

- **WHEN** a human answers but the runner no longer has the session
- **THEN** the run concludes failed with a reason naming the lost session
  and the step's failure routing applies

#### Scenario: Answering a non-asking run is rejected

- **WHEN** an answer targets a run with no pending question
- **THEN** the operation is rejected with a conflict-class error

### Requirement: Waiting on an answer suspends idleness, not the TTL

While a run has a pending question, the engine SHALL NOT nudge or reap it
for idleness — waiting for a human is not being stuck. The run's overall
TTL SHALL continue to apply as the outer safety net; a reaped asking run
follows the existing reaped-run semantics.

#### Scenario: No nudges while asking

- **WHEN** a run has a pending question across many reconcile cycles
- **THEN** no nudge is sent and the run is not reaped for idleness

#### Scenario: TTL still bounds an abandoned question

- **WHEN** a run's pending question is never answered and the run's TTL
  elapses
- **THEN** the run is reaped exactly as an expired run is today

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

