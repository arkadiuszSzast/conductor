## 1. Commit evidence

- [x] [server][test] 1.1 Pin pushed branch SHA and preserve upstream semantics; verify checkout/movement/error regressions in actions tests.
- [x] [server][test] 1.2 Bind check gate to expected SHA and declared required names with strict payload handling; verify old/empty/incomplete/pending/failure/skipped/head-movement/pagination cases.

## 2. Durable execution

- [x] [server][test] 2.1 Persist command failure diagnostic in step-specific rerun feedback without changing outputs; verify actual prompt and SQLite reopen/restart regressions.
- [x] [review][server][test] 2.2 Reproduce stale reviewer outbox replay before patching, add minimal proven guard and regression, and document remaining unsupported race claims.

## 3. Integration verification

- [x] [docs][test] 3.1 Update action manifests and documented SHA/required-check/diagnostic wiring; verify reference/manifest validation and exact spec alignment.
- [x] [review][test] 3.2 Run targeted tests, full typecheck, lint, test including mounted tests, build, and strict OpenSpec validation; record exact outcomes and deferred work while preserving dirty baseline and branch.

## Validation record

- `bun test packages/server/actions.test.ts packages/server/action-registry.test.ts packages/server/engine.test.ts`: 198 pass, 0 fail, 803 assertions.
- `bun run typecheck`: pass (root and web).
- `bun run lint`: pass (root and web).
- `bun run test`: 1621 pass, 51 skip, 0 fail across 73 files; mounted phase separately 51 pass, 0 fail across 4 files.
- `bun run build`: pass (typecheck and Vite production build).
- `openspec validate p0-execution-correctness --strict`: pass.
- `git diff --check`: pass.
- Stale reviewer regression first failed deterministically with 2 review runs instead of 1, then passed after state-valid dispatch guard. See design.md for exact interleaving and remaining limits.
- Git and GitHub action tests use fake process responses; no real push or live GitHub checks were executed. Official interfaces were verified from documentation, not production PR531.
- Branch remains `feat/recover-notes-to-agent`; pre-existing dirty work retained. No commit, push, PR, merge, live deploy/restart/recover, or productive-session termination performed.
- Follow-ups: structured finding work orders; investigate generation-bound same-target outbox replay and multi-daemon ownership only with reproductions; repository policy discovery and merge-time SHA enforcement are not implemented here.
