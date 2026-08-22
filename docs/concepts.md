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

### Interactive steps: asking mid-step

An agent step can also pause itself *without* concluding: the runner
reports an **ask** — a question for the human — and the run's session
stays alive while the feature waits (`waiting_human`). The answer is
forwarded straight into that same session, so the agent continues with its
full conversation context; no rerun, no fresh session. This is run-level
state, not a workflow transition: the step stays `running` with the same
active run. Asking is **opt-in per step** — only an agent step declared
`interactive: true` may ask; all other steps are autonomous by contract,
and the daemon refuses their asks with an instruction to decide and
report. While a question is pending the run is exempt from idle
nudging/reaping (waiting on a human is not being stuck), but the overall
run TTL still applies, so an abandoned question eventually fails the step
through normal failure routing. Contrast with a `human` step: a gate is a
step *between* steps with approve/reject outcomes; an ask is a
conversation *inside* a step.

#### Answer delivery: accepted durably before it is delivered

Answering a question is split into two separately durable steps, so a
daemon crash between them never loses the operator's decision:

1. **Acceptance** — the answer's notes are persisted immediately
   (`POST /v1/runs/:id/answer` returns as soon as this commits), before any
   attempt to forward them into the agent's session. A second answer
   request for the same question while the first is still
   accepted-but-undelivered is rejected as a conflict — never silently
   replaced, never queued.
2. **Delivery** — the notes are forwarded into the run's live session as a
   prompt. Attempted immediately for low latency, and retried by the
   reconciler on every pass until confirmed, so a crash between
   acceptance and delivery is repaired automatically on restart with no
   new operator action.

While a delivery is in this pending/claimed window, the run and feature
projections (`GET` on the run, the feature's `activeRun`/`activeRuns`, and
the CLI's `status`) carry an `answerDelivery: {status, acceptedAt}`
alongside the still-present `pendingQuestion` — long enough to let a
UI/CLI disable re-submission and show "answer accepted — delivering" instead
of either re-offering the answer form or falsely implying the feature has
gone back to `running` before the agent has actually seen the answer.
`answerDelivery` disappears once delivery is confirmed (or fails through
normal failure routing) — at that point `pendingQuestion` is also cleared.

Delivery is retried by an internal lease: a delivery claimed but not
confirmed within its lease window is claimable again on the next
reconcile pass. This means the underlying session prompt is
**at-least-once, not exactly-once** across a narrow crash window (claimed,
prompt sent, daemon dies before confirming) — the agent could see the same
answer prompt twice, tagged with the same internal delivery token so a
runner MAY de-duplicate on it, but Conductor does not guarantee it will
not repeat the prompt. The store-side confirmation itself is
exactly-once: a delivery only ever reaches `delivered` once, regardless of
how many redelivery attempts preceded it.

**Bounded transient-retry schedule.** A crash-recovery reclaim (a
lease-expired `claimed` row) is retried immediately, but a genuinely
*failed* prompt attempt — the runner call itself threw a transient
transport/capacity/upstream/timeout error — is retried on the same
finite, exponentially-backed-off schedule a step's own transient retries
use: up to 5 attempts, 1s initial delay doubling to a 60s cap with full
jitter, within a 10-minute elapsed budget from acceptance. Each transient
failure schedules the delivery's `next_attempt_at` forward instead of
making it immediately due again — a reconcile pass before that time is a
no-op for this delivery — so a persistently unreachable session/runner
cannot spin the reconciler forever. Exhausting either bound (attempts or
elapsed) concludes the step `failed` through the same classified-failure
routing a terminal delivery error already uses, described next. A
deterministic/invalid/internal prompt error is never retried at all — it
routes to that same terminal failure on its first attempt.

A dead session, a terminal (non-transient) failed prompt, or a
transient-retry budget exhaustion at delivery time concludes the step
`failed` through the same classified-failure/retry/`onFail` routing every
other step failure uses — an unanswerable question never leaves the run
stuck in a silent zombie wait.

**Superseded confirmation.** Confirming delivery also re-checks that the
run's currently open question is still the exact one this delivery
answers (its `asked_at` still matches the generation recorded at
acceptance) — not merely that a question is still pending at all. If the
agent has already moved on to a NEWER question by the time a (possibly
redelivered, at-least-once) confirmation lands, the stale delivery is
atomically cancelled instead of being confirmed, and the newer question
is left completely untouched.

**Pause interaction:** accepting an answer succeeds even while the feature
is paused (the operator's decision is never rejected just because
something else paused the feature), but the delivery side effect — the
actual session prompt — is never attempted until the feature resumes and
reconciles, per the same pause barrier that governs retries and resource
waits.

**Upgrade/rollback:** the answer-delivery table and its bounded-retry-
schedule columns (`attempt_count`, `next_attempt_at`, `deadline_at`) are
additive — existing in-flight questions on an older daemon remain
readable after upgrade. Rolling back to a pre-upgrade daemon while an
answer is accepted-but-undelivered is not supported directly: either
drain pending deliveries first (resume, wait for reconciliation to
confirm them) or roll forward again once rolled back.

**Secret-safe diagnostics.** Every diagnostic text this path can surface —
a delivery's `failure_detail`, the concluded run's `reason`, the
FailureEnvelope's `diagnostic`, and the corresponding daemon log line —
is passed through the same bounding/redaction helper (`boundDiagnostic`)
the rest of the failure taxonomy already uses: common credential shapes
(`Bearer <token>`, `api_key=...`, `password=...`) are stripped BEFORE the
text is truncated to its length bound, so a secret embedded past the
truncation point cannot survive by accident. This never touches the
operator's own answer notes — only diagnostic/exception text derived from
a runner or process boundary — and notes are never written to the log at
all.

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

## Retries, failure classes and recovery

A `step.failed` conclusion carries a **classified failure envelope**
(`class`, a bounded human diagnostic, `source`, and an optional adapter
retry hint) — never raw error text driving policy. The class is one of a
closed, stable set:

| Class | Meaning | Default treatment |
|---|---|---|
| `transient_upstream`, `transient_transport`, `capacity`, `timeout` | Weather: the provider, network or infra hiccuped | Patient — up to 5 attempts, exponential backoff, 10-minute elapsed budget |
| `deterministic_failure`, `invalid_config` | The work itself is wrong (failing build, bad command) | Immediate — 1 attempt, fails fast |
| `missing_session`, `cancelled` | The execution vanished or was cancelled out from under it | Immediate — 1 attempt |
| `internal` | Unclassified/adapter bug — never inferred as success, never retried forever | Small finite budget — 2 attempts, 2-minute elapsed |

An adapter that reports no class, or an unrecognised one, always normalises
to `internal` — Conductor never trusts an unknown value as "safe to retry
patiently" or "safe to ignore".

Each of the classes above carries **two independent budgets**, and the
first one exhausted stops the retry, whichever it is:

- **Attempts** — `steps[*].retry.maxAttempts`/`backoff` (see the [workflow
  reference](workflow-reference.md#stepsretry)) override the class
  default's attempt count and backoff shape for a step. A step with no
  `retry:` declared gets exactly one attempt, same as always.
- **Elapsed time** — measured from the first attempt's dispatch, **excluding
  time spent paused** (see below). This is currently always the failure
  class's own fixed default from the table above; there is no workflow
  syntax yet to override it per step (the parsed `retry.maxElapsed` field
  is validated but has no runtime effect — see the reference page). When
  the next scheduled attempt would start after this deadline, it is never
  dispatched — the step reaches its terminal route (`onFail`, or job
  failure with no `onFail`) at the deadline, exactly as if attempts had run
  out, without spending one attempt over budget.

A retry that has a non-zero backoff delay is a **durable scheduled
episode**, not an in-memory timer: it survives a daemon restart, and
exactly one attempt is ever claimed for it even if two reconciler passes
observe it due at once. If the daemon was down long enough that a due
episode's elapsed deadline has *also* passed by the time it is finally
claimed, the engine escalates it instead of dispatching one attempt too
many.

A required resource being unavailable (no compatible runner, an
unavailable binding) is tracked separately as a **resource wait** — it does
not spend attempt budget at all, only its own finite wait deadline with
bounded observation backoff. A satisfied resource wait dispatches its step
automatically; an expired one escalates with an actionable diagnostic.

## Escalation, pausing, resuming

**Escalation** is the safety valve: whenever the workflow cannot proceed
without a human — a job failed with nothing else runnable, a loop exhausted
`maxRounds`, a step reported an undeclared outcome, a retry or resource-wait
budget ran out — the feature becomes `escalated` and waits.

A human can also explicitly **pause** a running feature and **resume** it
later. While paused, the engine does not dispatch, claim due retries or
resource waits, nudge or reap sessions, or apply downstream effects — a
late-arriving report is still recorded, but its consequences wait for
resume. Time spent paused never counts against a retry episode's elapsed
budget: pausing a feature whose retry is already scheduled and letting it
sit for hours does not push that retry closer to its deadline. Resuming:

- a `paused` feature re-dispatches whatever was in flight, and a durable
  retry or resource wait that became due during the pause is claimed
  exactly once, right where it left off;
- an `escalated` feature resets the stuck step's retry/rerun budget and
  retries it — including a job that failed terminally (its failed step is
  re-executed with a fresh budget);
- a feature waiting at a human gate goes back to waiting at that gate.

### Resume vs. recover

`resume` and `recover` both bring an `escalated` feature back to `running`,
but they mean different things and are not interchangeable:

- **`resume`** is the general pause/escalation un-stick: no note required,
  no target selection — it always retries whatever step the feature was
  stuck on, with that step's budget reset.
- **`recover`** (`POST /v1/features/:id/recover`, `conductor recover`) is
  the explicit, audited operator action for escalations caused by an
  exhausted retry or resource-wait budget. It always **requires a note**
  explaining why, chains a brand-new finite retry episode onto the
  target's prior history (so the exhausted episode's attempts/diagnostics
  remain visible, never erased), and — when more than one job/step is
  currently recoverable — requires the operator to name which one
  (`--job`/`--step`, or the `target` body field) rather than silently
  picking one. See [Recovering an escalated feature](http-api.md#recovering-an-escalated-feature)
  for the full contract (optimistic concurrency, idempotency, ambiguous/stale
  target rejection).

Use `resume` for "this was a pause, or I already fixed the underlying
problem and just want the same attempt to run again unremarked." Use
`recover` for "this budget genuinely ran out and I want an audited record
of why I'm re-arming it" — the default path once retry-policy escalations
become common in day-to-day operation.

**Abandoning** ends the feature permanently.

## Determinism and durability

- The interpreter is deterministic: same IR + state + event → same decisions.
- All state transitions go through patches persisted to SQLite; a daemon
  restart resumes from durable state.
- Stale events (a report from a step that is no longer current) are noops,
  which makes retries and at-least-once delivery safe.

## Operator runbook: reading and recovering an escalation

A quick walkthrough for the common "a feature stopped — what do I do"
question:

1. **Read why.** `GET /v1/features/:id` (or `conductor show <id>`) — the
   `activity` field's `state`/`reason`/`diagnostic`/`message` say exactly
   what stopped and why (a retry budget ran out, a resource never showed
   up, a loop exhausted `maxRounds`, an undeclared outcome). `escalation`
   carries the same story as a single string for logs/notifications.
2. **Check what's recoverable.** When `activity.state` is `"escalated"`,
   the detail's `recoverableTargets` lists every job/step recover would
   act on, in the order it would pick by default. Zero entries means
   there is genuinely nothing automatable to re-arm (a workflow-shape
   problem, not a transient failure) — fix the workflow or investigate
   further rather than calling recover.
3. **Recover with a note.** `conductor recover <id> --notes "<why>"` (or
   `POST /v1/features/:id/recover` with the same body) re-arms the
   default target. With more than one recoverable target, add
   `--job <jobId> --step <stepId>` (or the `target` body field) to pick
   one explicitly — an ambiguous call without one is rejected with the
   current candidate list rather than guessing. Add
   `--expected-version <n>` (the feature's `updatedAt` your view was
   rendered from) to detect a stale view, and `--idempotency-key <key>`
   if your client might retry the same logical recover after a network
   timeout.
4. **Confirm it took.** A successful recover returns the fresh feature
   payload with `activity.state` back to `active`/`waiting_retry`/etc. — a
   dispatch failure (e.g. the runner is still down) re-enters the normal
   resource-wait/retry machinery rather than silently doing nothing.
5. **Use `resume` instead** only when the escalation was a plain pause, or
   you already fixed the underlying cause yourself and just want the same
   step to run again without an audited note — see
   [Resume vs. recover](#resume-vs-recover) above for the distinction.

For a resource-wait block (`activity.state: "blocked"`, no retry budget
involved), the same `recover` flow applies once a compatible runner or
binding exists — there is nothing extra to configure; the daemon simply
needed telling to try again after the operator confirmed the underlying
infrastructure issue is resolved.
