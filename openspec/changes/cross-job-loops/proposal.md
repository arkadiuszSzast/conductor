## Why

Parallel multi-agent workflows need cross-job feedback loops. The canonical
example: two architects design a feature in parallel, a third agent checks
their agreement, and on disagreement both architects re-run with each other's
output plus a note on what conflicts — repeating until they converge, then a
planner splits the agreed design into tasks.

Today the IR cannot express this. Verdict/failure routing is job-local
(`onVerdict.goto` targets a step in the same job), completed jobs cannot be
re-triggered, and there is no way to feed one step's output back into another
step's prompt. The `workflow-format` graph spec already states that "verdict/
failure routes MAY return to an earlier step **or job** when a budget bounds
the cycle" — the interpreter implements only the step case. This change closes
that gap.

## What Changes

- **`rerun` routing target.** `onVerdict`, `onFail` and `onReject` routes gain
  `rerun: { jobIds: [...], maxRounds: N }`. A route is either `goto`, `next`,
  or `rerun` — never a mix.
- **Loop counter survives reset.** `JobRuntime.reruns` holds a per-routing-step
  counter on the routing job. Each rerun increments it; at `maxRounds` the
  interpreter escalates instead of looping.
- **Deterministic closure reset.** A rerun resets the target jobs AND their
  entire downstream closure (via `needs`) to `pending`, preserving the routing
  job's `reruns` counter. Dependents re-enter through the normal fan-in path.
- **Feedback data flow.** The transition carries a `feedback` snapshot —
  nested `jobs.<jobId>.<stepId>` outputs from the pre-reset round plus a
  `message`. The engine injects it into the prompt context of re-run steps, so
  a prompt can reference `{{ feedback.jobs.arch-a.design }}` and
  `{{ feedback.message }}`.
- **Validation.** `rerun` targets must exist, must be strict ancestors of the
  routing job (never self or a dependent), and must carry `maxRounds ≥ 1`.

## Non-goals

- No workflow-level stages/phases abstraction.
- No general step-level fan-out (`then: string[]`) — parallelism stays at the
  job level.
- No durable history of every prompt/input beyond the feedback snapshot.
- No automatic convergence detection — the budget escalation is the safety
  valve; the agents decide when to agree.
