# Tasks — multi-target-recovery

## 1. Engine

- [x] 1.1 [server] `Engine.recover()`: accept `targets` (list) and
  `all` alongside `target` (exactly one form; else `invalid_request`).
  Validate every named target against `recoveryCandidates` — any miss
  rejects wholesale (`staleTarget`, naming the misses). `all` resolves
  to the full candidate set. Pass the validated set to
  `recoverStepTargets` in one call.
- [x] 1.2 [server] `ambiguous` rejection: include `allowAll: true` and
  mention the recover-all form in the message.
- [x] 1.3 [server] `classifyThrownBoundary`: add runner-connection
  shapes (`unable to connect`, `connectionrefused`, `connection
  closed`, `connection error`) → `transient_transport`.

## 2. API

- [x] 2.1 [server] `POST /v1/features/:id/recover`: request schema
  gains `targets` (non-empty array of {jobId, stepId}) and `all`
  (boolean); reject combined forms; thread through to the engine.

## 3. CLI

- [x] 3.1 [cli] `recover`: `--all` flag and repeatable `--job/--step`
  pairs (positional pairing); mixing `--all` with `--job` is a usage
  error; print re-armed targets on success.

## 4. Web

- [x] 4.1 [web] Escalation panel: render `recoverableTargets` as a
  pre-checked checkbox list with one notes field and one submit sending
  `targets`; add a "Recover all" shortcut.

## 5. Tests

- [x] 5.1 [test] Multi-target recover re-arms every selected step in
  one transaction (single feature version bump, one idempotency key,
  all recovery-dispatch rows present); cascade-skipped jobs reset once.
- [x] 5.2 [test] Wholesale rejection: one stale target in a
  multi-target selection re-arms nothing; ambiguous rejection carries
  `allowAll`; `all` under a stale `expectedVersion` is rejected.
- [x] 5.3 [test] Back-compat: single `target` requests behave exactly
  as before (ambiguous, staleTarget, duplicate idempotency paths).
- [x] 5.4 [test] `classifyThrownBoundary("Unable to connect. Is the
  computer able to access the url?")` → `transient_transport`; prompt
  failure against a dead runner follows the transient budget.
- [x] 5.5 [test] Full gate green: `bun run typecheck && bun test`.

## 6. Docs

- [x] 6.1 [docs] Document multi-target recover (API request forms, CLI
  flags) and the runner-connection failure classification.
