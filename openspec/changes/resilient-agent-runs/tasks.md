# Tasks — resilient-agent-runs

## 1. Activity clock (store + migration)

- [x] 1.1 [db] Migration: add `time_last_activity INTEGER` to `run`,
  backfill from `time_started`; verify with a migration test asserting
  the column exists and legacy rows carry `time_started`.
- [x] 1.2 [server] Store: initialise `time_last_activity` on run insert;
  add `touchRunActivity(runId, time)` and call it from `appendRunLog`,
  question set/answer, and nudge increment paths; expose the value on the
  active-run projection the engine reads. Verify with store unit tests
  covering each touch path.

## 2. Activity-aware TTL (engine)

- [x] 2.1 [server] `reconcileTtl` (and the no-runner TTL sweep) measure
  `now - max(time_last_activity, time_started)` minus the existing paused
  credit; reap reason names the silence duration ("no activity for N
  min"). Verify with engine tests: busy run with recent logs older than
  runTtlMs since start is NOT reaped; run silent past the budget IS
  reaped.
- [x] 2.2 [test] Restart scenario: recovered run whose persisted last
  activity already exceeds the budget is reaped on the first reconcile
  pass (no fresh window). Engine test with a pre-seeded store.

## 3. Per-step TTL override (core)

- [x] 3.1 [core] Add optional `ttlMs` to the agent step schema: parse,
  type, and validation (positive integer; rejected on non-agent steps)
  with load-error messages naming the step. Verify with parse/validate
  unit tests.
- [x] 3.2 [server] Engine resolves the governing TTL per run from the
  pinned workflow snapshot (step `ttlMs` ?? engine `runTtlMs`) in both
  TTL paths. Verify with an engine test where a step-level 3 h override
  outlives a 1 h engine default.
- [x] 3.3 [docs] Document `ttlMs` on agent steps in
  `docs/workflow-reference.md` (field, default, interaction with
  `engine.runTtlMs`).

## 4. Session abort on reap (port + runner + engine)

- [x] 4.1 [server] Add `abort(sessionID)` to `SessionClient` port with
  no-op-success semantics for missing/finished sessions; runner-transport
  gains the matching daemon→runner route. Verify with transport tests.
- [x] 4.2 [runner] opencode adapter implements `abort` via the SDK's
  session abort; missing session resolves as success. Verify with runner
  unit test against a stubbed client.
- [x] 4.3 [server] `Engine.reap()` aborts the run's session (when set)
  before concluding; abort failure is logged and non-blocking. Covers
  both TTL and nudge-budget reap paths. Verify with engine tests:
  abort called on reap; abort throwing still concludes the run reaped.

## 5. Integration proof

- [x] 5.1 [test] End-to-end engine test: agent run streams logs past the
  engine TTL without reap, then goes silent, gets reaped, session abort
  is invoked, and the step's retry budget dispatches a fresh attempt.
- [x] 5.2 [test] Full quality gate green: `bun run typecheck && bun test`
  from the repo root.
