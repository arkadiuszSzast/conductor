# run-liveness Specification (delta) — escalation-doom-loop fix

## MODIFIED Requirements

### Requirement: A rerun-budget-exhausted escalation clears the routing job runtime

When a step's rerun budget is exhausted and the interpreter emits
`escalate`, the feature patch MUST include a job patch for the routing
job that clears `currentStep` to `null` and sets `status` to `"failed"`.
This prevents the reconciler from re-dispatching the step after
escalation, closing the doom-loop that occurs when `currentStep` stays
set on an already-escalated feature.

#### Scenario: Budget-exhausted escalation clears the routing job

- **WHEN** a step completes with `changes_requested` and its rerun
  budget is already exhausted (`rounds > rerun.maxRounds`)
- **THEN** the returned transition patch carries
  `{ status: "escalated", jobs: { [routingJobId]: { currentStep: null, status: "failed" } } }`
  and the reconcile loop does not re-dispatch the step on subsequent
  passes

#### Scenario: Doom-loop is broken after escalation

- **WHEN** a feature is `escalated` and the routing job's `currentStep`
  is `null`
- **THEN** the reconcile loop's per-job iteration skips the job (the
  step is not dispatched again) and the feature stays `escalated`
  indefinitely until a human recovery action is taken
