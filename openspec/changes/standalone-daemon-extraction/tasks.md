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
- [ ] [server] Implement daemon lifecycle: startup migration, reconciler heartbeat, readiness/liveness, graceful shutdown and structured logs.
- [ ] [server] Implement versioned REST resources/commands for runs, reports, gates, findings and timeline plus SSE invalidation events.
- [ ] [test] Add API contract, idempotency, authentication-boundary, recovery and graceful-shutdown integration tests.

## 4. Build clients and opencode adapter

- [ ] [cli] Implement the API client and `conductor init/start/status/approve/request-changes/report/pause/resume/abandon/logs` commands.
- [ ] [runner] Reduce the opencode plugin to runner registration, correctly routed session operations and daemon-backed Conductor tools.
- [ ] [test][runner] Cover multi-project directory routing, missing/retrying/idle session states, duplicate reports and tool availability inside worktrees.

## 5. Migrate and dogfood

- [ ] [cli] Implement `.opencode/conductor.json` → `conductor.yaml` conversion with validation and semantic warnings.
- [ ] [test] Canary the daemon on `conductor-test` and `quotes-api`, including restart during an active run and human-gate round trip.
- [ ] [db] Copy, migrate and verify the gloam conductor DB; retain a tested rollback path.
- [ ] [runner] Switch `gloam-idle` to the standalone daemon and new opencode adapter without losing in-flight features.
- [ ] [docs] Publish daemon install/upgrade/rollback, API/OpenAPI, configuration migration and runner troubleshooting docs.
- [ ] [review] Perform architecture, security and extraction-parity review; verify no host-specific path or model gateway is embedded.
