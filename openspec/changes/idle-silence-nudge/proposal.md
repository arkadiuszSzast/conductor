## Why

Idle recovery must allow a real activity grace window rather than spending a run's budget on adjacent heartbeats. Workflow authors also need per-step patience, and a trailing user nudge must not hide an unfinished assistant/tool in the runner timeline.

## What Changes

- Add positive-integer agent idleSilenceNudgeMs, busySilenceNudgeMs and maxNudges overrides alongside ttlMs; inherit daemon settings then defaults.
- Default idle silence to 120000 ms; retain ten-minute busy silence. Require elapsed silence and cycle debounce before idle recovery or exhausted reap; TTL wins.
- Inspect the latest assistant and its tool parts rather than only the final message; completed later assistants supersede earlier unfinished ones.
- Preserve durable shared nudge counts, pause accounting, pending-question exemption and directory scoping.

## Capabilities

### New Capabilities
- `step-liveness`: per-step recovery limits, idle grace and conservative timeline fallback, extending the unarchived run-liveness work.

### Modified Capabilities

None.

## Impact

Core workflow parser/types, daemon tuning, engine, runner, tests and references. This extends workflow-as-data and operational resilience without changing confirmed architecture. Seed debounce and nudge/reap behavior are retained because they protect confirmation-of-effect; no seed format is introduced. No database migration or external configuration edits. Operator implementation tuning (2 min idle / 20 min busy / 3 nudges / 3 h TTL) is documented for later application, not deployed here.
