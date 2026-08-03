# Design — retry-policy

## Context

The seed increments `attempts[stepId]` and immediately routes/retries until
`max_attempts`, while poll-style builtins re-run each reconcile. There is no
`next_attempt_at`, failure taxonomy or wall-time budget. This works for
correctness loops but fails operationally under provider weather.

Retries span layers: runner transport/provider calls, action observations,
step attempts and workflow review/fix loops. They must not collapse into one
counter. This change covers operation/step failure retries; review rounds remain
workflow routing with their own explicit budget.

## Decisions

### Failure taxonomy

Define one closed v1 enum in core and require every effect boundary to map into
it. The engine consumes class + diagnostic + optional provider retry hint.
Human text never drives routing. Unknown/malformed maps to finite `internal`.
Taxonomy evolution is additive by protocol version.

### Policy model

A normalized policy has:

- `max_attempts` (total attempts including first),
- `max_elapsed` (ISO-like duration),
- backoff: `initial`, `multiplier`, `max`, `jitter` (full/equal/none),
- `on_exhausted`: escalate/fail/goto,
- per-class override: retry with optional backoff/budget changes or route now.

Defaults are conservative: transient upstream/transport/capacity retry with
patient minutes→tens-of-minutes→hours schedule; deterministic/invalid/cancelled
do not sleep-retry. Exact defaults live in one documented config object and
can be overridden project/workflow/step (specific wins).

### Durable state machine

Each retry episode has a persisted `retry_state` keyed by step execution
identity: budget start, attempts used, next attempt time, last class,
class-count summary and policy snapshot/digest. Attempt completion and retry
schedule are one transaction. Reconciler queries due rows and claims them via
conditional update/transaction before creating a new run.

Store absolute UTC epoch timestamps for due/deadline and monotonic duration
only inside one process operation. On wall-clock reversal, never dispatch
before persisted due time; log skew. Tests inject `Clock` and `Random` into
pure schedule calculation and engine.

### Backoff calculation

`base = min(max, initial * multiplier^(attemptIndex-1))` with overflow-safe
clamping. Jitter mode defaults to full jitter `[0, base]`; a configured minimum
prevents hot-loop zero. Provider retry-after acts as a lower-bound suggestion,
then the result is clamped by policy max and remaining elapsed budget. The
calculation returns both timestamp and a reason record for audit.

### Budget semantics

`max_attempts` includes the first attempt. `max_elapsed` starts immediately
before first dispatch and includes execution/wait. Never schedule an attempt
whose eligibility exceeds deadline. A running attempt that crosses deadline
is governed by run timeout/cancellation; upon failure no new retry is allowed.
Human resume starts a new episode but preserves old rows/history.

## Alternatives considered

1. **Use an in-memory retry library** — rejected: sleeps vanish on restart and
   duplicate under multiple reconcilers.
2. **Only wall-time budget** — rejected: fast deterministic/internal loops can
   hammer dependencies. Both tries and elapsed are necessary.
3. **Only attempt budget with large fixed delay** — rejected: poor recovery
   latency and synchronized load.
4. **Global circuit breaker first** — deferred. It can optimize known shared
   outages later, but per-step durable correctness cannot depend on it.

## Observability

Each failure/retry emits class, attempt, elapsed/remaining budget, computed
backoff, retry-hint influence and next timestamp. Metrics count failures/retries
by class/action/runner (bounded labels), budget exhaustion and retry wait.
Diagnostics redact secrets and truncate output without losing durable class.
