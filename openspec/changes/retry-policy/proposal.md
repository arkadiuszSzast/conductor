## Why

The seed retries by counting failures: "N attempts, then escalate". During a
provider outage this burns its entire budget in minutes and escalates work that
would succeed if the system simply waited. We observed two ten-minute upstream
model outages exhaust features that would have recovered twenty minutes later.

Conductor needs resilience with patience: exponential backoff with jitter and
a cap, budgets expressed in both tries and elapsed time, and policies selected
by stable failure class. A transient provider 5xx should wait; a deterministic
validation/gate failure should route to its fixer or fail immediately. This is
part of the durable state machine, not an in-memory sleep loop.

## What Changes

- Stable failure taxonomy shared by actions, runners, engine and API.
- Declarative retry policy: backoff strategy, base/factor/cap/jitter,
  max-attempts, max-elapsed-time, optional per-class overrides.
- Durable retry scheduling (`next_attempt_at`, budget start, failure history),
  reconciled after restart without busy polling or duplicate dispatch.
- Retry hints (`Retry-After`) are respected within policy bounds.
- Escalation records the full budget/failure summary and remains resumable by a
  human with an explicit budget reset/override.
- Deterministic test clock and jitter source; no flaky wall-clock tests.

## Non-goals

- No infinite retries.
- No LLM-based failure classification or recovery decisions.
- No global circuit breaker in the first slice; policy/state is per run/step.
- No hiding deterministic failures behind delay.
