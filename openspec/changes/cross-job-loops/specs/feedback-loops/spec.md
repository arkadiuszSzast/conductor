## ADDED Requirements

### Requirement: Routes may re-run upstream jobs with a bounded loop
`onVerdict`, `onFail` and `onReject` routes MAY carry a `rerun` target
(`{ jobIds: string[], maxRounds: number }`) in addition to `goto`/`next`. A
route with a `rerun` SHALL NOT combine it with `goto` or `next` on the same
route. Each rerun SHALL increment a per-routing-step counter on the routing
job; when the counter exceeds `maxRounds` the interpreter SHALL escalate with
the loop summary instead of re-running.

#### Scenario: Consensus disagreement re-runs both architects
- **GIVEN** jobs `arch-a` and `arch-b` (no needs) and job `consensus` needing
  both, whose `check` step routes `disagree → rerun: [arch-a, arch-b]` with
  `maxRounds: 3`
- **WHEN** `consensus/check` reports verdict `disagree`
- **THEN** `arch-a`, `arch-b`, `consensus` and their downstream dependents are
  reset to `pending` (the routing job keeps its loop counter), `arch-a` and
  `arch-b` entry steps are dispatched, and the transition carries a feedback
  snapshot of the pre-reset outputs

#### Scenario: Non-converging consensus escalates
- **GIVEN** the same workflow and `maxRounds: 3`
- **WHEN** `disagree` is reported a fourth time
- **THEN** the interpreter escalates with the feedback/reason summary and no
  job is re-run

### Requirement: A rerun resets the transitive downstream closure
The reset set for a `rerun` SHALL be the target jobs plus every job that
transitively depends on them through `needs`, all returned to `pending`. The
routing job SHALL be reset like any other member, except that its `reruns`
counter is preserved so the loop stays bounded across rounds. Jobs outside
the closure SHALL be untouched.

#### Scenario: Downstream consumers recompute after a rerun
- **GIVEN** `arch-a → consensus → breakdown` and `arch-b → consensus`
- **WHEN** `consensus` re-runs `arch-a` and `arch-b`
- **THEN** `breakdown` is also reset to `pending` and does not re-run until the
  new consensus round terminates

### Requirement: Feedback from the previous round is available to re-run steps
A rerun transition SHALL carry `feedback: { jobs: { <jobId>: { <stepId>: output } }, message?: string }`
built from the pre-reset state: every step output of the rerun targets plus
the routing step's output, and the route reason as `message`. The prompt
template of a re-run step SHALL be able to reference these as dotted paths
(e.g. `{{ feedback.jobs.arch-a.design }}`, `{{ feedback.message }}`).

#### Scenario: Architect re-runs with the other architect's output
- **GIVEN** `arch-a/design` produced output `DESIGN_A` and `arch-b/design`
  produced `DESIGN_B` in round 1, and a rerun is triggered
- **WHEN** `arch-a/design` re-executes
- **THEN** its prompt context contains `feedback.jobs["arch-a"]["design"] =
  "DESIGN_A"`, `feedback.jobs["arch-b"]["design"] = "DESIGN_B"`, and
  `feedback.message` is the disagreement reason

### Requirement: Rerun targets are validated as strict ancestors
Validation SHALL reject a `rerun` whose target does not exist, is the routing
job itself, depends transitively on the routing job, or whose `maxRounds` is
less than 1. The needs graph SHALL remain acyclic; `rerun` is the only
backward edge and is always budgeted.
