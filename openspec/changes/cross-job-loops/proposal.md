## Why

Parallel multi-agent workflows need cross-job feedback loops. The canonical
example: two architects design a feature in parallel, a third agent checks
whether they agree, and on disagreement both architects re-run with each
other's output plus a note on what conflicts — repeating until they converge,
then a planner splits the agreed design into tasks.

Two gaps blocked this. First, routing was job-local: a route could only target
a step in the same job, completed jobs could not be re-triggered, and one
step's output could not reach another step's prompt. Second, the IR modelled
"the step finished" in two different ways — `step.succeeded` for plain
completion and a separate `step.verdict` carrying a review verdict — which
tied structured results to a review-shaped special case and hard-coded the
review vocabulary into the engine.

## What Changes

- **One completion mechanism.** `step.succeeded` and `step.verdict` collapse
  into `step.completed { outcome?, output? }`. A step that finished its work
  reports an outcome; the workflow declares `outcomes: { <name>: route }` and
  the interpreter routes on the name. Outcome names are workflow-defined
  strings — `agree`/`disagree`, `approved`/`changes_requested`, `cat`/`dog`,
  anything. The engine attaches meaning to none of them. A step with no
  `outcomes` simply advances along its path (default outcome `"done"`).
- **`step.failed` stays separate and means something different.** A failure is
  "the step could not do its work" (crash, non-zero exit, timeout) and is
  therefore subject to the retry budget: re-running the *same* step may help.
  An outcome is "the step did its work, here is the result" — re-running it
  would just produce the same answer, so outcomes route elsewhere.
- **`rerun` routing target.** Any route (`outcomes[...]`, `onFail`,
  `onReject`) may carry `rerun: { stepIds? | jobIds?, maxRounds }`. `stepIds`
  loops back to earlier steps of the same job (review/fix); `jobIds` re-runs
  upstream jobs and their downstream closure (parallel-agent consensus).
- **`roundsWith`/`maxRounds` are removed.** They were an agent-only, review-
  shaped loop primitive; `rerun.stepIds` covers the same shape with one
  counter, one budget rule and feedback for free.
- **Loop counter and feedback.** `JobRuntime.reruns` counts iterations per
  routing step and survives the closure reset. The transition carries a
  `feedback` snapshot — pre-reset step outputs plus a `message` — which the
  engine injects into re-run prompts (`{{ feedback.jobs.arch-a.design }}`,
  `{{ feedback.message }}`).

## Non-goals

- No workflow-level stages/phases abstraction.
- No general step-level fan-out (`then: string[]`) — parallelism stays at the
  job level.
- No engine-defined outcome vocabulary or outcome-name validation beyond
  "the route it maps to must exist".
- No automatic convergence detection — the round budget is the safety valve.
