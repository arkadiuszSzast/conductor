## ADDED Requirements

### Requirement: ACP session output reaches the run log

The ACP transport SHALL write a run's session output to the run log as the
native runner does: `agent_message_chunk` text as `agent` lines, redacted
and bounded before buffering and coalesced per flush window of at most one
second; and exactly one `tool` line per `toolCallId`, whose text SHALL derive
only from the tool's declared kind — never from its title, raw input or raw
output. `agent_thought_chunk` content SHALL NOT be written. Buffered lines
SHALL be flushed when the turn completes and when the session is aborted.
A failing log write SHALL NOT affect the session, the turn or the run.

#### Scenario: Implement step shows what the agent is doing

- **WHEN** an ACP agent streams reply text and invokes an edit tool during a
  run
- **THEN** `GET /v1/runs/:id/logs` returns the coalesced reply as an `agent`
  line and `editing file` as a `tool` line

#### Scenario: Sensitive content stays out of the log

- **WHEN** a tool call's title names a file path and the agent emits thought
  chunks
- **THEN** neither the title nor the thought text appears in the run log
