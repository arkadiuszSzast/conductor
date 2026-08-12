# Tasks — interactive agent steps

## 1. Store: pending questions are durable

- [ ] 1.1 [db] Migration: `pending_question TEXT`, `asked_at INTEGER` on
      `run`; surface both on `RunSummary`
- [ ] 1.2 [server] Store methods: `setRunQuestion(runId, question)` /
      `clearRunQuestion(runId)` — each flips the owning feature's status
      (`waiting_human` / `running`) in the same transaction and writes a
      transition-log entry; reject when the run is not running
- [ ] 1.3 [test] Store tests: set/clear round-trip, feature status flips,
      transition-log entries, stale-run rejection, restart visibility

## 2. Engine: ask, answer, reconcile

- [ ] 2.1 [server] `Engine.report` accepts the `ask` shape: persists the
      question via `setRunQuestion`, notifies (`notify?`), does NOT
      conclude the run
- [ ] 2.2 [server] `Engine.answer(runId, notes)`: validate pending
      question, forward composed prompt into the run's session, clear the
      question, reset idle counter; session-lost → conclude failed
      (`session_lost`) through `concludeAndDispatch`
- [ ] 2.3 [server] `reconcileAgentRun`: skip nudge/idle-reap while
      `pending_question` is set; TTL reap unchanged; restart recovery
      leaves asking runs alone
- [ ] 2.4 [test] Engine tests: ask parks feature + preserves run/session;
      answer resumes (prompt content asserted) and returns feature to
      running; answer on dead session fails the step with routing; ask on
      concluded run rejected; no nudges while asking; TTL reap still
      fires; restart keeps the question

## 3. API: report shape + answer endpoint + projections

- [ ] 3.1 [server] `POST /v1/runs/:id/report` accepts exclusive
      `{ ask }`; `POST /v1/runs/:id/answer` `{ notes }` with
      `no_pending_question` / `session_lost` conflict codes
- [ ] 3.2 [server] Projections: `pendingQuestion`/`askedAt` on run
      summaries and the feature detail's active run
- [ ] 3.3 [test] API tests: ask via report, answer happy path, conflict
      codes, question visible in detail, auth on the new endpoint

## 4. Surfaces: plugin, web, CLI

- [ ] 4.1 [runner] `conductor_ask` tool in the opencode plugin ("only when
      a human decision is required to proceed"; payload documents the
      `conductor-questions` block convention)
- [ ] 4.2 [web] Gate panel: when the waiting surface is an asking run,
      render the question through the existing parse/compose form and
      submit to the answer endpoint (approve/reject hidden)
- [ ] 4.3 [cli] `conductor answer <run-id> --notes <text|->`; pending
      question printed by `status <feature-id>`
- [ ] 4.4 [test] Web panel test (asking-run form, submit path); CLI answer
      + status tests

## 5. Docs

- [ ] 5.1 [docs] Runner protocol: the ask report and answer flow;
      concepts: asking-run lifecycle vs human gates; workflow-reference
      note under agent steps (no YAML change; any agent step can ask)
