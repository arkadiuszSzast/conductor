## Why

Operators should be able to run existing Conductor workflows through OpenCode's ACP entrypoint without a Conductor-specific runtime plugin, while retaining native integration as an escape hatch. The user explicitly waived the inconclusive Stage 2 compatibility gate and authorized production implementation after this preflight; that is permission to proceed, not evidence that compatibility passed.

## What Changes

- Add an opt-in, daemon-managed stable ACP 1 session adapter, with OpenCode as the documented first integration; native HTTP/plugin integration remains the default and available.
- Add explicit daemon runner configuration, process supervision, capability/model/mode validation, deny-default permission handling, and independently bounded startup, write, turn and cancellation lifecycles.
- Inject a portable stdio MCP reporting bridge exposing only report, ask and own-run status. Attempt-specific credentials authenticate restricted daemon routes; no daemon administrator credential goes to a worker.
- Persist attempt/session bindings, delivery intent, credentials as hashes, and execution uncertainty in SQLite. Fence and escalate ambiguous create/prompt/answer effects rather than entering automatic retry or replay.
- Preserve explicit reporting as completion authority: ACP `end_turn` is not workflow success; conversation recovery is not execution resumption. Parent sessions and runtime notes are optional; Conductor's timeline remains authoritative.
- Reconcile the overlapping, unimplemented `runner-protocol` proposal explicitly in this change's design: preserve safety goals, replace ACP-side HTTP callback assumptions, defer distributed runner identity/lease/offer machinery. Do not edit or claim completion of that backlog.
- Provide deterministic transport-independent conformance and daemon composition tests plus full repository quality checks. No dogfood, deployment, live inference, provider/auth inspection or spike execution belongs to this change's acceptance run.

## Capabilities

### New Capabilities

- `acp-execution`: Configured ACP 1 sessions, capability negotiation, asynchronous turns, permissions, cancellation and native coexistence.
- `runner-execution-safety`: Durable operation identity, unknown-effect fencing, conservative restart handling and explicit operator recovery.
- `run-scoped-reporting`: Least-privilege MCP report/ask/status backed by existing engine authority and attempt-scoped credentials.

### Modified Capabilities

- `daemon-entrypoint`: Add explicitly configured runner composition and a packaged stdio MCP bridge entrypoint without changing the native default.
- `interactive-steps`: Clarify asynchronous answer confirmation and prohibit replay/failure retry for ambiguous ACP delivery or lost ACP execution ownership.

## Impact

- Code: `packages/server/src/{ports,engine,store,migrations,daemon,api}.ts`, new focused `acp/` adapter and runner-safety/reporting modules, CLI configuration/composition/bridge entrypoint, corresponding tests and existing operator documentation. Core receives only pure execution-uncertainty routing if needed; no SDK or I/O crosses into the interpreter. Native runner changes are limited to port compatibility and regression fixes required by this contract, not a wholesale hub rewrite.
- Dependencies: pin `@agentclientprotocol/sdk` to `1.5.0`, stable root entrypoint only; pin MCP SDK to `1.30.1` and compatible Zod to `4.6.5` for the bridge. Exact pins and lockfile are implementation tasks; no packages are installed during preflight.
- SQLite: additive attempt binding, operation, fence and credential records; extend answer-delivery dispositions and projections. No legacy converter is needed. Preserve existing native behavior and existing records by explicit transport tagging; do not fabricate ACP ownership for pre-existing sessions.
- Config: existing daemon and gloam-idle native configs require no changes. ACP is explicit opt-in with executable, argv, allowed roots, environment/profile selection, concurrency and deadlines. No host-specific model, gateway or authentication assumption is introduced.
- Confirmed decisions reopened narrowly: HTTP API/CLI reporting gains a portable MCP facade over the same authority; the mandatory parent/note/session assumptions become capability-aware; the package layout is preserved by placing this small adapter within server infrastructure. `conductor.yaml` remains the only workflow format.
- Carry-overs retained because useful: SessionClient dependency inversion, disposable executors, SQLite completion claims/outbox, structured review/findings, interactive question generations, bounded retry/resource wait, and confirmation-of-effect. Native nudge/reap remains; ACP uncertainty overrides nudge/reap-to-retry because silence cannot prove safe execution loss.
- Fits standalone/runtime-neutral execution and resilience pillars. Does not add a broker, distributed scheduler, hosted service, agent framework, filesystem sandbox, universal runtime compatibility claim, or task-graph backlog system.
