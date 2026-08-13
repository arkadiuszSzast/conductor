## Context

The current opencode adapter registers a process-local callback endpoint in an in-memory daemon registry. Selection means "any registration exists"; there are no capabilities, stable identity, heartbeat lease or durable assignment. Session reads fail safe, but a new dispatch with no runner throws and becomes a failed step attempt.

Generic resource waits, retry policy, escalation and operator recovery belong to `retry-policy`. This change supplies authoritative runner availability and assignment effects to that lifecycle.

## Goals / Non-Goals

**Goals:**

- Ensure starting work before a runner is online is safe and automatically recoverable.
- Make runner availability truthful through leases and capability matching.
- Make create/prompt delivery idempotent across lost responses and restarts.
- Preserve runtime neutrality and explicit report completion.

**Non-Goals:**

- Remote multi-host load balancing, runner-owned queues, universal model names, inferred success from idle, or generic retry scheduling inside the runner layer.

## Decisions

### Durable stable identity and leased registration

Registration supplies stable runner identity, protocol versions, callback transport, served project roots and capabilities. SQLite persists identity and latest lease; secrets remain configuration-only. Heartbeat renews a bounded lease. Selection considers only non-expired compatible runners in deterministic configured priority/stable order.

Alternative: retain endpoint-keyed in-memory identity. Rejected because ephemeral ports and daemon restarts create false identities and stale availability.

### Daemon-initiated callback protocol

JSON HTTP uses a versioned media type. Every operation carries request ID, idempotency key, runner ID, deadline and correlation fields. Same-host v1 supports loopback and can later add Unix sockets without changing assignment semantics. Shared token auth and canonical directory allowlists remain mandatory operator choices.

Alternative: runner polls a queue. Deferred because daemon callbacks fit same-host v1 and durable offers already provide correctness.

### Durable offer precedes executable run attempt

When the generic lifecycle decides `wait_resource(compatible_runner)`, the server persists a self-contained assignment offer and requirements without creating a run. Once a runner is selected, a transactional claim creates/binds one attempt and advances through create then prompt. A lease expiry before acceptance releases the offer; after acceptance, recovery follows run policy.

This boundary ensures no-runner time does not count as an attempt while transient failures after runner acceptance do.

### Idempotent create and prompt state machine

Create and prompt have separate durable operation records and idempotency keys. Session reference is persisted before prompt. Lost create responses are redelivered with the same key. Lost prompt responses are reconciled through idempotent operation lookup/status, never blind fresh prompting. Assignment and session binding are unique per attempt.

Alternative: one create-and-prompt call. Rejected because partial effects cannot be reconciled safely.

### Availability wake-up is optimization, heartbeat is correctness

Registration/heartbeat/capability changes signal the engine to reconcile matching waits promptly. Due-resource queries remain the fallback so lost in-memory notifications cannot strand work. Batches are bounded and claims transactional to avoid a reconnect storm duplicating work.

### Error ownership boundary

No compatible runner maps to generic resource reason `compatible_runner_unavailable`. Once a runner operation is attempted, protocol errors map to shared failure classes and optional retry hints. Runner-protocol does not decide delay, budget or escalation.

### Safe status and cancellation

Unknown/unreachable status preserves the existing safe-direction behaviour: do not infer idle, nudge or reap; generic policy schedules another observation and TTL remains finite. Pause/abandon may request cancellation, but durable lifecycle transition does not wait for runner availability.

### Migration

Additive migrations create runner identity, leases, capabilities, assignment offers, operation deliveries and session bindings. On upgrade, current adapters register with a stable configured/generated local identity. Legacy in-memory registrations disappear on daemon restart and re-register normally. Existing active run session IDs remain reconciled through adapter status; no workflow YAML changes are required.

Rollback requires stopping the upgraded daemon; old binaries ignore new tables but cannot progress durable unassigned offers. No data is destructively rewritten.

## Risks / Trade-offs

- **Heartbeat false negatives during local stalls** → leases exceed expected heartbeat jitter and active accepted assignments use safe reconciliation rather than immediate reassignment.
- **Reconnect wakes many offers** → capability-indexed bounded queries, jitter and transactional claims.
- **Idempotency storage grows** → finite retention after attempts become terminal, preserving audit references.
- **Stable local identity configuration is awkward** → reference adapter persists/generated identity outside ephemeral process state and documents cloning rules.
- **Protocol surface precedes second adapter** → conformance suite and mock runner prevent opencode-specific leakage.
