## 1. Limits

- [x] 1.1 [core][cli] Add and validate per-step limits and daemon idle grace; verify parser invalid-value tests.
- [x] 1.2 [server][test] Resolve limits consistently and gate idle recovery on grace plus debounce; verify inheritance, isolation, activity, failed nudges, restart, TTL, pause and question tests.

## 2. Runner

- [x] 2.1 [runner][test] Fix timeline fallback using SDK assistant/tool semantics; verify trailing users and superseded assistants without losing directory scoping.

## 3. Verification

- [x] 3.1 [docs] Update references and superseded planning decisions with operator tuning and reload requirements.
- [x] 3.2 [test][review] Run full typecheck, lint and tests; review diff, preserve pre-existing work and finish relevant elapsed-budget verification.
