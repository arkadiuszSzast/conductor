## 1. Structured reporting

- [x] [core][test] 1.1 Add opt-in review and fix fields with parser/template/source validation; verify valid and invalid workflow tests.
- [x] [server][db][test] 1.2 Validate structured review schema and stable lifecycle, persist findings atomically with completion and canonical round outputs; verify rejection, ID reuse, scope, rollback and duplicate regressions.
- [x] [server][cli][test] 1.3 Expose structured reports over HTTP and CLI JSON file input; verify wire validation and plain report compatibility.

- [x] [runner][test] 1.4 Expose optional structured review through the actual plugin tool schema and typed transport; exercise hub/callback/API integration, head freshness, verdict consistency, rejection and plain compatibility.

## 2. Fix execution

- [x] [server][test] 2.1 Select concise fix prompt from accepted scoped feedback, preserving initial prompt and recovery notes; verify blockers/no blockers/quality/round isolation and provenance rejection.

## 3. Integration

- [x] [docs][review] 3.1 Document schema, workflow wiring, source manifest and operator rollout risks; review diff for preserved dirty work and no live mutations.
- [x] [test][review] 3.2 Run full typecheck, lint, tests including mounted phase and strict OpenSpec validation; record exact scope, outcomes and deferred work.

## Runner capability completion validation

- Actual plugin `conductor_report` now uses an exported tool factory with strict nested review/finding schemas and optional typed `ReviewReport` transport. No new workflow opt-in, alternate prose ingestion or verdict rewriting. Server head/ownership/lifecycle checks remain authoritative.
- Five runner integration regressions exercise the production tool descriptor's schema and execute handler through ApiClient/API with real daemon/store and fake opencode sessions behind hub/callback transport. They cover canonical persistence, duplicate rejection, stale configured head, contradictory severity-independent verdict, invalid acceptance tests/path/ownership, required structured payload, strict unknown-field/primitive rejection, ordinary reports and failed gates.
- Targeted runner/server-review/core-review/CLI: 187 pass, 0 fail across 4 files. Full `bun run test`: 1646 pass, 51 skip, 0 fail across 75 files, then mounted phase 51 pass, 0 fail across 4 files.
- `bun run typecheck`, `bun run lint`, strict OpenSpec validation and `git diff --check`: pass. Initial typecheck caught a readonly test expectation mismatch; corrected using `satisfies ReviewReport` and reran checks.
- Read-only live API inspection confirms feature 4f047967-b6f7-4c11-ba49-d3f32a058c7f remains escalated: merge/squash_merge succeeded; cleanup/remove_worktree succeeded; cleanup/update_main failed; no active run. Operator checkout still has dirty conductor.yaml. Source workflow validator passes; no recovery or operator mutation performed.
- Source capability is complete, not deployed: the current session's already-loaded MCP schema still lacks review. Runtime upgrade/reload, daemon/schema/client coupling and operator activation remain separately authorized deferred operations. Prior dirty changes and reviewer prose workflows preserved; no commit/push/restart/deploy.

## Coordinated review validation (2026-09-15)

- Preserved the complete incoming dirty tree in stash 067d62b8acca0bd6181da5aa2be5eebd9cf3493a; retained commits 90f4bab and 9116101 through a new branch stacked on PR55, not duplicated.
- Full typecheck, lint, build, binary build and strict validation of structured-fix-work-orders, p0-execution-correctness, runner-liveness and recover-notes-to-agent pass. Full test script: 1647 pass, 51 skip, 0 fail; separate mounted phase: 51 pass, 0 fail.
- Added a small isolated real Git repository/SQLite engine integration flow covering accepted F1, concise fix prompt, retry exhaustion, recovery notes inherited by automatic retry, stable-ID resolution, approved report, exact-head PR Gate handler and terminal cleanup. Sessions and GitHub responses are stand-ins; local Git and command execution are real. No production feature, model calls or test PR created. An initial missing async completion wait and incorrect manifest test type were corrected before rerunning all gates.
- Operator edits preserved in stash a7cfb993d17ed2bcf3f5410eb09d54adb2bc68ef and a separate workflow review worktree. Verified PR531 merged and remove_worktree succeeded; recovered only cleanup/update_main under the existing runtime definition. Feature 4f047967-b6f7-4c11-ba49-d3f32a058c7f is now done and operator main is clean at f52e26d5d62f1c150672e39d3be1f2e43ddd4993.
- Consistent SQLite backup before recovery: /tmp/opencode/conductor-before-cleanup-20260915.db; integrity_check returned ok. No daemon or OpenCode restart performed.
- Separate operator branch opts only the internal gate into structured review, scopes concise fixes, preserves models, and pins post_pr checks to fix_push SHA plus PR Gate. Source validator passes; live GitHub PR531 check runs confirm the exact PR Gate context.
- Coordinated deployment remains pending: live daemon reports 20 migrations (not structured-findings migration 0021); this caller's loaded conductor_report schema lacks review, and direct live OpenCode tool enumeration returned HTTP 401. Source tool-schema integration passes but is not proof of loaded runtime readiness. Do not activate the new workflow until runner refresh and actual runtime schema verification succeed.

## Previous implementation validation record

- Full `bun run typecheck` and `bun run lint`: pass, including web.
- Full `bun run test`: 1641 pass, 51 skip, 0 fail across 75 files; separate mounted phase 51 pass, 0 fail across 4 files. 20 new tests relative to supplied P0 baseline.
- Targeted core/server/CLI suite: 278 pass, 0 fail across 4 files.
- Strict OpenSpec validation and git diff whitespace check: pass.
- Read-only source operator workflow/action-manifest/SHA/diagnostic validator: pass; no actions executed.
- Tests cover first implementation, blocker-only fix prompt, accepted no-blockers, quality diagnostic plus recovery notes, later snapshot isolation, forged provenance, reopen fixed/dismissed IDs, scope rejection, invalid/contradictory schemas, duplicate reports, SQLite reopen and transactional rollback.
- No commit, push, PR, merge, recover, registration, restart or deployment. Branch remains feat/recover-notes-to-agent. Pre-existing P0/recovery/liveness work and dirty operator YAML preserved.
- Scope is accepting-gate lifecycle plus fix dispatch only, not complete reviewer ingestion or thread synchronization. Historical canonical orders live in run outputs; current findings are updated in place. Acceptance tests are descriptive locations/criteria, not commands automatically executed by the engine.
- Deferred: per-reviewer provenance/deduplication, fix-resolution reports, GitHub projection, historical analytics, gateway/stall changes, merge-time head enforcement, operator activation. No model/prompt overhaul, new time/turn cap, or automatic severity downgrades.
- Operator status inspection found merge succeeded but cleanup escalated because its checkout is dirty; feature 4f047967-b6f7-4c11-ba49-d3f32a058c7f is not done. Left unchanged.
