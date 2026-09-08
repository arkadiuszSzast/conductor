# Resilient agent runs — activity-aware TTL, per-step TTL override, session abort on reap

## Why

The first real pipeline run (gloam-idle `add-journal`) exposed three gaps in
run lifecycle management. A productive implement step — 13 commits, logs
streaming, session continuously busy — was reaped at exactly 60 minutes
because the TTL counts wall-clock from dispatch, not from last observed
activity. The nudge path never fired (it only covers *idle* sessions; this
one was busy on a hung provider stream), so the reap arrived with zero
warnings. After the reap the session kept running as an orphan for another
~1.5 h, burning tokens against a run the engine had already closed — reaping
concludes the run in the DB but never tells the runner to stop the session.

## What Changes

- **Activity-aware TTL**: the reaper measures staleness from the run's last
  observed activity (log ingestion, status transitions) instead of run
  start. A run that streams logs is alive; a run that goes dark is stale and
  gets the existing nudge/reap treatment on the same budget as today.
- **Per-step TTL override**: agent steps gain an optional `ttlMs` field in
  the workflow YAML, overriding the engine-wide `runTtlMs` for that step
  (e.g. a long implement step gets 3 h while quick review steps keep the
  global default).
- **Session abort on reap**: `SessionClient` gains an `abort(sessionID)`
  operation; the engine calls it when reaping an agent run so the runner
  actually terminates the orphan session. Abort failures are logged, never
  block the reap.

## Capabilities

### New Capabilities

- `run-liveness`: how the engine decides an agent run is alive vs stale
  (activity clock), which TTL governs a given run (step override > engine
  default), and what happens to the underlying session when a run is
  reaped (abort, orphan prevention).

### Modified Capabilities

<!-- workflow-format and runner-protocol are still unarchived changes, not
     main specs; the step-level `ttlMs` schema addition and the runner
     `abort` operation are specified inside run-liveness to avoid editing
     other changes' deltas. -->

## Impact

- `packages/core`: workflow schema (`AgentStepDef.ttlMs`), parse +
  validation.
- `packages/server`: engine reconcile loop (activity clock, TTL selection,
  abort on reap), store (last-activity tracking on log ingestion),
  `SessionClient` port.
- `packages/runner-opencode`: implement `abort` against the opencode API.
- `docs/workflow-reference.md`: document `ttlMs` on agent steps.
