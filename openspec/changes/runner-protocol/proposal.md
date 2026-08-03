## Why

A standalone orchestrator is only runtime-agnostic if connecting a new agent
runtime does not require importing the engine or emulating opencode. The seed
has a useful `SessionClient` interface (`createSession`, `prompt`, `status`,
`note`) but it is in the engine package and carries opencode-shaped assumptions
such as parent sessions, agents and model identifiers.

This change turns that seam into a documented, versioned runner protocol. A
runner is a disposable executor integration: Conductor assigns it an agent
step; it creates/prompts a runtime session and reports capability/status.
Workflow completion is reported independently through the daemon API/CLI,
keeping the engine's confirmation-of-effect rule universal.

## What Changes

- Minimal runner contract: register/heartbeat capabilities;
  create/prompt/status/note/cancel a session; stable error classification.
- Versioned HTTP wire protocol with correlation/idempotency IDs and leases so
  daemon/runner restarts do not duplicate sessions or lose assignment
  ownership.
- Agent task envelope: run ID, project/worktree directory, role/model/variant,
  prompt, report instructions, tool requirements, deadline/lease.
- Explicit capability negotiation; workflows fail readiness with diagnostics
  when no compatible runner is available.
- `@conductor/runner-opencode` as the reference implementation and protocol
  conformance suite for future Claude Code/raw API/other adapters.

## Non-goals

- No agent-loop or prompt-authoring framework.
- No remote multi-host scheduler in v1; the wire contract is network-clean but
  first deployment is same-host.
- No universal model naming standard; model strings are opaque runner config.
- No success inference from idle sessions — explicit report remains mandatory.
