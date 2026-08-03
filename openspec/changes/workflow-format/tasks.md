# Tasks — workflow-format

## 1. Define and parse the format

- [ ] [core] Define the versioned workflow IR for triggers, inputs, jobs, needs, conditions, outputs and four step kinds.
- [ ] [core] Implement strict source-mapped YAML parsing with duplicate-key/custom-tag/alias limits and actionable unknown-field errors.
- [ ] [core] Implement schema/type/reference validation, graph cycle diagnostics and bounded-loop checks.
- [ ] [test] Add golden valid/invalid workflow fixtures, including minimal linear, fan-out/fan-in, gates, findings loops and malformed YAML.

## 2. Pure graph interpreter

- [ ] [core] Generalise the pure interpreter from one current step to durable job/step state and a deterministic set of decisions.
- [ ] [core] Implement dependency readiness, terminal propagation, conditions, output availability and explicit bounded route loops.
- [ ] [core] Implement the safe expression parser/type checker/evaluator and `{{ }}` template integration without ambient capabilities.
- [ ] [test] Add table and property-based tests for graph determinism, fan-out/fan-in, skip propagation, stale events and cycle budgets.

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
- [ ] [docs] Publish workflow reference, JSON schema/editor integration, expression language, action authoring and migration guide.
- [ ] [review] Review the dialect cold against the GHA UX benchmark and run security review of YAML/expression/action inputs.
