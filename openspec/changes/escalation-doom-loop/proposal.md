# Escalation doom loop — the budget-exhausted rerun doesn't clear the job runtime

## Why

After 3 PR-review rounds, the `pr_review_gate/gate` step completed with
`changes_requested` one more time; `onRerun` saw the rerun budget
exhausted and emitted an `escalate` decision with patch
`{ status: "escalated" }`.  That patch carries no job patch —
`jobs.pr_review_gate.currentStep` stayed `"gate"` and
`jobs.pr_review_gate.status` stayed `"running"`.  The reconciler saw a
running job with no active run, re-dispatched it, the gate ran again,
exhausted again, escalated again → doom loop, 528+ runs, ~3 hours of
opus burn.  Pause and abandon could not stop it because the reconciler
overrode them ("escalated but has active run — transitioning to running")
within the same pass before the API response was served.

## What Changes

- `onRerun` budget-exhausted path now emits a job patch that clears
  `currentStep` to `null` and sets the routing job's `status` to
  `"failed"` — the same terminal shape `onJobFailed` produces.
- The feature patch stays `{ status: "escalated" }`; no new terminal
  state, no schema change.

## Impact

- `packages/core/src/interpret.ts`: `onRerun` exhausted branch only.

## Risks / Trade-offs

- The routing job is marked `failed` (not `succeeded`), which is correct:
  it could not complete its rerun loop.  This also means downstream
  `needs:` dependencies evaluate against a failed dependency — same as
  `onFail` routing or `onJobFailed`, which is the right behaviour when
  escalation is the last resort.
- No interaction with the `reruns` counter — it stays in the patch and
  is harmless because `currentStep === null` means reconcile never looks
  at the job.
