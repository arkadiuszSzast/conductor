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

- [ ] [server] Define action manifest, typed input/output and JSON execution protocols plus configured registry resolution.
- [ ] [server] Record resolved action version/content digest and enforce declared capability policy at dispatch.
- [ ] [server] Extract every seed builtin into a bundled `@v1` action; remove action-name dispatch from the engine.
- [ ] [test] Port built-in behavioural/idempotency tests to action contract tests and add unavailable/version/capability diagnostics.

## 4. Triggers and durable execution

- [ ] [db] Add additive job/step graph state, trigger event/idempotency and schedule tables/indexes.
- [ ] [server] Implement transactional ready-job claims and concurrency-safe reconcile dispatch.
- [ ] [server] Implement manual trigger inputs and durable cron schedule with explicit missed-fire policy.
- [ ] [test] Exercise duplicate delivery, daemon restart at fire time, concurrent claims and graph recovery.

## 5. Migration and documentation

- [ ] [cli] Implement legacy JSON → v1 YAML conversion with builtin→action mapping and no guessed semantics.
- [ ] [test] Build event-level parity fixtures running representative legacy pipelines through old and new interpreters.
- [x] [docs] Publish workflow reference (`docs/workflow-reference.md`), expression language (`docs/expressions.md`) and execution concepts (`docs/concepts.md`); planned-but-unimplemented behaviour is marked in place.
- [ ] [docs] Publish JSON schema/editor integration, action authoring and migration guide (blocked on parser and registry).
- [ ] [review] Review the dialect cold against the GHA UX benchmark and run security review of YAML/expression/action inputs.
