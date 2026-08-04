# Tasks — cross-job-loops

## 1. IR surface

- [x] [core] Add `rerun: { jobIds, maxRounds }` route target to `onVerdict`, `onFail` and `onReject`; forbid mixing with `goto`/`next`.
- [x] [core] Add `JobRuntime.reruns` loop counter and `Transition.feedback` snapshot type; carry the check agent's `output` on the verdict event.

## 2. Pure interpreter

- [x] [core] Implement rerun routing: increment counter, bound by `maxRounds`, reset the transitive downstream closure (preserving the routing job's counter), dispatch target entry steps.
- [x] [core] Build the `feedback` snapshot from pre-reset outputs and the route reason.
- [x] [core] Wire `rerun` into `onVerdict`, `onFailed` (after retry budget exhaustion) and `onReject`.

## 3. Validation

- [x] [core] Reject `rerun` targets that are missing, self, or downstream of the routing job; reject `maxRounds < 1` and goto/next+rrerun mixes.

## 4. Tests

- [x] [test] Two-architect consensus loop: parallel start, disagreement rerun with feedback, closure reset, convergence to breakdown.
- [x] [test] Non-converging consensus escalates at `maxRounds`.
- [x] [test] `onFail` and `onReject` rerun variants.
- [x] [test] Validation cases for invalid rerun targets and budgets.
- [x] [test] Sequential review loop (existing) still passes unchanged.

## 5. Docs

- [x] [docs] Document the `rerun` route, closure-reset rule and `feedback.*` template namespace in `design.md`.
