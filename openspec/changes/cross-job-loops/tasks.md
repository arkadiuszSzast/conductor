# Tasks — cross-job-loops

## 1. Unify completion into outcomes

- [x] [core] Collapse `step.succeeded` and `step.verdict` into `step.completed { outcome?, outputs? }` with `DEFAULT_OUTCOME = "done"`.
- [x] [core] Replace agent-only `onVerdict` with `outcomes: { <name>: Route }` on every step kind; escalate on an unmapped declared outcome.
- [x] [core] Keep `step.failed` as the retry-budget path; document the outcome-vs-failure boundary in the IR.

## 2. Rerun routing

- [x] [core] Add `rerun: { stepIds? | jobIds?, maxRounds }` to `Route`; forbid mixing with `goto`/`next` and forbid `stepIds` + `jobIds` together.
- [x] [core] Implement step-level rerun (clear named steps, dispatch the first, job keeps running) as the replacement for `roundsWith`/`maxRounds`.
- [x] [core] Implement job-level rerun: transitive downstream closure reset preserving the routing job's `reruns` counter, dispatch target entry steps.
- [x] [core] Remove `roundsWith`/`maxRounds` and the `rounds`-based loop budget from the interpreter.
- [x] [core] Add `JobRuntime.reruns` counter and `Transition.feedback` snapshot built from pre-reset outputs plus the route reason.
- [x] [core] Wire rerun into `outcomes`, `onFail` (after retry exhaustion) and `onReject`.

## 3. Validation

- [x] [core] Validate rerun targets: existing steps in the routing job, existing strict-ancestor jobs, `maxRounds >= 1`, no goto/next mix, no stepIds/jobIds mix.
- [x] [core] Rework bounded-loop detection to count `rerun` edges instead of `roundsWith`.

## 4. Tests

- [x] [test] Two-architect consensus loop: parallel start, disagreement rerun with feedback, closure reset, convergence to breakdown.
- [x] [test] Non-converging consensus escalates at `maxRounds`.
- [x] [test] Review/fix loop expressed as `rerun.stepIds`.
- [x] [test] `onFail` and `onReject` rerun variants.
- [x] [test] Outcome routing: default advance with no `outcomes`, unmapped outcome escalates, stale completion is a noop.
- [x] [test] Validation cases for invalid rerun targets, budgets and route mixes.

## 5. Normalised IR

- [x] [core] Make collections total (`on`, `inputs`, `needs`, `outputs`, `outcomes`, `with`, `trigger.inputs`); keep optionality only where absent differs from empty.
- [x] [core] Model choices as discriminated unions: `Route`, `RerunTarget`, `InputDef`.
- [x] [core] Remove `then` (a second spelling of `goto`) and route everything through `outcomes`/`onFail`.
- [x] [core] Fold `human.approved`/`human.rejected` into `step.completed` outcomes; remove `onReject`.
- [x] [test] Add `packages/core/testing.ts` builders standing in for the parser; migrate all tests onto them.

## 6. Named step outputs (GHA mirror)

- [x] [core] Replace scalar `StepRuntime.output: string | null` with `outputs: Record<name, string>` (GHA-style `name=value`); `step.completed` carries `outputs?`.
- [x] [core] Nest `Feedback` one level: `jobs.<jobId>.<stepId>.<name>`, snapshotting named outputs.
- [x] [test] Cover multi-output steps and the nested feedback shape.

## 7. DAG failure semantics (from PR review)

- [x] [core] Mark a job `failed` when its step exhausts retries with no route, instead of escalating the whole feature.
- [x] [core] Propagate terminal status to a fixpoint so multi-hop skip chains (A→B→C) resolve in one pass.
- [x] [core] Make `if: failure()` skip when every dependency succeeded (previously it ran unconditionally).
- [x] [core] Escalate only when a failure leaves nothing runnable; finish `escalated` (not `done`) when any job failed.
- [x] [core] Fix `mergeJobPatches` dropping an explicit `currentStep: null` (`??` treats null as nullish).
- [x] [core] Require rerun job targets to be true ancestors, and reject duplicates.
- [x] [test] Cover job-level failure, multi-hop skip cascade, independent-branch survival, `always()`/`failure()`, transitive closure reset, sibling rerun rejection and `currentStep` clearing.

## 8. Docs

- [x] [docs] Document outcomes, the outcome-vs-failure boundary, `rerun` and the `feedback.*` namespace in `design.md`.
- [ ] [docs] Add the two-architect consensus workflow to the workflow reference once the YAML parser lands (blocked on `workflow-format` task 1.2).
