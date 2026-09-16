# Tasks — escalation-doom-loop

## 1. Fix

- [x] 1.1 [core] `onRerun` budget-exhausted path: emit a job patch
  `{ currentStep: null, status: "failed" }` for the routing job, so the
  reconciler never re-dispatches the step after escalation.

## 2. Tests

- [x] 2.1 [test] A rerun-budget-exhausted `step.completed` produces an
  `escalate` decision whose feature patch carries a job patch with
  `currentStep: null` and `status: "failed"` on the routing job.
- [x] 2.2 [test] Full gate green: `bun run typecheck && bun test`.

## 3. Docs

- [x] 3.1 [docs] Add a note under the `rerun.maxRounds` section in the
  workflow-format reference: "When the budget is exhausted, the routing
  job's `currentStep` is cleared and its status set to `failed` so the
  reconciler does not re-dispatch the step after escalation."
