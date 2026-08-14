## 1. Contract and conformance

- [ ] 1.1 [runner][core] Define protocol versions, stable identity, capability document, assignment envelope, operation results and shared failure/resource mapping.
- [ ] 1.2 [runner] Publish JSON Schema/OpenAPI definitions and validate TypeScript wire types without coupling them to server internals.
- [ ] 1.3 [test][runner] Build a transport-independent conformance suite for versioning, capabilities, idempotency, safe status and cancellation.

## 2. Durable runner registry and selection

- [ ] 2.1 [db] Add additive runner identity, capability, heartbeat lease, assignment offer/claim, operation delivery and session-binding tables/indexes.
- [ ] 2.2 [server] Implement authenticated registration, stable identity upsert, heartbeat expiry, capability matching and deterministic selection.
- [ ] 2.3 [server] Emit availability-change wake-ups and reconcile matching blocked offers in bounded transactional batches.
- [ ] 2.4 [test] Cover daemon/runner restart, stale lease, incompatible runner, stable identity and reconnect wake-up without duplicate selection.

## 3. Assignment and operation delivery

- [ ] 3.1 [server] Persist self-contained unassigned offers when no compatible runner exists without creating or failing a run attempt.
- [ ] 3.2 [server] Implement atomic offer claim and bind exactly one runner/session attempt under lease.
- [ ] 3.3 [server] Implement idempotent create/prompt delivery and reconciliation for lost responses and partial effects.
- [ ] 3.4 [test][db] Cover two-runner claim race, lease expiry before acceptance, lost create/prompt responses and daemon crash boundaries.

## 4. Reference opencode adapter

- [ ] 4.1 [runner] Implement stable identity, register/heartbeat and capability publication in `runner-opencode`.
- [ ] 4.2 [runner] Implement idempotent create/prompt plus status/note/cancel over opencode while preserving exact project/worktree routing.
- [ ] 4.3 [runner] Map runtime/provider operation failures into shared classes and distinguish absence/compatibility before operation.
- [ ] 4.4 [test][runner] Pass the conformance suite and multi-project, safe-unknown, reconnect and duplicate-delivery regressions.

## 5. Security, operations and review

- [ ] 5.1 [server][runner] Enforce shared-token authentication, loopback defaults, canonical path allowlists, request deadlines and secret-safe logs.
- [ ] 5.2 [server][web][cli] Project leased runner compatibility and blocked assignment diagnostics consistently through health and feature activity.
- [ ] 5.3 [docs] Publish protocol, lifecycle diagrams, configuration, troubleshooting and a minimal mock runner.
- [ ] 5.4 [review] Review runner impersonation, path escape, replay/idempotency abuse, lease timing, reconnect storms and ownership boundary with retry-policy.
- [ ] 5.5 [fix] Run conformance and full repository tests, typecheck, lint and build before dogfooding offline-runner recovery.
