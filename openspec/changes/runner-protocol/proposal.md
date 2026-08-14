## Why

Submitting an agent task before an eligible runner is online currently fails the step immediately and can exhaust workflow retries without any agent ever receiving work. Runner availability must be a durable scheduling condition: tasks should wait visibly, resume automatically when a compatible runner appears, and retain explicit recovery if waiting expires.

## What Changes

- Define a minimal versioned runner contract with register/heartbeat capabilities and create/prompt/status/note/cancel session operations.
- Replace process-local availability assumptions with durable runner identity and bounded heartbeat leases.
- Capability-match each agent step before dispatch; absence of a compatible leased runner creates a durable unassigned offer/resource wait rather than a failed run.
- Atomically and idempotently bind an accepted assignment to one runner and session attempt; reconcile lost create/prompt responses without duplicates.
- Wake blocked work when compatible runner availability changes while retaining heartbeat reconciliation as the correctness path.
- Map runner operation failures into the generic taxonomy and retry/recovery system owned by `retry-policy`; runner absence itself remains resource unavailability, not an executable attempt failure.
- Keep cancellation best-effort and explicit reporting authoritative.
- Preserve the seed's `SessionClient` seam, disposable-session principle, safe unknown-status direction and confirmation-of-effect, generalized behind a runtime-neutral protocol.

## Capabilities

### New Capabilities

- `runner-contract`: Version negotiation, capabilities, operations and stable error mapping.
- `runner-lifecycle`: Leased availability, durable identity, safe unknown status, return and cancellation.
- `agent-assignment`: Durable self-contained offers, compatibility waiting, atomic acceptance and idempotent session binding.

### Modified Capabilities

_None._

## Impact

- Affects server runner registry/transport, engine assignment integration, SQLite migrations, `@conductor/runner-opencode`, API health/projections and runner documentation.
- Adds runner identity, lease, capability, assignment and session-binding tables/indexes additively. Current in-memory registrations re-register into durable identity after upgrade.
- Existing agent workflow YAML remains valid. `gloam-idle` runner configuration keeps the same connection inputs; the reference adapter adds heartbeat/idempotency behaviour.
- Coordinates with `retry-policy`: runner-protocol reports availability and classified operation results; retry-policy owns blocked state, scheduling, budgets, escalation and operator recovery.
- Does not introduce a remote task queue, hosted scheduler, model gateway or success inference from idle sessions.