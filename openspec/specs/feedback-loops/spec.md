# feedback-loops Specification

## Purpose
Defines how workflows express bounded agent loops: steps report
workflow-defined outcomes, routes re-run earlier steps or upstream jobs
with a hard round budget, re-run steps receive a feedback snapshot of the
previous round, and job failure is terminal for the job while the DAG
reacts around it.

## Requirements
### Requirement: Step completion reports a workflow-defined outcome
A step that completes its work SHALL report `step.completed` with an optional
`outcome` name (default `"done"`) and optional named `outputs`
(`Record<name, value>`, GHA-style). A step MAY declare an
`outcomes` map from outcome name to route. Outcome names SHALL be
workflow-defined strings to which the engine attaches no built-in meaning. A
step with no `outcomes` map SHALL advance along its path regardless of the
reported outcome. A reported outcome that is not present in a declared
`outcomes` map SHALL escalate rather than fall through.

#### Scenario: Consensus check routes on its own vocabulary
- **GIVEN** an agent step declaring `outcomes: { agree: {next: true}, disagree: {rerun: ...} }`
- **WHEN** it completes with outcome `agree`
- **THEN** the workflow advances to the next step, and no rerun occurs

#### Scenario: Classifier routes to one of several branches
- **GIVEN** a step declaring outcomes `cat`, `dog` and `bird`, each with a
  distinct `goto`
- **WHEN** it completes with outcome `dog`
- **THEN** the interpreter dispatches the step named by the `dog` route

#### Scenario: Unmapped outcome escalates
- **WHEN** a step with a declared `outcomes` map completes with an outcome not
  present in that map
- **THEN** the feature escalates naming the step and the unmapped outcome

#### Scenario: Plain step advances without declaring outcomes
- **WHEN** a step with no `outcomes` map completes
- **THEN** the workflow advances to the next step in the job's path

### Requirement: Failure is distinct from outcome
`step.failed` SHALL mean the step could not complete its work and SHALL
consume the step's retry budget before taking `onFail`. A completion outcome
SHALL NOT consume the retry budget and SHALL NOT re-execute the reporting step
in place. An evaluation that completes and reports an unfavourable result
SHALL be modelled as an outcome, not a failure.

#### Scenario: Disagreement does not retry the adjudicator
- **WHEN** a consensus step completes with outcome `disagree`
- **THEN** the adjudicator step is not re-executed in place and its attempt
  counter is unchanged

#### Scenario: Crash retries the same step
- **WHEN** a step reports `step.failed` and its retry budget is not exhausted
- **THEN** the same step is dispatched again and its attempt counter increments

### Requirement: Routes may re-run earlier steps or upstream jobs with a bounded loop
Any route (`outcomes[...]`, `onFail`, `onReject`) MAY carry
`rerun: { stepIds?, jobIds?, maxRounds }` instead of `goto`/`next`. A route
SHALL NOT combine `rerun` with `goto` or `next`, and a `rerun` SHALL NOT mix
`stepIds` with `jobIds`. Each rerun SHALL increment a per-routing-step counter
on the routing job; when the counter exceeds `maxRounds` the interpreter SHALL
escalate with the loop summary instead of re-running.

#### Scenario: Review loop re-runs a fixer step in the same job
- **GIVEN** a review step routing `changes_requested → rerun: { stepIds: [fix], maxRounds: 3 }`
- **WHEN** it completes with outcome `changes_requested`
- **THEN** the `fix` step is cleared and dispatched, and the routing step's
  rerun counter increments

#### Scenario: Consensus disagreement re-runs both architects
- **GIVEN** jobs `arch-a` and `arch-b` (no needs) and job `consensus` needing
  both, whose `check` step routes `disagree → rerun: { jobIds: [arch-a, arch-b], maxRounds: 3 }`
- **WHEN** `consensus/check` completes with outcome `disagree`
- **THEN** `arch-a`, `arch-b`, `consensus` and their downstream dependents are
  reset to `pending` (the routing job keeps its loop counter), `arch-a` and
  `arch-b` entry steps are dispatched, and the transition carries a feedback
  snapshot of the pre-reset outputs

#### Scenario: Non-converging loop escalates
- **GIVEN** the same workflow and `maxRounds: 3`
- **WHEN** `disagree` is reported a fourth time
- **THEN** the interpreter escalates with the loop summary and no job is re-run

### Requirement: A job rerun resets the transitive downstream closure
The reset set for a job-level `rerun` SHALL be the target jobs plus every job
that transitively depends on them through `needs`, all returned to `pending`.
The routing job SHALL be reset like any other member, except that its `reruns`
counter is preserved so the loop stays bounded across rounds. Jobs outside the
closure SHALL be untouched.

#### Scenario: Downstream consumers recompute after a rerun
- **GIVEN** `arch-a → consensus → breakdown` and `arch-b → consensus`
- **WHEN** `consensus` re-runs `arch-a` and `arch-b`
- **THEN** `breakdown` is also reset to `pending` and does not re-run until the
  new consensus round terminates

### Requirement: Feedback from the previous round is available to re-run steps
A rerun transition SHALL carry
`feedback: { jobs: { <jobId>: { <stepId>: { <name>: value } } }, message }`
built from the pre-reset state: the named step outputs of the rerun targets
plus the routing step's outputs, with the route reason as `message`. Prompt
templates of re-run steps SHALL be able to reference these as dotted paths.
A step publishes multiple named outputs (GHA-style `name=value`); a step with
no outputs contributes nothing to the snapshot.

#### Scenario: Architect re-runs with the other architect's output
- **GIVEN** `arch-a/design` produced output `report: DESIGN_A` and
  `arch-b/design` produced `report: DESIGN_B`, and a rerun is triggered
- **WHEN** `arch-a/design` re-executes
- **THEN** its prompt context contains
  `feedback.jobs["arch-a"]["design"]["report"]`,
  `feedback.jobs["arch-b"]["design"]["report"]` and `feedback.message`

### Requirement: Rerun targets are validated
Validation SHALL reject a `rerun` whose `stepIds` name steps absent from the
routing job; whose `jobIds` name a job that does not exist, is the routing job
itself, or transitively depends on the routing job; which mixes `stepIds` with
`jobIds`; which names neither; or whose `maxRounds` is below 1. The `needs`
graph SHALL remain acyclic; `rerun` is the only backward edge and is always
budgeted.

#### Scenario: Sibling rerun target is rejected
- **WHEN** a workflow routes `rerun: { jobIds: [sibling] }` where `sibling`
  is not an ancestor of the routing job through `needs`
- **THEN** validation fails naming the routing step and the offending job,
  because rerunning a non-ancestor would never re-trigger the routing job

#### Scenario: Unbounded rerun is unrepresentable
- **WHEN** a workflow declares a `rerun` with `maxRounds: 0` or a `goto`
  cycle with no budget on any edge
- **THEN** validation rejects it — every loop carries a bound by construction

### Requirement: A failed job is terminal and the DAG reacts to it
When a step exhausts its retry budget with no `onFail` route, its job SHALL
become `failed` (terminal) rather than immediately escalating the feature.
Dependents SHALL then be evaluated: those with no condition SHALL be skipped,
`if: always()` jobs SHALL run, and `if: failure()` jobs SHALL run only when a
dependency failed or was skipped. A skipped job SHALL itself be terminal and
its own dependents SHALL be evaluated in the same pass, since a skipped job
emits no event of its own. The feature SHALL escalate only when the failure
leaves no other job able to run, and a run whose jobs are all terminal with at
least one failure SHALL end `escalated`, never `done`.

#### Scenario: Multi-hop skip cascade
- **GIVEN** `build → test-a`, `build → test-b`, and `review` needing both tests
- **WHEN** `build`'s only step exhausts its retries with no `onFail` route
- **THEN** `build` becomes `failed`, `test-a` and `test-b` are skipped, and
  `review` is skipped in the same transition

#### Scenario: Independent branch survives a sibling failure
- **GIVEN** `branch-a` and `branch-b` with no dependency between them, both running
- **WHEN** `branch-a` fails
- **THEN** `branch-b` is untouched, the feature stays `running`, and only
  `branch-a`'s dependents are skipped

#### Scenario: Cleanup and recovery conditions
- **WHEN** a dependency fails
- **THEN** an `if: always()` dependent runs and an `if: failure()` dependent runs
- **WHEN** every dependency succeeds
- **THEN** the `if: failure()` dependent is skipped
