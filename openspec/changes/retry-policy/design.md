## Context

The pure interpreter currently emits immediate `execute_step` retries using only attempt count. All effect failures collapse to `step.failed(reason: string)`, runner absence fails dispatch immediately, and `human.resumed` doubles as both unpause and retry-budget reset. SQLite already provides atomic run conclusion, a completion-decision outbox and restart reconciliation; these are the foundation to extend rather than replace.

This change owns generic failure, retry, block, pause and operator-recovery semantics. `runner-protocol` owns runner identity, leases, capability matching, idempotent session operations and maps runner observations into the shared types.

## Goals / Non-Goals

**Goals:**

- Make every non-terminal state explain what can cause future progress.
- Recover automatically from temporary unavailable infrastructure without burning executable attempts.
- Keep policy decisions deterministic and I/O-free while making scheduling and claims durable.
- Provide one explicit recovery operation across failure sources.
- Make API, CLI and UI projections agree about whether work is active, delayed, blocked, paused or escalated.

**Non-Goals:**

- Infinite retries or waits, global circuit breakers, LLM-driven classification, distributed scheduling or automatic repair of invalid workflow definitions.
- Cancelling every runtime effect synchronously on pause; pause guarantees orchestration suspension, while cancellation remains best-effort and runner-specific.

## Decisions

### Shared failure envelope and resource-block reason

Core defines closed v1 failure classes and resource reasons. A failure envelope carries class, bounded diagnostic, source and optional retry hint. Resource unavailability is represented separately because no executable attempt began. Unknown adapter values normalize to finite `internal`; human text never drives policy.

Alternative: treat no runner as `transient_transport`. Rejected because it consumes attempt budget before a runner accepted work and makes submission order observable.

### Pure lifecycle decisions, durable scheduler I/O

The interpreter remains pure. It decides route intent (`retry`, `wait_resource`, `escalate`, workflow route) from normalized policy and state. The engine calculates timestamps using injected clock/random, and the store atomically concludes an attempt and creates its retry episode/schedule. Resource waits are created before a run exists. Reconciliation claims due rows transactionally before dispatch.

Alternative: sleep inside engine dispatch. Rejected because restart loses timers and concurrent reconcilers can duplicate work.

### Explicit active-state invariant

Every non-terminal feature must have at least one durable progress anchor: active run, human gate/question, due retry, resource wait, paused pending work or unhandled outbox decision. Reconciliation repairs a uniquely inferable missing run; otherwise it records an invariant escalation. A terminal DAG with failures is escalated even when the final failure also produced skip decisions.

Alternative: let the board infer stuckness from timestamps. Rejected because the durable state machine, not UI heuristics, must own truth.

### Resource waits are finite observation episodes

A blocked step persists target, reason, policy snapshot, first/latest observation, next observation and deadline. Runner registration/lease change may wake reconciliation early, but heartbeat polling remains the correctness path. Observation uses bounded exponential backoff and does not increment step attempts. Deadline expiry escalates with recover available.

Alternative: wait indefinitely for runner. Rejected because absent/misconfigured infrastructure would hide abandoned work forever.

### Retry episode and budget semantics

`max_attempts` includes the first executable attempt. `max_elapsed` starts immediately before first dispatch and includes execution and unpaused waits. Backoff is overflow-safe, capped and jittered; `Retry-After` is a bounded lower hint. Every operator recover creates a new episode linked to prior history. All budgets remain finite.

### Resume, recover and pause are distinct

`pause` places a barrier in engine/reconciler: no new dispatch, due-work claim, observation, nudge, reap or downstream outbox side effect. Late conclusions are atomically recorded but their decisions remain pending. Budget clocks store accumulated paused duration or shift due/deadline timestamps on resume.

`resume` only removes that barrier. `recover` is allowed for escalated recoverable targets, requires note plus optimistic expected status/version, and chooses default reset or explicit finite override. It never falls through to replay workflow start.

Recoverable targets are derived from the current durable job/step frontier, with retry and resource-wait history used only to explain a matching current target. Closed historical waits and failures from superseded routing steps are never candidates by themselves. When more than one independent current target is recoverable, the operation requires an explicit job/step target and rejects an omitted or stale target rather than choosing by storage-query order. This keeps parallel failure recovery deliberate and prevents one historical `deadline_exhausted` wait from shadowing a newer failure.

Alternative: preserve overloaded resume. Rejected because unpause must not silently grant a fresh failure budget.

### Recovery API and projection

Feature detail exposes a derived activity summary: `active`, `waiting_retry`, `blocked`, `waiting_human`, `paused`, `escalated` or terminal; active run count/targets; failure/resource envelope; retry/wait episode and next time; recoverability and allowed commands. Commands are idempotent and status/version-guarded. Web and CLI consume this projection rather than re-deriving it.

### Migration and compatibility

Additive migrations add failure metadata, retry/resource episodes, due-work indexes and pause accounting. Existing runs receive nullable metadata; legacy text failures normalize to `internal` only if retried. On first reconciliation, inconsistent active features are repaired or escalated. Workflow retry syntax remains valid and is normalized into finite policy defaults.

Rollback can ignore new tables/columns after stopping the upgraded daemon, but features currently in new blocked/retry states require the upgraded binary to progress. No destructive migration or gloam config rewrite is required.

## Risks / Trade-offs

- **Retry/resource policy scope grows quickly** → ship shared model and no-runner recovery first, then map remaining boundaries behind exhaustive tests.
- **Pause races with late reports** → atomically conclude runs but leave outbox decisions undispatched until resume.
- **Two reconcilers duplicate due work** → use conditional transactional claims and a database uniqueness invariant for one active attempt per target.
- **Misclassified deterministic failures retry patiently** → closed taxonomy, conservative finite `internal`, conformance tests and visible classification.
- **Runner availability flaps wake many features** → jittered observations, bounded batches and transactional claims.
- **Legacy stranded state is ambiguous** → only reconstruct when target is unique; otherwise escalate with diagnostics instead of guessing.
- **Historical waits or failures shadow the current frontier** → join history to current failed/blocked job-step state and require explicit selection when multiple current targets remain.
