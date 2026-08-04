# Design — cross-job-loops

## Context

The seed's routing is single-job: `on_fail.goto`, verdict routes, and
`roundsWith` all stay inside one job. `workflow-format` shipped the DAG at the
job level (`needs`) and step paths inside jobs. The consensus-feedback pattern
(parallel agents, convergence check, re-run with the other agent's output)
needs a backward edge across jobs with a budget and a data channel.

## Key decisions

### `rerun` is a routing target, not a new step kind

Routing stays a pure-interpreter concern. `rerun: { jobIds, maxRounds }` is a
third target alongside `goto` (within job) and `next`. It is allowed on all
three route sources: `onVerdict` (consensus check), `onFail` (gate failure
re-runs the implementer), `onReject` (human rejects, architects try again).

```yaml
jobs:
  arch-a: { steps: [design] }        # no needs — runs in parallel with arch-b
  arch-b: { steps: [design] }
  consensus:
    needs: [arch-a, arch-b]
    steps:
      - check:
          onVerdict:
            agree:    { next: true }
            disagree: { rerun: { jobIds: [arch-a, arch-b], maxRounds: 3 } }
      - breakdown
```

### The counter lives on the routing job and survives the reset

`JobRuntime.reruns` (a `Record<stepId, number>` on the routing job) counts
loop iterations. A rerun must reset the routing job itself back to `pending`
so the fan-in re-triggers it — therefore the closure reset preserves the
routing job's `reruns` while clearing everything else. Validation requires
`maxRounds ≥ 1`, so every cross-job cycle is bounded by construction (the
needs graph stays acyclic; `rerun` is the only backward edge).

### Closure reset is the transitive downstream

Rerunning `arch-a` invalidates everything that consumed its output. The reset
set = rerun targets ∪ every job transitively depending on them through
`needs`. This is deterministic from the graph, no ordering or clock involved.
Targets must be strict ancestors of the routing job so a rerun always goes
backward and never resets the routing job's own upstream logic.

### Feedback is a nested snapshot on the transition

```ts
interface Transition { decisions; patch; feedback?: Feedback }
interface Feedback {
  jobs: Record<jobId, Record<stepId, string>>   // pre-reset step outputs
  message?: string                              // verdict / failure reason
}
```

The interpreter builds it from the pre-reset state (each rerun target's step
outputs + the routing step's output). The engine merges `feedback` into the
template context when it renders a re-run step's prompt:

```
prompt: "Previous design: {{ feedback.jobs.arch-a.design }}.
         Other design:   {{ feedback.jobs.arch-b.design }}.
         Conflict:       {{ feedback.message }}"
```

This works with the existing `{{ dotted.path }}` renderer (no bracket syntax);
the `jobs` nesting keeps dotted lookup unambiguous. The verdict event now
carries the check agent's `output` so the disagreement summary is available.

### Escalation is the safety valve

At `maxRounds` the rerun escalates with the full feedback snapshot in the
reason. A human can resume; the existing `onResumed` budget-reset behaviour
applies, giving an operator control over a non-converging debate.

## Compatibility

- Single-job linear workflows: unchanged (`rerun` is new and optional).
- `workflow-format` graph spec: this makes its "return to an earlier job"
  clause concrete without re-shaping state.
- New required `reruns` field on `JobRuntime` is additive; existing fixtures
  default it to `{}`.
