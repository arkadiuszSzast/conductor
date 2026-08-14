## Why

A Conductor task can currently consume its retries while required infrastructure is absent and can then remain labelled `running` even though no run, gate or future work exists. Operators need transient outages to recover automatically, terminal failures to expose an explicit recovery action, and the UI to state whether work is active, waiting, or needs intervention.

## What Changes

- Introduce a stable failure taxonomy shared by commands, actions, runners, engine, persistence and API; policy never parses diagnostic text.
- Add durable retry episodes with exponential backoff, bounded jitter, tries-and-elapsed budgets, per-class policy and restart-safe due-work claims.
- Add a durable `blocked` lifecycle for work waiting on a recoverable resource such as a compatible runner. Waiting does not create a failed attempt or consume step retry budget.
- Reconcile blocked work automatically when its resource becomes available; use bounded observation/backoff and escalation deadlines so waiting is finite and auditable.
- Separate `resume` from `recover`: resume only leaves a deliberate pause, while recover starts a new audited retry episode for an escalated failure with a selected target and budget reset/override.
- Make pause a scheduling barrier: Conductor records late conclusions but does not dispatch, observe, nudge, reap or advance downstream work until resumed.
- Expose active runs, blocked cause, failure class, retry budget, next attempt/observation and available actions consistently through API, CLI and web UI.
- Preserve the seed's durable reconciler, confirmation-of-effect, nudge/reap and human escalation behaviours, while replacing implicit immediate retries and overloaded resume semantics.

## Capabilities

### New Capabilities

- `failure-classification`: Stable machine-readable failure and resource-unavailability vocabulary across all effect boundaries.
- `durable-retries`: Restart-safe scheduling, resource waits, transactional claims and pause-aware reconciliation.
- `retry-budget`: Finite tries-and-time budgets, explicit escalation and audited operator recovery.

### Modified Capabilities

_None._ Existing `feedback-loops` already requires failed DAGs to escalate, and the new capabilities define the additional lifecycle and visibility contract.

## Impact

- Affects core lifecycle/event/decision types and workflow retry validation; server engine, reconciler, store, migrations and API; CLI; web projections and controls; runner/action/command failure adapters.
- Adds SQLite tables/columns and indexes additively. Existing features remain readable; inconsistent legacy `running` features with no active work are normalized to an actionable escalation during reconciliation.
- Existing workflow files remain valid. New policy fields are optional and receive finite defaults. `gloam-idle` and dogfood workflows need no immediate configuration changes.
- Coordinates with `runner-protocol`: this change owns generic retry/recovery semantics; runner-protocol owns runner leases, capability matching and mapping runner conditions into this model.
- Does not change confirmed runtime, workflow-format, action-registry or explicit-report decisions and does not add LLM-based recovery decisions.