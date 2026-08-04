# Design — cross-job-loops

## Context

The seed's routing is single-job: `on_fail.goto`, verdict routes and
`roundsWith` all stay inside one job. `workflow-format` shipped the DAG at the
job level (`needs`) and step paths inside jobs. The consensus-feedback pattern
(parallel agents, convergence check, re-run with the other agent's output)
needs a backward edge across jobs, with a budget and a data channel.

While closing that gap it became clear the IR had a second, deeper problem:
"the step finished" was modelled twice. `step.succeeded` meant plain
completion; `step.verdict` meant completion *with a structured result*, but
only for agent steps, and its routing map was called `onVerdict` with
review-flavoured keys. That baked a review-shaped special case into a general
engine.

## Key decisions

### Completion is one event with an outcome

```ts
{ kind: "step.completed", jobId, stepId, outcome?: string, output?: string }
```

The step declares what its outcomes mean:

```yaml
- id: check
  type: agent
  role: adjudicator
  outcomes:
    agree:    { next: true }
    disagree: { rerun: { jobIds: [arch-a, arch-b], maxRounds: 3 } }
```

`outcome` defaults to `"done"`. A step with no `outcomes` map advances along
its path regardless of what it reports, so linear workflows stay noise-free.
An outcome that is declared-but-unmapped escalates rather than silently
falling through — a misspelled outcome is a workflow bug, not a route.

The same mechanism now serves review verdicts, consensus checks, classifiers
and gate results. The engine has no built-in outcome vocabulary.

### Failure is NOT an outcome

A failure means the step could not complete its work: crash, non-zero exit,
timeout, transport error. That is precisely the class where re-running the
*same* step can help, so failures consume the retry budget and then take
`onFail`. An outcome means the step did complete — re-running it unchanged
would produce the same result, so outcomes never retry; they route.

This is why "consensus disagreement" is an outcome, not a failure: the
adjudicator did its job correctly and reported a real finding.

### `rerun` is a routing target, not a step kind

Routing stays a pure-interpreter concern. `rerun` is a third target alongside
`goto` and `next`, allowed on every route source:

- `rerun: { stepIds: [fix], maxRounds: 3 }` — loop back inside the job. The
  named steps are cleared and the first is dispatched; the job keeps running.
  This replaces `roundsWith`/`maxRounds`.
- `rerun: { jobIds: [arch-a, arch-b], maxRounds: 3 }` — re-run upstream jobs.

Mixing `stepIds` and `jobIds` in one target is rejected: they have different
reset semantics and a combined form would hide which one bounded the loop.

### The counter lives on the routing job and survives the reset

`JobRuntime.reruns[routingStepId]` counts iterations. A job-level rerun must
reset the routing job itself so fan-in re-triggers it, therefore the closure
reset preserves that one field and clears everything else. `maxRounds ≥ 1` is
required, so every backward edge is bounded by construction; the `needs` graph
itself stays acyclic.

### Closure reset is the transitive downstream

Rerunning `arch-a` invalidates everything that consumed its output, so the
reset set is the rerun targets ∪ every job transitively depending on them
through `needs`. Deterministic from the graph — no ordering, no clock.
Targets must be strict ancestors of the routing job, so a rerun always goes
backward.

### Feedback is a nested snapshot on the transition

```ts
interface Transition { decisions; patch; feedback?: Feedback }
interface Feedback {
  jobs: Record<jobId, Record<stepId, string>>   // pre-reset outputs
  message?: string                              // outcome / failure reason
}
```

Built from the pre-reset state, so the round that just ended is still
readable. The engine merges it into the template context of re-run steps:

```
prompt: "Your previous design: {{ feedback.jobs.arch-a.design }}
         The other design:     {{ feedback.jobs.arch-b.design }}
         Conflict:             {{ feedback.message }}"
```

Works with the existing `{{ dotted.path }}` renderer; the `jobs` nesting keeps
lookup unambiguous.

### Escalation is the safety valve

At `maxRounds` the rerun escalates instead of looping. A human resumes with
the existing budget-reset behaviour, so a non-converging debate lands in front
of an operator rather than burning tokens.

## Alternatives considered

1. **Keep `step.verdict` separate from `step.succeeded`.** Rejected: two
   events for one phenomenon, and the verdict path was agent-only.
2. **Model disagreement as `step.failed`.** Rejected: it would put the
   adjudicator on the retry path, re-running a step that worked correctly, and
   conflate "could not run" with "ran and found a conflict".
3. **Keep `roundsWith` for local loops.** Rejected: two loop mechanisms with
   different budget rules, and `roundsWith` could not carry feedback.

## Compatibility

- Single-job linear workflows: unchanged (`outcomes` optional, default advance).
- `workflow-format` graph spec: makes its "return to an earlier job" clause
  concrete without re-shaping state.
- `JobRuntime.reruns` is additive; existing fixtures default it to `{}`.

## Confirmed: the IR is a normalised form

The IR is the product of parsing, not the authoring surface. YAML keeps its
sugar (omit `needs`, omit `outputs`, write a bare step); the parser fills the
empty collection. So a field is optional in the IR only when its absence means
something no empty value can express.

- **Collections are total.** `WorkflowDef.on`, `WorkflowDef.inputs`,
  `JobDef.needs`, `JobDef.outputs`, `StepBase.outcomes`, `ActionStep.with` and
  `TriggerEvent.inputs` are required and may be empty. Empty `needs` means
  "ready at once"; empty `outcomes` means "always advance".
- **Optional means "absent ≠ empty".** `JobDef.if` (absent = "run when
  dependencies succeeded", which `""` cannot express), `CommandStep.cwd`
  (absent = the job's directory), `CommandStep.timeoutMs` (absent = no
  timeout, `0` = expire immediately), `StepBase.onFail` (absent = escalate)
  and every field of `Patch` (absent = leave alone).
- **Choices are discriminated unions, not bags of optional fields.**
  `Route` is `{kind:"next"} | {kind:"goto",stepId} | {kind:"rerun",target}`;
  `RerunTarget` is `{scope:"steps",stepIds,maxRounds} | {scope:"jobs",jobIds,maxRounds}`;
  `InputDef` is `{presence:"required"} | {presence:"optional",default}`;
  `RetryPolicy` and `BackoffDef` likewise. An unrepresentable state — a route
  with both `goto` and `rerun`, a rerun with neither steps nor jobs, an input
  both required and defaulted — can no longer be constructed, so the
  corresponding validation rules disappear.
- **`then` is gone.** It was a second spelling of `goto`. The path is
  declaration order; anything else is an explicit route.
- **`onReject` and the human events are gone.** A human gate completes like
  any other step: approving and rejecting are outcomes (`approved`,
  `rejected`) carrying the note as `output`. `human.approved`/`human.rejected`
  collapse into `step.completed`, so a gate can route, loop or rerun with
  exactly the vocabulary every other step has.
- **Test builders stand in for the parser.** `packages/core/testing.ts`
  provides `agentStep`/`commandStep`/`job`/`workflow` and route helpers, so
  tests read like authored workflows while the IR stays strict.

## Confirmed: job failure is terminal, not automatically fatal

Review of this PR surfaced that `JobStatus: "failed"`/`"skipped"` and the
`skip_job` decision were unreachable: a step exhausting its retries escalated
the whole feature and never marked its own job failed, so fan-in never saw a
failed dependency and the `always()`/`failure()` branches were dead code.

Now a step that exhausts its retry budget with no `onFail` route marks its
**job** `failed` and the graph reacts:

- Dependents with no condition are **skipped**, and a skipped job is itself
  terminal, so the cascade continues — `A → B → C` skips C in the same pass.
  This matters because a skipped job produces no event of its own; without a
  fixpoint walk C would stay `pending` forever.
- `if: always()` runs regardless; `if: failure()` runs **only** when a
  dependency failed or was skipped, and is skipped when everything succeeded
  (previously it would have run unconditionally).
- The feature escalates only when the failure leaves nothing else to run.
  An independent branch keeps working; a human is called exactly when the run
  can no longer make progress on its own.
- A run that reaches the end with any failed job finishes `escalated` rather
  than `done`, so a partially-failed DAG is never reported as success.
