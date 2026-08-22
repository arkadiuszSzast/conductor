## 1. Failure model and lifecycle invariants

- [x] 1.1 [core] Define stable v1 failure envelopes, resource-unavailability reasons and finite normalized retry/resource-wait policies with per-class overrides.
- [x] 1.2 [core] Add pure lifecycle decisions for retry, resource wait, pause-aware resume and targeted recover without replaying workflow start.
- [x] 1.3 [core] Enforce that a non-terminal feature has a durable progress anchor and that terminal failed DAGs escalate.
- [x] 1.4 [test] Add exhaustive interpreter, classification and invalid-policy tests proving routing never parses human diagnostics.

## 2. Pure scheduling and durable state

- [x] 2.1 [core] Implement overflow-safe backoff, bounded jitter, retry-hint clamping, elapsed-budget and pause-time calculations with injected clock/random.
- [x] 2.2 [db] Add additive failure metadata, retry/resource-wait episode/history, pause accounting and due-work indexes.
- [x] 2.3 [db][server] Atomically persist attempt conclusion plus schedule, claim due retry/wait work and enforce one active attempt per target.
- [x] 2.4 [test][db] Cover crash boundaries, restart before/after due time, resource-wait persistence, clock skew and concurrent claim races.

## 3. Engine recovery and pause barrier

- [x] 3.1 [server] Map command, action, workflow-registry, runner and internal engine failures into the shared envelope; catch thrown execution-boundary failures. (Done: command exits, action failures, thrown prompt/action boundaries and reaps all carry classified envelopes; non-zero-backoff retries persist as durable retry_episode rows the reconciler claims when due.)
- [x] 3.2 [server] Enter resource wait before creating a run when required infrastructure is unavailable and auto-dispatch when it returns.
- [x] 3.3 [server] Implement finite resource observation, deadline escalation and early wake-up from availability changes.
- [x] 3.4 [server] Make pause block dispatch, due-work claims, action observation, nudge/reap and downstream outbox effects while preserving late conclusions.
- [x] 3.5 [server] Detect and repair or escalate stranded active features during reconciliation, including legacy all-terminal `running` records.
- [x] 3.6 [test] Simulate absent runner at submission, runner return, prolonged outage, daemon restart, pause/report races and deterministic immediate failure.

## 4. Operator recovery and visibility

- [x] 4.1 [server] Add status/version-guarded recover API with target, required note, idempotency key and finite default/override budget. (Done: expectedVersion optimistic guard [updatedAt] rejects stale recovers with 409 stale_version; idempotencyKey recorded atomically with the recovery transition dedupes retried deliveries; wired through API, web client/UI and CLI flags.)
- [x] 4.2 [server] Project authoritative activity, active runs, block/failure cause, retry/wait budget, next timestamp, recoverability and allowed commands.
- [x] 4.3 [cli] Add recover command and display active/waiting/blocked/escalated state with budget and diagnostics.
- [x] 4.4 [web] Show whether agents are active, waiting for retry/resource, paused or stopped; add direct Recover control for recoverable escalations.
- [x] 4.5 [test] Add API/CLI/UI contract tests for stale recovery rejection, idempotency, visibility and no false `running` indication.
- [x] 4.6 [server][cli][web] Derive recovery choices from the current durable failed/blocked frontier, accept an explicit job/step target, and reject omitted ambiguous or stale targets without fallback.
- [x] 4.7 [test] Cover historical deadline-exhausted waits, superseded failed runs, cross-kind history ordering, and parallel current failures so recovery never silently chooses the wrong target.

## 5. Migration, operations and review

- [x] 5.1 [server][db] Normalize legacy inconsistent active features safely on reconciliation without replaying completed work.
- [x] 5.2 [docs] Document taxonomy, default policies, blocked/retry/recover semantics, pause barrier and operator runbook. (Done: `docs/concepts.md` "Retries, failure classes and recovery", "Resume vs. recover" and "Operator runbook" sections; `docs/http-api.md` "Activity projection" and "Recovering an escalated feature"; `docs/workflow-reference.md` `steps[*].retry` notes the elapsed axis is class-default only, not yet YAML-overridable. Fixed a real engine gap found while writing this: the elapsed retry budget was persisted/displayed but never enforced — `packages/server/src/engine.ts`'s `scheduleDurableRetries` now calls `checkRetryBudget` before scheduling, and the reconciler's due-episode claim re-checks it defensively; both route through a new `step.budget_exhausted` pipeline event that reaches the same terminal route as an attempts-exhausted failure.)
- [x] 5.3 [review] Review retry storms, clock and pause accounting, claim atomicity, secret-safe diagnostics and cross-change ownership with runner-protocol.
- [x] 5.4 [fix] Run full tests, typecheck, lint and build; resolve all regressions before dogfooding no-runner recovery.
