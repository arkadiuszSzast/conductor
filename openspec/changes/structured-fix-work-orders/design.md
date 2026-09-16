## Context

See proposal.md. Findings already have feature-local F IDs, location, severity and new/fixed/dismissed/reopened states, but report() only stores narrative. Run completion, routing and the decision outbox already share a SQLite transaction. Feedback is a replace-on-rerun snapshot, not an accumulated history.

Read-only operator inspection: feature 4f047967-b6f7-4c11-ba49-d3f32a058c7f has merge succeeded and cleanup failed/escalated because the pipeline checkout is dirty. It is not done. No recovery or live mutation is authorized.

## Goals / Non-Goals

Goals: one accepted gate work order per review run; explicit decisions independent of severity; exact reviewed-head association; deterministic fix input; preserve existing recovery and P0 work.

Non-goals: individual reviewer ingestion, semantic duplicate discovery, automatic bug grading, external thread sync, analytics, gateway/stall changes, rollout execution.

## Decisions

- `agent.reviewHead` opts a gate into structured review and is a template resolving to a full Git SHA captured by the workflow. Successful reports require `review: {head, findings}` and approved/changes_requested verdict consistency. Failed reports remain failures. No prose parsing. The alternative of requiring every existing report to change would disrupt active workflows.
- Findings require explicit blocking boolean, severity, body, path/line, acceptanceTests (strings), status and optional existing F ID/resolution. New IDs are allocated by the store. Every previous finding owned by this job/step must be explicitly carried forward, fixed or dismissed; omission never silently resolves a blocker. Fixed/dismissed to active requires reopened plus a reason. Scope ownership is job/step, preventing parallel gates from changing each other's findings. Stable IDs, not text matching, perform reuse.
- Store adds blocking, acceptance tests, source job/run and reviewed head to existing findings. Run outputs retain the canonical full review/work order for immutable round history. Preparation is synchronous before atomic concludeRun; finding writes occur inside the existing completion transaction after the claim. Duplicates cannot mutate findings or route twice.
- `agent.fixFrom: job/step` and `agent.fixPrompt` select a deterministic fix body only when that exact feedback source contains an accepted persisted work order; `agent.qualityFrom: job/step` permits a scoped command diagnostic to select the same body. Source references are validated against workflow steps. No global latest-findings lookup and no previous implementer report injection. Initial pass uses the original full prompt unchanged. No blockers means an explicit no-blocking-work message, not another full implementation. Quality-only fixes include the persisted diagnostic; operator notes stay in their existing header and retry episode.
- Fix packs contain only active blocking entries, stable IDs, acceptance tests, locations and the previous reviewed head/source run. Source run and canonical payload are checked against stored outputs, not trusted merely because arbitrary feedback contains JSON. Human recovery notes are independent and never inferred from old feedback.
- Interpreter stays pure; engine owns reporting/prompt selection; store owns durability. No new scheduler or session ownership model. Same process has no await between review preparation and completion claim; SQLite transaction rolls back all state on error.

## Risks / Trade-offs

- Model-authored semantics remain fallible → validation guarantees shape, explicit disposition and provenance, not correctness. Never downgrade reachable bugs automatically.
- Review head is captured workflow evidence, not a daemon git checkout check → workflows must capture a clean immutable head and gate against it.
- Full carry-forward list can grow → suitable minimum for one gate; pagination/compaction is deferred.
- Existing rows have unknown blocking/provenance → leave nullable; only structured-owned rows participate in the strict carry-forward contract.
- Source workflow and runtime differ → keep operator YAML untouched; document a coordinated future rollout. Broad model/prompt changes and new turn/time budgets are excluded.

## Migration Plan

Add migration after recovery-note episodes. Upgrade daemon, CLI and runner plugin together; configure reviewHead plus fixFrom/fixPrompt/qualityFrom only on inactive, validated workflows. The updated runner conductor_report schema accepts an optional typed review object and forwards it unchanged through the API; HTTP and CLI remain alternatives. Older loaded MCP report tools lack the field and require a separately authorized runtime upgrade/reload. The daemon remains authoritative for configured-head freshness and verdict consistency (active blockers imply changes_requested; otherwise approved); the runner never silently derives or replaces the submitted verdict. Re-register only with explicit authorization after operator cleanup is independently resolved. Existing narrative workflows stay valid. Rollback requires a DB backup/newer compatible binary because migration ledgers reject unknown suffixes; simply removing opt-in fields disables the feature without deleting history.

## Source Manifest

Implemented coupled sources: packages/core/src/{types,parse,validate}.ts; server review validation/prompt helper, src/{engine,store,migrations,api}.ts; CLI src/{cli,client}.ts; runner-opencode src/{plugin,tools}.ts and the server's exported review types; package tests; docs/http-api.md and docs/workflow-reference.md. No bundled action manifest changes expected. Operator conductor.yaml remains dirty but unmodified by this increment; its P0 SHA/check wiring remains pending activation.

## Deferred Decisions

Multi-reviewer provenance beyond the accepting gate run, GitHub thread projection, semantic identity suggestions, structured fix-resolution reports, historical analytics and review-head revalidation at merge require separate increments.
