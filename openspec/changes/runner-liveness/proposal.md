## Why

A restarted runner leaves its old endpoint registered. Dispatch to that endpoint consumes workflow attempts even though no agent receives work. Runners must recover automatically without evicting other live processes on the same host or duplicating ambiguous writes.

## What Changes

- Expire endpoint registrations after a 60-second lease, refreshed by the existing 15-second hub announce.
- Probe authenticated callback health before writes; skip only definitive pre-connect failures.
- Never reroute an ambiguous POST reset/timeout. Keep conservative status/existence semantics and a bounded session-owner routing cache.
- Conclude undelivered dispatch runs into atomic durable bounded runner resource waits without consuming attempts. Repeated failed probes preserve the wait deadline.
- Expose registration expiry in the runner list and document deployment ordering.

## Capabilities

### New Capabilities
- `runner-registry`: endpoint leases, safe dispatch and durable unavailable-runner waits.

### Modified Capabilities
- None. Existing resource-wait policy and ordinary ambiguous failure handling are reused.

## Impact

Server registry, transport, engine, store and API; runner callback health route; tests and documentation. No DB migration, host identity, model gateway or configuration changes. Preserves the pure interpreter and self-hosted runtime-neutral architecture. Existing patient resource waits are reused for their bounded durable semantics, not compatibility with a seed format.
