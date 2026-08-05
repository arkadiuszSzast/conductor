# Concepts

This page explains how Conductor executes a workflow: the pieces, their
lifecycle, and the reasoning behind the model. The [workflow
reference](workflow-reference.md) documents every field; this page explains
what the fields mean at runtime.

## The big picture

```
 workflow (YAML) ──parse──▶ IR ──┐
                                 ├──▶ interpreter ──▶ decisions + state patch
 feature state (SQLite) ─────────┤         ▲
                                 │         │
 event (step finished, …) ───────┘     pure function
```

A **feature** is one run of a workflow (CI would say "a build"). Its state
lives in SQLite; sessions and processes are disposable executors. Every time
an event arrives — a step reported completion, a human approved a gate — the
**interpreter** (a pure function, no I/O) receives `(workflow IR, feature
state, event)` and returns **decisions** ("execute this step", "wait for a
human", "escalate") plus a **state patch**. The engine applies the patch,
carries out the decisions, and waits for the next event.

Because the interpreter is pure, every workflow shape is unit-testable
without a database, a git repo or an LLM.

## Jobs: the DAG

A workflow is a set of **jobs**, exactly like GitHub Actions:

- Jobs with no `needs` start immediately, in parallel.
- A job with `needs` waits until every listed job is terminal.
- When a dependency fails or is skipped, dependents are skipped — unless
  their `if` says otherwise (`always()`, `failure()`).
- Skip cascades resolve transitively in one pass: if A fails, and B needs A,
  and C needs B, both B and C are skipped immediately.

A linear workflow is simply one job with ordered steps — the simple case
stays simple.

### Job failure is terminal, not fatal

When a step exhausts its retries with no route to follow, its **job** fails —
not the whole feature. The DAG reacts: dependents skip, `if: failure()`
cleanup jobs get their turn, and **independent branches keep running**. The
feature escalates to a human only when the failure leaves nothing else
runnable. A feature in which any job failed finishes as `escalated`, never
silently as `done`.

## Steps: the path within a job

Steps run in declaration order — a path, not a graph. Parallelism lives at
the job level. There are exactly four step kinds:

| Kind | Executes | Typical outputs |
|---|---|---|
| `agent` | An LLM agent with a role and a prompt | `report` |
| `command` | Shell commands | whatever it writes to `$CONDUCTOR_OUTPUT` |
| `action` | A versioned, manifest-declared local action (`uses: git/worktree@v1`) | per its manifest |
| `human` | A human gate — the feature waits | `notes` |

## Outcomes vs failures: the core distinction

Every step ends in exactly one of two ways, and the distinction drives
everything downstream:

**The step completed its work** and reports an *outcome* — a
workflow-defined name (`done` by default). A review step reports `approved`
or `changes_requested`; a consensus check reports `agree` or `disagree`; a
classifier reports any label it likes. The step's `outcomes` map routes each
name. Reporting an outcome never consumes retry budget: the step *worked*,
the workflow is just deciding where to go next.

**The step could not do its work** — crash, non-zero exit, timeout. This is
`step.failed`, and it consumes the **retry budget** (`retry`). Once the
budget is exhausted, `onFail` routes the failure; with no `onFail`, the job
fails (see above).

The engine attaches no meaning to any outcome name. `approved` is not a
keyword — it routes because the workflow maps it, not because Conductor
knows what approval is. An outcome the step reports but the map does not
declare escalates: the workflow author's vocabulary is the contract.

Human gates use the same mechanism: approving is an outcome, rejecting is an
outcome, and the reviewer's note travels in `outputs.notes`. There is no
separate human-decision vocabulary in the engine.

## Outputs: named values, GHA-style

Every step publishes **named outputs** — a map, not a single value:

- `command` steps write `name=value` lines to `$CONDUCTOR_OUTPUT` (the
  mirror of GHA's `$GITHUB_OUTPUT`).
- `action` steps publish the typed outputs their manifest declares
  (`git/push@v1` → `sha`, `url`).
- `agent` steps publish their report under `report`.
- `human` gates publish the note under `notes`.

Jobs then **declare** what they publish to the rest of the graph, as
expressions over their steps' outputs:

```yaml
architect-a:
  outputs:
    design: "{{ steps.design.outputs.report }}"
```

Dependent jobs consume declared outputs via `needs`:

```yaml
consensus:
  needs: [architect-a]
  steps:
    - id: agree
      agent:
        prompt: "Architektura A: {{ needs['architect-a'].outputs.design }}"
```

The two-layer design is deliberate: step outputs are the job's private
implementation detail; `outputs:` is its published, **validatable
contract**. A reference to `needs.X.outputs.Y` can be checked statically —
X must appear in `needs` and Y must be declared in X's `outputs`. A typo is
a validation error, not an empty string at runtime.

## Loops: `rerun`

DAGs cannot cycle, but agent workflows need loops — review/fix, consensus,
"try again with feedback". The `rerun` route is the one loop mechanism, and
every loop is **bounded by construction** (`maxRounds` is required; on
exhaustion the feature escalates).

### Step-scope rerun — loops inside a job

```yaml
- id: internal-review
  agent: { role: reviewer, prompt: "..." }
  outcomes:
    approved: next
    changes_requested:
      rerun: { scope: steps, stepIds: [implement, quality], maxRounds: 3 }
```

The named steps are cleared and re-executed; the job keeps running. This is
the review/fix loop.

### Job-scope rerun — loops across the DAG

```yaml
- id: agree                          # inside job `consensus`
  outcomes:
    approved: next
    changes_requested:
      rerun: { scope: jobs, jobIds: [architect-a, architect-b], maxRounds: 5 }
```

The target jobs **and everything downstream of them** (the transitive
closure through `needs` — including the routing job itself) reset to
pending and re-run. Fan-in then re-triggers the routing job naturally: the
consensus judge re-evaluates every round.

Validation enforces that job-scope targets are **true ancestors** of the
routing job (the routing job must transitively depend on them via `needs`).
This is what makes the loop close: rerunning your ancestors re-triggers you.
Rerunning a sibling or a downstream job would leave the loop dangling, so it
is rejected.

The round counter lives on the **routing job keyed by the routing step** and
survives the closure reset — that is what makes `maxRounds` enforceable
across rounds.

### Feedback: what a new round knows

Re-run steps start as **fresh sessions** with no memory. The rerun
transition therefore carries a **feedback snapshot** taken *before* the
reset: the named outputs of every step in the rerun targets, plus the
routing step's outputs, plus the route reason:

```
feedback.jobs.<jobId>.<stepId>.<name>   — pre-reset outputs
feedback.message                        — why the loop fired
```

In round 2, architect A's prompt can reference its own previous design,
architect B's design, and the judge's note — that is the entire mechanism by
which "re-run with the other agent's output" works.

Two context namespaces, two guarantees:

| Namespace | Reads | Semantics |
|---|---|---|
| `needs.*`, `steps.*` | the **current** round, live | Hard: values are guaranteed to exist (the DAG ordered them); a missing value is an error. |
| `feedback.*` | the **previous** round, snapshot | Soft: empty outside a rerun **by design** — round 1 has no previous round. Templates render empty strings. |

The `feedback.*` reference is still statically checkable: a reference to
`feedback.jobs[J][S]` in job X is legal iff some `rerun` route targets X and
J is one of that rerun's targets (or the routing job itself). The check
lives in validation; the reference resolves at runtime from the rerun's
snapshot.

## Escalation, pausing, resuming

**Escalation** is the safety valve: whenever the workflow cannot proceed
without a human — a job failed with nothing else runnable, a loop exhausted
`maxRounds`, a step reported an undeclared outcome — the feature becomes
`escalated` and waits.

A human can also explicitly **pause** a running feature and **resume** it
later. Resuming:

- a `paused` feature re-dispatches whatever was in flight;
- an `escalated` feature resets the stuck step's retry/rerun budget and
  retries it — including a job that failed terminally (its failed step is
  re-executed with a fresh budget);
- a feature waiting at a human gate goes back to waiting at that gate.

**Abandoning** ends the feature permanently.

## Determinism and durability

- The interpreter is deterministic: same IR + state + event → same decisions.
- All state transitions go through patches persisted to SQLite; a daemon
  restart resumes from durable state.
- Stale events (a report from a step that is no longer current) are noops,
  which makes retries and at-least-once delivery safe.
