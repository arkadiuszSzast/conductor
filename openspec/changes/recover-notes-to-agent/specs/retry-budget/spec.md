# retry-budget Specification (delta) — recover notes reach the recovered step's agent session

## ADDED Requirements

### Requirement: Operator recover notes are durable and reach the recovered step

`recover` SHALL persist the operator's non-empty `notes` string on the
recovered target's `recovery_dispatch` row in the same atomic
transaction as the DAG repair, SHALL stamp the value onto the `run`
row created when the recovered step actually dispatches, and SHALL
include it in the deterministic prompt header the agent session
receives for that step. The propagation SHALL be durable across a
daemon restart between `recoverStepTargets`'s commit and the dispatch
that follows: the `recovery_dispatch` outbox row is the single source
of truth and the engine re-reads it at dispatch time, not at recover
time. The `notes` field SHALL remain required and non-empty at the API
boundary (no silent regression of the existing validation), and the
engine SHALL treat a null notes value as "no recovery context" (a
normal first-attempt dispatch has no outbox row, so the engine MUST
NOT prepend a recovery block in that case). The propagation SHALL
apply automatically to every future `recover` call — no per-call
flag, no template change, no new expression root. Notes SHALL persist for
all automatic retries in the same target recovery episode, independently
of dispatch-intent handling or first-run consumption. Completion, terminal
routing, rerun/reset and replacement recovery SHALL end the old episode;
no unrelated target or later workflow visit SHALL inherit its notes.

#### Scenario: Automatic retry retains literal guidance across restart and resource waits

- **GIVEN** a recovered target has dispatched with operator notes and fails within its fresh retry budget
- **WHEN** an immediate or scheduled automatic retry dispatches, including after a database reopen or runner resource wait
- **THEN** its run snapshot and actual agent prompt contain the same complete literal notes, without requiring another recover call.

#### Scenario: Runner disappears after recovery run insertion

- **GIVEN** the recovered run is inserted but session prompting finds no live runner
- **WHEN** the resource wait subsequently dispatches another run
- **THEN** that run and prompt retain the episode notes.

#### Scenario: Successful recovery is followed by a later rerun

- **GIVEN** the recovered target succeeds and a later review routes back to that target
- **WHEN** the later workflow visit dispatches
- **THEN** neither the later run nor its prompt carries the old recovery guidance, while the original run retains its audit snapshot.

#### Scenario: A new recovery replaces guidance without crossing targets

- **GIVEN** an episode exhausts and another recovery is accepted for the selected target
- **WHEN** the new recovered run and its automatic retries dispatch
- **THEN** only the new notes appear, and other jobs or features with matching step IDs receive none of that guidance.

#### Scenario: Operator recovers a single failed step and the agent session receives the notes

- **GIVEN** an escalated feature with one recoverable failed agent
  step and the operator calls `POST /v1/features/:id/recover` with
  `notes: "runner is back, retry with the same prompt"`
- **WHEN** the engine dispatches the recovered step
- **THEN** the new `run` row carries `recover_notes = "runner is back, retry with the same prompt"`, the agent session's prompt is preceded by a `[conductor] This step was recovered by an operator. Operator notes:` block containing those notes verbatim, and the rendered template text follows the existing `[conductor] Job ... step ...` header unchanged.

#### Scenario: Recover notes survive a daemon restart between commit and dispatch

- **GIVEN** `recoverStepTargets` has committed the DAG repair with the
  notes stamped onto the `recovery_dispatch` row
- **WHEN** the daemon restarts before `executeAgent` runs for the
  recovered step
- **THEN** on the next reconcile pass the outbox-replay path reads
  the notes from `recovery_dispatch.notes` and stamps them onto the
  `run` row that the replay creates, and the agent session prompt
  header carries the same notes block — the operator's intent is
  durable across the crash window.

#### Scenario: A non-recovery dispatch has no recovery header

- **GIVEN** a feature's first-attempt dispatch for an agent step
  (no `recovery_dispatch` row exists for that target)
- **WHEN** `executeAgent` runs
- **THEN** the prompt header is exactly the pre-existing
  `[conductor] Job ... step ...` block — no `[conductor] This step was
  recovered by an operator.` block is prepended, and the new `run`
  row has `recover_notes = NULL`.

#### Scenario: Multi-target recover stamps notes on every recovered run

- **GIVEN** an escalated feature with three recoverable failed agent
  steps and the operator calls recover with `notes: "provider
  outage is over"` and `all: true`
- **WHEN** the engine dispatches every recovered step
- **THEN** each new `run` row carries
  `recover_notes = "provider outage is over"`, and every agent
  session prompt header for those three steps includes the recovery
  notes block with that same text — one operator note covers every
  selected target.

#### Scenario: Recover notes are required at the API boundary

- **WHEN** a client calls `POST /v1/features/:id/recover` with an
  empty or whitespace-only `notes` value
- **THEN** the API returns `400 invalid_request` with the message
  `"notes" (non-empty string) is required for recover` and no state
  changes — the existing validation surface is preserved exactly.
