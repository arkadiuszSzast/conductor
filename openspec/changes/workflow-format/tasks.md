# Tasks — workflow-format

## 1. Define and parse the format

- [x] [core] Define the versioned workflow IR for triggers, inputs, jobs, needs, conditions, outputs and four step kinds.
- [x] [core] Implement strict source-mapped YAML parsing with duplicate-key/custom-tag/alias limits and actionable unknown-field errors.
- [x] [core] Implement schema/type/reference validation, graph cycle diagnostics and bounded-loop checks.
- [x] [test] Add golden valid/invalid workflow fixtures, including minimal linear, fan-out/fan-in, gates, findings loops and malformed YAML.
- [x] [test] Parse and validate the two-architect consensus workflow from `docs/workflow-reference.md` as a golden fixture (moved from `cross-job-loops`).

## 2. Pure graph interpreter

- [x] [core] Generalise the pure interpreter from one current step to durable job/step state and a deterministic set of decisions.
- [x] [core] Implement dependency readiness, terminal propagation (success and failure), `always()`/`failure()` conditions with multi-hop skip cascade, and explicit bounded route loops.
- [x] [core] Implement job output availability: resolve `JobDef.outputs` against step outputs once a job succeeds and expose them to dependents. Blocked on the expression evaluator below — `JobDef.outputs`/`JobRuntime.outputs` are declared but not yet computed.
- [x] [core] Implement the safe expression parser/type checker/evaluator and `{{ }}` template integration without ambient capabilities.
- [x] [test] Add table and property-based tests for graph determinism, fan-out/fan-in, skip propagation, stale events and cycle budgets. (Expression + reference-validation tables added in this change; graph determinism/fan-out/fan-in/skip/stale coverage already landed with the interpreter.)

## 3. Local action registry

- [x] [core] Define ActionManifest IR, typed input/output, capability vocabulary, manifest YAML parser and validation, pure registry resolution with content digest and `with:` input checking, and JSON execution protocol envelope types.
- [x] [server] Wire configured registry search paths (bundled + local), load manifests from disk, and expose the populated `ActionRegistry` to the daemon pre-start check and the reconciler.
- [x] [server] Record resolved action version/content digest and enforce declared capability policy at dispatch.
- [x] [server] Extract every seed builtin into a bundled `@v1` action (`git/worktree`, `git/worktree-remove`, `git/push`, `github/pr-create`, `github/await-checks`, `github/pr-merge`); remove action-name dispatch from the engine. `findings.sync`/`findings.check`/`threads.check_resolved` are not extracted here — they await the findings write-path change (not yet shipped) and stay out of scope until that lands.
- [x] [core][server] Implement the durable pending `ActionResult` protocol: a polling action returns a durable pending result with a next-observation policy instead of holding its run open for the whole window; `github/await-checks@v1` migrates onto it (satisfies the spec's "Polling action reports pending" scenario).
- [x] [test] Add action registry contract tests: versioned resolution with deterministic digest, missing action/version diagnostics naming paths, incompatible `with:` inputs, unknown capabilities, safe IO variants; golden manifest fixtures (valid/invalid) in `packages/core/fixtures/actions/`.

## 4. Triggers and durable execution

- [ ] [db] Add additive job/step graph state, trigger event/idempotency and schedule tables/indexes.
- [ ] [server] Implement transactional ready-job claims and concurrency-safe reconcile dispatch.
- [ ] [server] Implement manual trigger inputs and durable cron schedule with explicit missed-fire policy.
- [ ] [test] Exercise duplicate delivery, daemon restart at fire time, concurrent claims and graph recovery.

## 5. Migration and documentation

- [x] [cli] ~~Implement legacy JSON → v1 YAML conversion with builtin→action mapping and no guessed semantics.~~ (void — greenfield pivot, see standalone-daemon-extraction: seed format deleted)
- [x] [test] ~~Build event-level parity fixtures running representative legacy pipelines through old and new interpreters.~~ (void — greenfield pivot, see standalone-daemon-extraction: seed format deleted)
- [x] [docs] Publish workflow reference (`docs/workflow-reference.md`), expression language (`docs/expressions.md`) and execution concepts (`docs/concepts.md`); planned-but-unimplemented behaviour is marked in place.
- [ ] [docs] Publish JSON schema/editor integration, action authoring and migration guide (blocked on parser and registry).
- [ ] [review] Review the dialect cold against the GHA UX benchmark and run security review of YAML/expression/action inputs.
