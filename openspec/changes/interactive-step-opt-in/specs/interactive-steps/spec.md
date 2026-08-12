# Interactive steps

## MODIFIED Requirements

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
