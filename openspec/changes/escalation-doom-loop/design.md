# Design — escalation-doom-loop

## Context

The interpreter's `onRerun` function emits `{ status: "escalated" }` when
the rerun budget is exhausted.  The feature patch carries no job patch,
so `jobs[routingJobId].currentStep` stays set and `jobs[routingJobId].status`
stays `"running"`.  On the next reconcile pass the reconciler sees a
running job with no active run, re-dispatched it, the step ran, exhausted
again, escalated again → doom loop.  The pause/abandon API responses were
overwritten within the same pass before they could be served.

## Fix

Add a job patch to the exhausted-budget escalation transition:
`{ currentStep: null, status: "failed" }` on the routing job.  The
reconcile loop's per-job iteration skips the job because `currentStep`
is `null`, so the step is never re-dispatched.  The `status: "failed"`
is consistent with the shape `onJobFailed` produces and is the correct
terminal state for a job whose rerun loop could not complete.

## Trade-offs

- The routing job is marked `failed` rather than `succeeded`.  This is
  correct: the job's rerun loop was exhausted and it could not produce
  a clean result.  Downstream dependents evaluate against a failed
  dependency, same as `onFail` routing, which is the right behaviour
  when escalation is the last resort.
- The `reruns` counter stays in the patch and is harmless because
  `currentStep === null` means reconcile never looks at the job.
