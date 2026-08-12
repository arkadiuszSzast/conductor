# Design — interactive agent steps

## Context

See proposal.md — Why. Load-bearing current state:

- Runs conclude through `Engine.report` → `concludeAndDispatch` →
  `store.concludeRun` (transactional, decision outbox). A run is
  `running|succeeded|failed|reaped`; only concluding paths exist.
- The reconciler nudges idle agent runs after `nudgeIdleCycles` and reaps
  at `runTtlMs` (`reconcileAgentRun`). Idle counters live in memory.
- `waiting_human` exists at feature/step level for `human` steps; the
  interpreter routes `wait_human` decisions for them. `resolveGates`
  answers *gates* — a different lifecycle than a running step.
- The runner transport already delivers mid-session prompts
  (`prompt(sessionID, text)`) — the nudge path uses it.
- The opencode plugin exposes `conductor_report`; tools are the natural
  place for `conductor_ask`.
- Feature status drives the board and the gate panel; the gate panel
  renders `conductor-questions` forms (gate-prompts change).

## Goals / Non-Goals

**Goals**
- One session spans ask → answer → continuation; zero context loss.
- Crash-safe: a pending question is as durable as a run row.
- The interpreter stays untouched — no new workflow-visible semantics.

**Non-Goals**
- Multi-question threads with structured per-question state (the payload
  is one text blob per ask; an agent can ask again after an answer).
- Answer routing into expressions (`steps.*.outputs`): answers feed the
  session, not the workflow data plane. The step's eventual report remains
  the step's output.
- Changing `human` gate semantics or the gate-prompts surfaces beyond
  reusing the form component.

## Decisions

### D1 — Ask is run-level state, not an interpreter event

The interpreter models *step* transitions; an ask does not move the step
(it stays `running` with the same active run). Ask therefore lives on the
run row: `pending_question TEXT` + `asked_at INTEGER` (one migration).
Feature-level `waiting_human` is set directly by the engine (same
mechanism `resolveGates` uses in reverse) without a step patch, and
cleared on answer. Reconciliation recognises "active run with
pending_question" as a legitimate waiting state.

*Alternative*: a new interpreter event + step status `asking`. Rejected —
it forks every consumer of step status (projections, board, validation)
for what is operationally a run attribute, and would demand workflow
awareness of a runner capability.

### D2 — Feature status while asking is `waiting_human`

The board/gate surfaces already treat `waiting_human` as "a human must
act"; an asking run is exactly that. Disambiguation (gate vs asking run)
is by data: gates carry `prompt` on a waiting step, asking runs carry a
pending question on the active run. The gate panel picks whichever is
present (gates win when both are, which cannot happen within one job —
one current step at a time).

### D3 — `ask` rides the report channel; answers get their own endpoint

`POST /v1/runs/:id/report` gains `{ ask: string }` as a third exclusive
shape (vs `outcome`/`verdict`) — same auth, same stale-run guard, and the
plugin's tool surface stays symmetric (`conductor_report` /
`conductor_ask` both hit the runs API). Answering is
`POST /v1/runs/:id/answer` `{ notes }`: it is a human-side operation with
different semantics (forwards into the session, clears the question) and
gets its own conflict codes (`no_pending_question`, `session_lost`).

### D4 — Answer forwards through the existing prompt transport

The engine composes the answer prompt ("The human answered your
questions:\n<notes>\nContinue the task; report when done.") and sends it
via `sessions.prompt`. Success clears `pending_question`, sets the feature
back to `running`, resets the run's idle counter. Failure (session gone,
runner down) concludes the run failed via the standard
`concludeAndDispatch` path with reason `session_lost` — honest failure
into retry/onFail rather than a zombie wait.

### D5 — Idleness is suspended, TTL is not

`reconcileAgentRun` skips nudge/reap-for-idleness while
`pending_question` is set (waiting on a human is not stuck), but the
`runTtlMs` reap still applies as the outer bound — an abandoned question
eventually fails the step exactly like an abandoned run today. No new
timeout knob in this change (design keeps the surface minimal; a
per-step answer timeout can come later if real usage wants it).

### D6 — Projections reuse the question as text; the form is client-side

Feature detail carries `pendingQuestion` on the active run summary; the
web gate panel feeds it through the same `parseGateQuestions` +
`composeAnswerNotes` pipeline as gate prompts, submitting to the answer
endpoint instead of approve. CLI prints the question in `status` and adds
`conductor answer <run-id> --notes` (mirrors `report`'s flag handling,
including `--notes -` for stdin if present there).

## Risks / Trade-offs

- **Feature-status flips without interpreter transitions**: `waiting_human
  ↔ running` on ask/answer bypasses `interpret`. Contained by doing both
  through one store method with a transition-log entry, so the timeline
  stays honest.
- **A second ask after an answer** is legal by construction (the run is
  running again); each ask overwrites `pending_question`. Documented.
- **Concurrent gate + asking run across parallel jobs**: both want the
  gate panel. Same pre-existing multi-gate limitation noted on PR #34;
  the panel shows one surface and the CLI can address runs precisely.
- **Plugin tool discipline**: an agent could ask instead of finishing.
  The ask tool description constrains use ("only when a human decision is
  required to proceed"), and TTL bounds the damage.

## Migration Plan

One additive migration (`pending_question`, `asked_at` on `run`). No
workflow format change, no API breakage (new endpoint + new optional
report field). Rollback: revert; stray pending questions are inert.

## Open Questions

None.
