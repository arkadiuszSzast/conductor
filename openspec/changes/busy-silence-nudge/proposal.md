# Busy-silence nudge — a "busy" session that has gone silent gets nudged, not trusted

## Why

The add-journal feature hit the same failure shape twice: a session whose
runtime status says `busy` while nothing is actually happening. First a
hung provider stream (17 min of dead air before the gateway cut it), then
a host reboot that left the recovered opencode session parked `busy` after
its stream was cut mid-turn. In both cases the engine's nudge path never
fired — it only covers `idle` sessions; `busy`/`retry` unconditionally
clear the idle counter and fall through to the TTL. Recovery required a
human to prompt the session by hand. Activity-aware TTL (resilient-agent-
runs) bounds the damage at the TTL scale (hours), but a cut stream is
detectable and fixable at the minutes scale: the session is reachable, a
prompt restarts it — exactly what the manual recovery proved.

## What Changes

- **Busy-silence nudge**: when a run's session reports `busy` (or `retry`)
  but the run's activity clock has been silent past a busy-silence
  threshold, the engine nudges the session anyway — same nudge budget,
  same prompt protocol as idle nudges. A nudge counts as activity, so the
  next busy-silence window starts fresh; a session that resumes working
  (logs flow again) never sees a second nudge.
- **Reap on exhausted budget**: a run still silent after the shared nudge
  budget is reaped through the existing path (timeout class, session
  abort) — well before the TTL.
- **New engine option** `busySilenceNudgeMs` (default 10 min) in the
  daemon config's `engine` block, alongside `runTtlMs`.

## Capabilities

### Modified Capabilities

- `run-liveness`: adds the busy-silence nudge requirement — silence while
  busy is suspect after a threshold, nudged on the shared budget, reaped
  when the budget is exhausted. (Delta against the run-liveness spec
  introduced by the unarchived `resilient-agent-runs` change.)

## Impact

- `packages/server`: engine reconcile (`reconcileAgentRun` busy branch),
  engine options, daemon config plumbing.
- No schema, store, runner, or workflow-format changes — the activity
  clock and nudge machinery already exist.
