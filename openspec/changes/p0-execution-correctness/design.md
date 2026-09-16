## Context

See proposal.md. Audit confirms push executes `git push remote branch` then reads ambient HEAD. Await-checks consumes unbound name/state and succeeds on no checks after grace. Command execution already persists bounded/redacted actual reason and failure source but rerun snapshots only named outputs; global feedback.message contains the reason yet step-specific templates miss it. Completion and transition/outbox writes are atomic, but acknowledgment follows awaited recursive dispatch. Active uniqueness is a partial SQLite index per feature/job/step; it does not prevent replay after the target has completed.

## Goals / Non-Goals

Goals: exact evidence, fail-closed incomplete CI, durable step-specific repair feedback, evidence-backed stale dispatch correction.
Non-goals: production operations, finding work orders, automatic ruleset discovery, changes to retry policy or runner liveness, multi-daemon redesign.

## Decisions

- Resolve `refs/heads/<branch>^{commit}` before push; push `<sha>:refs/heads/<branch>` then configure the named branch upstream when requested. Reading after push races; pushing the mutable ref after pre-reading also races. Explicit local upstream configuration is needed because SHA refspec push cannot infer the local branch.
- Require `expected_sha` plus `required_checks` (array of names). This is workflow-owned policy, not a claim to discover all branch protection rules. Use `gh api` GET commit check-runs (latest, paginated/slurped) and combined commit status (paginated/slurped, validating SHA), bracketed by `gh pr view --json headRefOid`. Validate payload shapes; count check conclusions success/neutral/skipped as passing, statuses success only. Unknown states wait rather than pass. Query exact SHA so old green cannot qualify. Select only declared names, require every selected producer to pass. No optional empty-CI success path. Official gh docs verified through Context7; REST check-runs and combined-status schemas verified against GitHub documentation.
- Enrich a command-origin rerun transition's existing feedback in the engine before atomic conclusion. Store diagnostic in the routing step's feedback map, not run outputs, with the existing boundDiagnostic sanitizer. No schema change or unbounded historical scan. Templates explicitly opt into this step-specific diagnostic; do not automatically inject unrelated global feedback.
- Reproduce stale completion replay with controlled session/prompt barriers before changing dispatch. Minimal state guard at execution dispatch rejects a non-current or non-running target. Existing active-run guard and DB uniqueness continue to protect concurrent setup. This closes proven stale-target replay, not hypothetical same-target later-round ABA or multi-process ownership problems; document those limits rather than claim all reviewer duplication fixed.

## Risks / Trade-offs

- Explicit required names can drift from repository policy → document workflow responsibility; missing names time out safely.
- Check runs are scoped to the PR base repository and exact head commit; workflows only reporting synthetic merge-commit checks or fork-only checks may time out → do not falsely bless different SHAs.
- PR head can change after the final read → outputs include the validated SHA; merge must independently enforce commit identity. No atomic GitHub snapshot is claimed.
- Existing command outputs named diagnostic → diagnostic is reserved in failure feedback only; outputs stay unchanged.
- Same-step later-round replay cannot be distinguished by a current-step guard → defer generation-bound outbox ownership unless reproduced in this scope.

## Race investigation evidence

Deterministic regression `Engine: stale reviewer completion outbox` blocks the review prompt acknowledgment, reports review success independently, advances to publish, then reconciles while implement's outbox remains unhandled. Before the guard it produced two review runs (expected one); afterward the complete engine suite passes with one reviewer and the productive publish session untouched. Conclusion/transition atomicity is already correct and the active-target unique index already exists. The proven gap is replay eligibility after the old target completes, not simultaneous insertion or duplicate conclusion. No evidence ties this local reproduction to production R3 specifically; no production features or sessions were inspected. Same-target later-round ABA, stale notifications, and multi-daemon ownership remain outside this guard's guarantee.

## Migration Plan

No database migration, live action, restart, or deployment. Update local manifests and documented wiring; existing workflows adopting the changed action must supply SHA and required names. Preserve current branch and unrelated dirty changes. Rollback is source-level only, not a requested operation.
