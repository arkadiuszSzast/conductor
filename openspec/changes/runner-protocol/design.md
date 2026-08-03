# Design — runner-protocol

## Context

`opencode-conductor` already abstracts a `SessionClient`, but the engine calls
it in-process and the interface is shaped by opencode SDK methods. Standalone
Conductor needs a transport boundary, lifecycle/availability semantics and
idempotency. It must preserve two safety rules: sessions are disposable, and
an agent step completes only through explicit report.

## Decisions

### Control direction

The runner is a registered service/callback endpoint; the daemon sends session
operations to it. The runner posts register/heartbeat/operation results; agent
reports go directly to daemon API/CLI. This avoids making runners authoritative
queues and keeps all assignment state in SQLite.

For same-host v1, the callback may listen on loopback or use a Unix socket
transport, with shared-token authentication and strict directory allowlists.
The protocol models URLs/identity independent of transport so a later remote
runner does not reshape the engine.

### Protocol shape

JSON over HTTP with a version media type (`application/vnd.conductor.runner-v1+json`).
Registration negotiates integer major protocol versions and publishes a typed
capability document. Every request has `request_id`, `idempotency_key`,
`runner_id`, `deadline` and correlation fields. Every response is success or a
stable classified error; message text is diagnostic only.

Session operations:

- `create(assignment, parent?) → session_ref`
- `prompt(session_ref, prompt envelope) → accepted`
- `status(session_ref) → busy|idle|retrying|missing`
- `note(session_ref, text, no_inference=true) → accepted`
- `cancel(session_ref, reason) → accepted|already_terminal`

Create and prompt are separate to preserve the seed's parent/fresh-session
semantics and recover independently from partial effects.

### Availability and assignment

Runners heartbeat a short availability lease. The daemon selects among
compatible runners (v1: configured priority/stable order, not load balancing),
creates a durable assignment offer and atomically claims it on acceptance.
Session ref is persisted before prompt. A lost create response is retried with
the same idempotency key. A lost prompt response is reconciled through status;
we do not blindly duplicate prompts.

### Error classification

Runner maps runtime/provider errors into the shared enum. Optional `retry_after`
is a hint bounded by daemon policy. `unknown` status is represented as a
transient operation failure, not converted to idle/busy by guess. This encodes
the existing safe-direction choice in protocol semantics.

### Security boundary

Runner registration requires an explicit configured credential; no unauthenticated
auto-discovery. Project/worktree paths are canonicalized and must fall under
configured roots. Assignment prompts and notes are data, never shell commands.
Tokens are redacted from logs. Callback bind defaults to loopback. Remote
runner mTLS/auth is intentionally deferred but the protocol does not assume
trusted public ingress.

## Alternatives considered

1. **Runner polls a task queue** — attractive for remote execution but adds
   lease/queue semantics before v1 needs them. The daemon-initiated callback is
   simpler; assignment still has a lease for correctness.
2. **gRPC** — strong contracts but adds codegen/runtime weight. JSON HTTP plus
   OpenAPI/JSON Schema is sufficient for initial integrations and CLI debug.
3. **Let idle mean success** — rejected: provider errors often leave idle
   sessions with no effect; explicit reports are the seed's key durability
   invariant.
4. **Standardize all model/provider names** — rejected: runners know their
   runtime; Conductor should not become a model gateway.

## Observability and conformance

Each operation emits duration/result/class metrics and correlated structured
logs without prompt/token content by default. A runner conformance suite runs
against any adapter: version negotiation, capability matching, idempotent
create, lost response, status ambiguity, cancellation, directory routing and
explicit-report lifecycle. `runner-opencode` is the reference implementation.
