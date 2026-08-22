## MODIFIED Requirements

### Requirement: Answers resume the same session

An answer operation SHALL durably accept a human's notes for an asking run before attempting delivery. The accepted answer SHALL survive a daemon restart and SHALL remain associated with the same run and session until Conductor confirms delivery or confirms that delivery cannot succeed. Concurrent or repeated answer requests SHALL accept at most one answer for a pending question.

After the runner confirms prompt delivery, Conductor SHALL clear the pending question, record the answer as delivered, and return the feature to `running` unless another gate or asking run still requires human attention. A daemon restart before confirmed delivery SHALL cause reconciliation to resume delivery without requiring the operator to answer again. If the session is confirmed absent or delivery terminally fails, the engine SHALL fail the run through the normal step-failed path so retry/onFail semantics apply; the accepted notes and delivery outcome SHALL remain auditable. Answering a run without a pending question or accepted pending delivery SHALL be rejected.

#### Scenario: Answer flows into the live session

- **WHEN** a human answers an asking run with notes and the existing session accepts the prompt
- **THEN** the notes are durably associated with the run, sent to that session, the feature returns to `running`, and the pending question is cleared

#### Scenario: Accepted answer survives a crash before delivery

- **WHEN** Conductor accepts an answer and the daemon stops before prompt delivery is confirmed
- **THEN** the accepted notes remain durable and reconciliation attempts delivery to the same run session after restart without another operator submission

#### Scenario: Concurrent answers accept one decision

- **WHEN** two answer operations race for the same pending question
- **THEN** exactly one set of notes is accepted for delivery and the other operation is rejected without replacing or adding another delivery

#### Scenario: Answer with a dead session fails the step honestly

- **WHEN** a human answer is accepted but the runner confirms that the run's session no longer exists
- **THEN** the run concludes failed with a reason naming the lost session, the accepted answer remains auditable, and the step's failure routing applies

#### Scenario: Answering a non-asking run is rejected

- **WHEN** an answer targets a run with neither a pending question nor an accepted pending delivery
- **THEN** the operation is rejected with a conflict-class error
