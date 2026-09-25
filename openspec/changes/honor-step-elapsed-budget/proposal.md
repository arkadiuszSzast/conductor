# Honor a step's own `retry.maxElapsed`

## Why

A step's `retry` block can declare `maxElapsed` (an ISO-8601 duration), but the
engine ignores it: when a retry budget is evaluated, the elapsed deadline is
always the failure class's default (`PATIENT_BUDGET.maxElapsedMs` = 10 min for
`timeout`) — `docs/workflow-reference.md` already records this as a known gap
("not yet YAML-overridable").

The effect is that long-running steps are structurally un-retryable. A real
`impl/implement` run on a large change worked for 3 h 26 m before being reaped
as idle-without-report; because the run had already outlived the 10-minute
class deadline, the engine escalated immediately instead of scheduling a retry
— even though the step's `maxAttempts` was 2. The author's declared
`maxElapsed` never took effect.

## What changes

- `retry.maxElapsed`, when present on a step, becomes that step's elapsed retry
  deadline for the whole retry episode. When absent, the failure class default
  still governs (no behaviour change for existing workflows).
- A pure ISO-8601 duration parser turns the validated string into milliseconds.
- The override applies both when a failure is first classified and when a
  recovery resets the episode, so an operator recovery of a long step gets the
  same (larger) budget rather than the class default.

## Impact

- `packages/core` — new parser in `scheduling.ts`, exported; `types.ts` doc.
- `packages/server` — `engine.ts` failure disposition and recovery episode
  reset.
- Docs — `docs/workflow-reference.md` stops calling the field "planned".
- Tests — parser unit tests and an engine retry-budget test proving the step
  deadline overrides the class default in both directions.
