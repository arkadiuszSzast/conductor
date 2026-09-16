# Tasks — busy-silence-nudge

## 1. Engine

- [ ] 1.1 [server] Add `busySilenceNudgeMs` to `EngineOptions` (default
  `DEFAULT_BUSY_SILENCE_NUDGE_MS = 600_000`) and plumb it from the daemon
  config's `engine` block (validated positive integer, same pattern as
  `runTtlMs`).
- [ ] 1.2 [server] `reconcileAgentRun` busy/retry branch: compute silence
  from `timeLastActivity` (paused credit included, same formula as
  `reconcileTtl`); past the threshold → nudge via the existing prompt +
  `incrementNudges` when budget remains, else reap via `reap()` (timeout
  class, session abort). Under the threshold → fall through to
  `reconcileTtl` unchanged.

## 2. Tests

- [ ] 2.1 [test] Busy session silent past the threshold is nudged; the
  nudge counts as activity (no second nudge until silence re-accumulates);
  a busy session with recent log appends is never nudged.
- [ ] 2.2 [test] Budget-exhausted busy-silent run is reaped with a
  timeout envelope and session abort, and the step's retry budget
  re-dispatches — well before `runTtlMs`.
- [ ] 2.3 [test] Waiting-for-answer runs (pending question) are exempt
  from busy-silence nudging; a step-level `ttlMs` below the threshold
  reaps on TTL first.
- [ ] 2.4 [test] Full gate green: `bun run typecheck && bun test`.

## 3. Docs

- [ ] 3.1 [docs] Document `engine.busySilenceNudgeMs` in the daemon
  configuration reference next to `runTtlMs`.
