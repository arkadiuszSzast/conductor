# Tasks — runner-protocol

## 1. Contract and schemas

- [ ] [runner][core] Define protocol versions, capability document, assignment envelope, session operations and stable error classes.
- [ ] [runner] Publish JSON Schema/OpenAPI definitions and generate/validate TypeScript wire types without coupling them to server internals.
- [ ] [test] Build a transport-independent runner conformance suite covering every contract scenario.

## 2. Daemon runner registry

- [ ] [db] Add additive runner identity, capability, heartbeat lease, assignment offer/claim and session-binding tables/indexes.
- [ ] [server] Implement authenticated registration, heartbeat expiry, capability matching and deterministic v1 runner selection.
- [ ] [server] Implement atomic assignment offer/claim, idempotent operation client and reconciliation of partial create/prompt effects.
- [ ] [test] Cover runner loss/return, two-runner claim race, lost responses, expired lease and incompatible capability diagnostics.

## 3. Reference opencode adapter

- [ ] [runner] Implement register/heartbeat plus create/prompt/status/note/cancel over the opencode SDK, preserving query-based directory routing.
- [ ] [runner] Inject daemon-backed report/gate/status tools in project roots and worktrees without hosting engine/store state.
- [ ] [test][runner] Pass the complete conformance suite and regression tests for multi-project routing and safe unknown status.

## 4. Security and operations

- [ ] [server][runner] Implement shared-token authentication, loopback defaults, canonical path allowlists, request deadlines and log redaction.
- [ ] [docs] Publish runner protocol, lifecycle diagrams, integration guide and a minimal mock runner example.
- [ ] [review] Perform security and failure-mode review, including runner impersonation, path escape, replay/idempotency abuse and prompt leakage.
