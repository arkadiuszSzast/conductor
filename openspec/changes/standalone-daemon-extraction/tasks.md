# Tasks — standalone-daemon-extraction

## 1. Extract the pure core

- [x] [core] Move pipeline types, pure interpreter, template renderer and structural validator from `opencode-conductor` into `@conductor/core` without semantic changes.
- [x] [test] Move interpreter, template and validator tests; preserve every existing case and test count.
- [x] [core] Define stable core exports and eliminate imports from Bun, filesystem, network, clock and SQLite.

## 2. Extract persistence and engine

- [x] [db] Move SQLite DB, store and existing additive migrations into `@conductor/server`; introduce an atomic migration ledger without destructive renames.
- [x] [server] Move engine, reconciler, actions, GitHub integration and findings publication behind explicit dependency interfaces.
- [x] [test] Move engine, store, built-in, preset and review-publishing tests; preserve all observed battle-scar behaviours.
- [x] [test][db] Add contract fixtures reproducing a historical conductor DB schema and prove in-flight state survives migration and restart.

## 3. Build the daemon API

- [x] [server] Implement configuration/project registry with safe validation and reload semantics.
- [x] [server] Implement daemon lifecycle: startup migration, reconciler heartbeat, readiness/liveness, graceful shutdown and structured logs.
- [x] [server] Implement versioned REST resources/commands for runs, reports, gates, findings and timeline plus SSE invalidation events.
- [x] [test] Add API contract, idempotency, authentication-boundary, recovery and graceful-shutdown integration tests.

## 4. Build clients and opencode adapter

- [x] [cli] Implement the API client and `conductor init/start/status/approve/request-changes/report/pause/resume/abandon/logs` commands.
- [x] [runner] Reduce the opencode plugin to runner registration, correctly routed session operations and daemon-backed Conductor tools.
- [x] [test][runner] Cover multi-project directory routing, missing/retrying/idle session states, duplicate reports and tool availability inside worktrees.

## 5. Execute conductor.yaml natively (greenfield pivot — replaces migration)

- [x] [server][db] Delete the seed pipeline engine (`packages/server/src/engine/`), seed config registry, bundled seed presets and their tests; rewire the daemon/API onto a graph engine that drives `@conductor/core`'s `interpret()` with a `WorkflowRegistry` loading `conductor.yaml`, persist graph `FeatureState`, and keep confirmation-of-effect, nudge/reap and atomic run conclusion on the new model.
- [x] [cli] Point `conductor init` at `conductor.yaml` scaffolding; remove the seed JSON template.
- [ ] [test] Adopt Conductor on a real project end to end (fresh repo + `conductor init` + daemon + opencode runner), including restart during an active run and a human-gate round trip.
- [ ] [docs] Publish daemon install/upgrade, API/OpenAPI and runner troubleshooting docs; document the greenfield pivot (no seed-format support).
- [ ] [review] Perform architecture and security review; verify no host-specific path, no model gateway and no seed-format remnant is embedded.
