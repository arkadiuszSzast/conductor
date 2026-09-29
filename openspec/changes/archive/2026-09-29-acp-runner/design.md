# ADR: Bounded daemon-managed ACP execution with durable uncertainty fencing

## Status

Implementation and blocking-review remediation are in progress under the user's authorization. This is not acceptance of the whole change; outstanding review and conformance work remains.

Stage 2 evidence gate is **WAIVED BY USER, NOT PASSED**. The instruction was: “możesz po prostu założyć że to działa i lecieć z implementacją. Przetestujemy to na żywym projekcie z opencodem”. Future live OpenCode testing is separate; this change does not authorize executing providers, reading host authentication, installing system tools, deploying or dogfooding during acceptance.

## Context

See proposal.md for motivation. Read against repository HEAD `05b09ff` and existing untracked `docs/acp-gap-analysis.md` (preserved). Stage 3 in `docs/development-roadmap.md` overlaps the unimplemented `runner-protocol` change. The spike's `REPORT.md` is reference evidence only, not production source: its later addenda supersede historical no-inference statements, record one functional Codex baseline with safety failures, and leave multi-runtime cancel/recovery unproven. Neither its implementation nor its safeguards are adopted wholesale.

Current seams and hazards:

- `ports.ts` defines SessionClient; `runner-transport.ts` routes through endpoint-keyed RunnerRegistry and applies a 10-second HTTP timeout. The registry already has 60-second leases, unlike the stale context in runner-protocol's design.
- `engine.ts:executeAgent` inserts a run before awaiting session creation, creates an unconditional feature parent, and concludes ordinary thrown errors as failed. Retry policy can then duplicate an operation whose response was lost.
- `attemptAnswerDelivery` claims durable answer intent but reclaims expired claims and retries transient errors; a token in prompt text is not receiver deduplication. `confirmAnswerDelivered` protects newer question generations and must retain that protection.
- `reconcileAgentRun` now nudges silent busy sessions as well as idle ones. Returning busy for unknown is therefore insufficient. TTL/reap dispatches step.failed and can automatically retry.
- `api.ts` has broad bearer authorization and shared engine.report authority; `main.ts` starts daemon recovery before binding HTTP. MCP reporting must be ready before new ACP dispatch, without making startup circular.
- Native sessions implement noReply notes and actual parent sessions. ACP 1 has neither portable equivalent; its prompt response arrives at turn completion, not acceptance.

## Goals / Non-Goals

**Goals:** one local daemon, explicit ACP profiles, one child process per attempt, bounded concurrency and resource cleanup; portable session mechanics and restricted MCP reporting; durable no-replay safety under crashes; unchanged native default; an operator-usable OpenCode recipe and deterministic integration tests.

**Non-goals:** distributed runner offers/leases, remote ACP transport, ACP 2/experimental methods, three-runtime certification, automatic conversation load/resume, automatic recovery of uncertain external effects, an OS filesystem/network sandbox, a new workflow DSL, a new scheduler or full native-hub rewrite. Scale target is current same-host workload roughly ×10, constrained by configurable process slots, not an unmeasured ×1000 service split.

## Decisions

### D1. Small direct adapter in server infrastructure

Implement `packages/server/src/acp/{sessions,connection,process,config,permissions}.ts` behind SessionClient. No new bounded domain/module package is warranted: this is daemon-owned infrastructure, not a new business context or deployment. ACP SDK imports stay in `acp/`. `packages/server/src/runner-router.ts` chooses an explicitly configured project route for NEW work, then immutable persisted run bindings for all subsequent operations. Keep `runner-transport.ts`, RunnerRegistry and runner-opencode as the native path. Never fail over a dispatched ACP attempt to native, another profile or another process.

`packages/server/src/runner-execution.ts` owns the transport-neutral safety service/contracts; Store implements persistence. `packages/server/src/run-auth.ts` owns credential verification; `run-reporting.ts` holds shared request validation/projection used by restricted and ordinary report endpoints. `packages/cli/src/report-mcp.ts` is the SDK-based stdio facade, not another ledger or engine. CLI imports server composition, server does not import CLI. Native runner retains its existing type-only dependency on server. No SDK, process or database dependency in core.

Alternative: wrap ACP behind a new HTTP hub and implement all runner-protocol tasks. Rejected: adds an unnecessary process and custom wire hop, inherits a wrong prompt timeout, and expands this bounded integration into remote offer/lease/idempotency infrastructure without an ACP receiver-side dedup primitive. Alternative: replace native outright. Rejected: unproven runtime coverage and loss of useful native behavior. Later extraction into runner-acp remains possible once another deployment actually needs it.

### D2. Stable documented protocol and exact package pins

Pin ACP SDK **1.5.0** in server and use only `@agentclientprotocol/sdk` root exports (`ClientSideConnection` or stable ClientApp surface, `ndJsonStream`); explicitly negotiate `protocolVersion: 1` and reject any different response. Do not trust a moving PROTOCOL_VERSION constant without asserting it is 1. No `/experimental/*`, unstable fork/provider APIs or draft status assumptions. The SDK's package version is independent of protocol major.

Pin MCP SDK **1.30.1** and Zod **4.6.5** in CLI for `McpServer` / `StdioServerTransport`; resolve exact workspace dependency ownership in package manifests and lockfile once, by the integration owner. These are design pins, not a claim of real runtime conformance. OpenCode **1.18.32** is the documented reference version from the report, operator-installed and operator-selected by absolute executable path; do not auto-download binaries or pin a gateway/model.

Documentation consulted via Context7 on 2026-09-27: `/agentclientprotocol/agent-client-protocol` (stable v1 initialize/prompt/cancel), `/anomalyco/opencode` (ACP CLI and configOptions), `/modelcontextprotocol/typescript-sdk/__branch__v1.x` (stdio/registerTool). Context7 also surfaced v2 examples: deliberately excluded. Exact ACP package metadata at <https://registry.npmjs.org/@agentclientprotocol/sdk/1.5.0> confirms stable root versus experimental/v2 exports; source commit `f1ba3a935df42efb4455be9b62c76b06610aaf50` documents long-lived prompt promises. Normative references: <https://agentclientprotocol.com/protocol/v1/initialization>, <https://agentclientprotocol.com/protocol/v1/prompt-turn>, <https://agentclientprotocol.com/protocol/v1/session-setup>, <https://opencode.ai/docs/acp/>, <https://opencode.ai/docs/cli/>. SDK upgrades require rerunning conformance, not widening ranges silently.

### D3. Explicit configuration and usable entrypoints

Add optional `runners` to daemon YAML and DaemonFileConfig, passed to DaemonConfig. Omitted section equals native-only. Initial selection is per configured project, not per workflow role: roles retain opaque agent/model strings, and ACP is preferred only on projects explicitly mapped to it. Exact project identity chooses a profile; canonical worktree directory must independently fall within that profile's allowedRoots (including sibling worktree roots explicitly). No longest-prefix fallback to an unrelated project.

Configuration contract/example (paths and role bindings are illustrative, not defaults):

```yaml
runners:
  default: native
  projects:
    /srv/work/my-project: opencode-acp
  acp:
    opencode-acp:
      command: /opt/opencode/bin/opencode
      args: [acp, --cwd, "{directory}"]
      allowedRoots: [/srv/work/my-project, /srv/worktrees/my-project]
      env: {HOME: /srv/agent-home, XDG_CONFIG_HOME: /srv/agent-config}
      inheritEnv: [PATH]
      maxConcurrent: 2
      deadlines: {startupMs: 30000, writeMs: 5000, turnMs: 3600000, cancelMs: 5000, killMs: 2000}
      permissions: {allowKinds: []}
      bindings:
        build: {mode: build}
  reportBridge:
    command: /opt/conductor/conductor
    args: [report-mcp]
```

Only whole argv element `{directory}` substitution is supported; no shell interpolation/evaluation. Strictly reject unknown fields, relative executable/roots, invalid limits, missing profiles, conflicting routes and forbidden inherited environment names. `bindings` keys are workflow `role.agent` values; each must map explicitly to an advertised session mode — either `modes` or a `mode` config option. Prefer an exact `modes.availableModes` match (using `session/set_mode` only when the current mode differs); otherwise require the exact value in a select config option with category or id `mode`, use `session/set_config_option`, and confirm its returned `currentValue` before prompting. Optional binding config-option selections are `{optionId: value}`; a workflow `role.model` must be selected unchanged through an advertised model-category option, never silently ignored or replaced. Missing/unsupported selection fails closed before prompt; no default-agent fallback. A runtime supporting only experimental setters is unsupported for such bindings.

The example uses deny-all permissions intentionally. Operator documentation explains enabling only needed kinds, the much weaker assurance of agent-owned tools, and configuring an isolated operator-managed OpenCode profile/provider separately. Conductor neither discovers nor copies host auth, and does not perform login. No live config/auth files are read in this change's tests. All environment passing is explicit; always remove daemon/runner admin tokens, even if named in inheritEnv. ACP mode requires bearer auth on the control API (reject auth:none for ACP); otherwise a worker could bypass its scoped MCP tools by calling an open localhost admin API. That is API least privilege, not protection from a same-UID process reading daemon files.

`conductor report-mcp` reads only injected `CONDUCTOR_RUN_URL`, `CONDUCTOR_RUN_ID`, `CONDUCTOR_RUN_TOKEN`; it must bypass normal CLI config/token discovery and daemon auto-start. stdout is protocol only. Source checkout recipe uses an absolute Bun executable plus absolute `packages/cli/src/main.ts` and `report-mcp`; compiled binary recipe uses the same subcommand. Both are tested without real OpenCode. Daemon resolves/passes its configured loopback reporting URL, with no wildcard-host URL handed to children.

### D4. Runtime-neutral contract additions, not a second runner wire protocol

Freeze types in `ports.ts` / `runner-execution.ts` before parallel work:

- `SessionStatus = busy | idle | retry | missing | unknown`; unknown has no idle/busy inference side effects. Native responses remain accepted; HTTP transport can map observation ambiguity explicitly to unknown.
- Optional per-assignment `prepare({projectDir,directory,agent,model?})` returns a bounded, one-use reservation and capabilities, or a structured unavailable/incompatible result. Engine holds an in-flight target guard while awaiting preparation and rechecks durable eligibility before inserting a run. Preparation launches/initializes a process but creates no session and sends no model prompt. Slots are bounded; restart reconstructs resource waits, not process handles. Unused reservations expire and are killed.
- `createSession` gains optional reservationId and operationId. ACP requires a runId and a durable create operation key. `prompt` gains optional operationId and purpose (`initial | answer | nudge`). Its result is `void` for existing native acceptance, or `{kind: submitted, operationId}` for ACP local submission; the latter is NOT remote acceptance. ACP completion is observed by `observeOperation(operationId)` returning `prepared | sending | submitted | completed | not_sent | unknown` plus bounded structured diagnostics/stop reason.
- Capabilities explicitly state parentSessions, nonInferentialNotes and prompt confirmation strength. Engine skips parent creation for ACP; no synthetic remote parent ID. `note` unsupported means append a Conductor timeline diagnostic, never send a prompt. Native parent/noReply behavior remains available.
- `RunnerOperationError` carries `delivery: not_sent | unknown`, a stable FailureClass where known, operationId and safe diagnostic. Never use exception-message regex to choose ACP retry safety. Unknown dominates any retryable classification. Resource-unavailable only applies when no execution-capable write occurred.
- `ManagedSessions` adds initialize/recover/stop and turn-task draining with bounded shutdown; injected process/clock/observation ports permit deterministic tests. SDK wire types never cross these contracts.

Alternative: leave Promise<void> semantically ambiguous and detach everything silently. Rejected because answer delivery would clear questions after a local write. Alternative: await the ACP turn in executeAgent. Rejected because it blocks engine/API/reconciler progress and MCP calls can need that same daemon while the turn is outstanding.

### D5. SQLite binding and operation journal before external writes

Add migrations via the existing migration chain (next available IDs, no renumbering). Proposed tables/columns:

- `runner_binding`: run_id primary/FK, transport (`native|acp`), profile_id, config_digest (nonsecret), directory, daemon_generation, opaque session_ref UNIQUE, remote_session_id nullable, process_generation, phase, created/updated timestamps. Persist ACP binding at run insertion, BEFORE process/session awaits, not merely after session creation. Existing untagged runs are native; new native attempts record native transport so config changes cannot reroute them.
- `runner_operation`: id primary, run_id FK, kind (`create|prompt|answer|nudge`), logical_key, payload_digest, phase (`prepared|sending|submitted|completed|not_sent|unknown`), owner_generation, stop_reason, diagnostic_code, timestamps. UNIQUE(run_id,kind,logical_key), plus at most one unresolved turn per binding. initial key is run id; answer key is answer_delivery.delivery_token; nudge key is durable ordinal. Never persist tokens/env in payloads; prompt data remains in existing work/answer state as needed.
- `runner_fence`: run_id primary, reason_code, operation_id nullable, cleanup_state, created_at, resolved_at, resolution_note. Durable fencing survives process/daemon exit.
- `run_credential`: id, run_id FK, attempt, process_generation, token_hash UNIQUE, issued_at, expires_at, revoked_at, revocation_reason. Store random high-entropy token digest only. No plaintext recovery requirement; restart revokes old ACP credentials and does not reconstruct them.
- Extend run status with `uncertain` (terminal for automatic execution, not an assertion of failure or success), update SQL checks, projections and exhaustive consumers. Extend answer_delivery with `submitted` and `unknown`; open uniqueness includes pending/claimed/submitted/unknown. Keep question_generation, notes and delivery_token intact.

Operation protocol: commit prepared; CAS to sending before entering the stream write; observe write completion as submitted; observe the matching response as completed. Sending is already potentially delivered—even a crash immediately before actual write is conservatively unknown. JSON-RPC IDs are correlation only. Duplicate logical keys with matching digest return existing state; differing payloads conflict. Same-process concurrent calls share the durable operation, not a second write. On restart, sending/submitted become unknown unless their completion was durably recorded; prepared (never entered write) can be retried only after safely rebuilding a pre-execution binding. Session/new response is committed before any prompt. If lost, fence rather than issuing another new; no durable ACP dedup is claimed.

Claims/observation updates include process generation and row version. A late callback cannot resurrect a concluded/recovered run. Records live with run history; credential hashes/tombstones remain long enough for audit/duplicate disposition (initial implementation retains with run, no new GC daemon). A single daemon owns the database under the existing deployment assumption; this is not a distributed locking design.

### D6. Unknown is a durable escalation, never ordinary failed routing

Add a pure `step.execution_unknown` event to core types/interpreter: marks the targeted step/job blocked/failed-for-recovery as appropriate to existing frontier types, sets feature escalated, emits no retry, no onFail continuation, and no downstream execution. The run itself records uncertain rather than failed. This event is only engine-issued; workers cannot request it as a way around gate policy. Store transaction `fenceRunnerExecution` atomically records run uncertainty, operation/answer unknown disposition, revokes credentials, applies the pure transition, closes automatic retry scheduling for the target and records timeline evidence. Use the existing durable dispatch/outbox discipline for any following effects, not a nontransactional setFeatureFields shortcut.

All routes check fences: initial dispatch, answer claims, nudge, TTL/reap, resource/retry claims, recovery dispatch and startup repair. Once ACP might have executed and no authoritative report arrived, EOF, process death, daemon restart, turn deadline, no-report timeout or cancellation cannot be treated as proof of no effects. Fence/escalate and request cleanup. Killing a process stops future work but cannot undo prior effects. A report committed before the fence wins by transaction ordering; a fence committed first rejects a late worker report. Valid report failures still enter existing explicit failure routing; uncertain transport does not.

For healthy ACP busy turns, do not enqueue native-style busy nudges: only one prompt may be in flight. `end_turn` without report records idle and allows an explicitly journaled idle nudge only while the same live connection still proves the turn ended. Exhaustion/TTL without report fences rather than automatic retry. `max_tokens`, refusal and cancelled are recorded turn reasons, not workflow outcomes. Generic native retry/nudge remains as today, except explicit unknown observations cannot trigger speculative prompting. No unconditional global modernization of native delivery semantics is claimed.

Operator recovery extends the existing recover endpoint/CLI with `acknowledgeUncertain: true` for fenced targets, requires notes, expectedVersion and idempotencyKey, and must reject plain resume/recover without acknowledgment. Recovery validates cleanup: confirmed stopped process group OR explicit operator confirmation that orphan cleanup was externally verified after a daemon crash. It records this evidence, leaves the old run uncertain, revokes all old credentials, and atomically rearms one NEW attempt through existing recovery_dispatch. It never resends an old operation or reuses old delivery tokens/credentials. Mixed multi-target recovery validates every selected uncertain target atomically. Existing CLI/UI callers lacking these fields receive actionable errors; add CLI flags and API projection, not a broad UI redesign. Abandon is always possible without starting replacement work.

Alternative: encode unknown as timeout/internal with zero retries. Rejected: user workflow onFail/rerun and existing retry routes can still restart work, and it falsely labels unknown effects as failure. Alternative: forever busy. Rejected: hides an operational incident and the current busy-silence path sends prompts.

### D7. Async ACP turns and answer delivery

`session/prompt` remains pending until stopReason. The adapter owns its promise and catches all asynchronous failures; engine calls return after bounded write submission and journal state, not turn completion. Timer domains are separate: startup bounds spawn/initialize/new/config/readiness; write bounds local stream progress; turn bounds the actual turn (default 60 minutes, configurable, never the HTTP hub's 10 seconds); cancel bounds cooperative stop; kill bounds forced termination. ACP callbacks have independent bounded handling; blocked permission requests resolve denied/cancelled within the write/cancel budget. Heartbeats and operator/API/MCP calls remain responsive throughout.

Answer flow:

1. Existing acceptAnswer persists notes and question generation; repeats conflict. Pending until previous turn conclusively ends on the same live connection (ask may arrive before end_turn). Never overlap prompts.
2. Claim checks active unfenced run, feature scheduling state and operation journal. Persist answer key before sending. `submitted` is open but non-reclaimable; lease expiry cannot send again.
3. Local submission returns accepted/in-progress, not delivered. Only the matching ACP prompt response records completion and permits existing generation-guarded question clearing. No new question is erased if ask N+1 arrives first. If a valid final report already concluded the run, settle/cancel the old delivery for audit without changing outcome.
4. Failure proven before any write can use existing bounded retry schedule. An unknown write, lost turn response or restart marks delivery unknown, retains original notes/question for diagnostics and fences the run. No scheduleAnswerDeliveryRetry and no failAnswerDelivery→step.failed for that case.
5. Restart after completed-operation commit but before confirmAnswerDelivered finishes the DB-only confirmation once, without new prompt; startup fencing of lost ACP execution still applies to an otherwise unfinished run. Completion of a turn alone does not prove completion of the step.

This explicitly replaces the at-least-once answer edge from `harden-interactive-answer-delivery` **for ACP**; native behavior is preserved. Automatic session/load/resume is deferred. Optional future context inspection must never clear a fence or prove effect nonoccurrence.

### D8. Run-scoped MCP, restricted auth and readiness

Expose three MCP tools: `conductor_report` (outcome/verdict/notes/review), `conductor_ask` (question), `conductor_status` (own run only). run_id is bound by injected credentials; if accepted as an optional compatibility field, mismatch is rejected. No start, answer, approve, request_changes, recover, runner registration or cross-run reads. Preserve full structured review payload validation and existing report conflict responses; do not reproduce gate policy in MCP.

Restricted daemon namespace: `POST /v1/worker/report`, `GET /v1/worker/status`, and internal `POST /v1/worker/ready`. Authenticate these routes with scoped credentials BEFORE broad API authorization; no admin token or auth:none bypass there. Resolve run/attempt/generation from the token hash, not request IDs. report delegates to the SAME validated engine.report path, ask maps to its ask branch, status returns a minimal own-run projection. ready accepts only a phase (`initialized|tools_listed`) for this bridge generation, not arbitrary state. No redirects; loopback default, bounded bodies/deadlines; redact authorization and MCP env everywhere.

Generate a random 256-bit token per attempt before session/new; store hash before injection into the uniquely named MCP server `conductor-<runId>` via its env. Credential remains valid while asking; renew expiry only through trusted daemon lifecycle, not a worker command. Revoke on terminal outcome, fence, replacement, abandon and shutdown/restart loss of ownership. Final report conclusion and revocation share a transaction. A retained hash revoked for normal conclusion may authorize ONLY the stable `run_already_concluded` rejection for a duplicate report (no engine mutation/read); expired, abandoned, fenced, superseded or wrong-attempt credentials return unauthorized. This permits explicit lost-report-ACK handling without leaving a mutation-capable token alive. Token race checks are revalidated at mutation commit, not merely before awaiting body parsing.

For duplicate asks, a current identical question is a no-op; bridge assigns an invocation id per MCP request and reuses it across bounded HTTP retries, daemon persists dedup scoped to run and question generation. Different late replay must not replace a newer accepted question; use current generation checks and preserve existing interactive-step guard. Add a small worker-request record if needed alongside credential storage, not a second outcomes table. Unknown HTTP outcome is queried through own status or retried with the same invocation id; tool errors never invent success.

Before first prompt, wait for the injected bridge's authenticated initialized + tools/list readiness signal and successful session creation/configuration within startup deadline. Merely spawning a bridge is not tool readiness. This proves that the runtime connected/listed the tools, not that a model will use them. Missing readiness fails closed with zero prompts. Same-cwd attempts use independent ACP processes and unique MCP names; deterministic tests assert no credential crossover. Runtime/profile collision concerns remain a live-testing risk, not assumed safe from ACP alone.

### D9. Permissions, process ownership and logging

Advertise no client filesystem or terminal capabilities initially. Reject unexpected fs/terminal/elicitation requests rather than implementing an accidental shell/filesystem service. `request_permission` defaults deny: only configured supported tool kinds can select an offered allow_once; never manufacture option IDs or grant allow_always. Missing kind/context, unknown session, revoked run, malformed option or timeout denies/cancels. Permission messages do not become workflow approvals or implicit ask operations.

Use a separate injectable duplex `AcpProcessSpawner`, not PluginProcessSpawner (which lacks stdin/stdout). Spawn argv directly with explicit env, canonical cwd and a dedicated POSIX process group; stdout is ACP framing only. Bounded frame sizes, stderr buffers, concurrent callbacks and update batching prevent runaway memory. Do not persist raw JSON-RPC, MCP env, tool arguments, provider error bodies or thought chunks; log structured operation/method IDs, safe codes and bounded sanitized summaries. Known injected secrets are redacted before any sink; fragmented output is bounded/sanitized before persistence. Activity notifications update existing run liveness through the Store without treating silence as idle.

On pause/abandon/fence/terminal report/shutdown, persist lifecycle intent first, then cancel pending permissions and send session/cancel, wait cancelMs, TERM process group, then KILL after killMs and record observed exit/cleanup uncertainty. A terminal report must not synchronously wait for its own ACP turn to end (deadlock); acknowledge committed result and perform cleanup asynchronously, draining these tasks before SQLite closes. Pause that interrupts an unreported ACP turn retains a fence; resume cannot replay it. Preparation cancellation also frees reservations. Never kill a reused PID after restart: persisted PID is diagnostic, not ownership proof. Unconfirmed orphan cleanup blocks replacement until operator acknowledgment.

This is bounded best-effort process-group cleanup, not a guarantee against escaped descendants. HOME/cwd, API scopes and ACP permission callbacks do not sandbox agent-owned tools. Use an operator-managed non-root OS account/container for stronger isolation; implementing such a sandbox is explicitly out of scope.

### D10. Daemon startup/shutdown and observability

Add an injectable session factory after Store migration so the managed adapter receives Store/Clock without a circular CLI dependency. Split daemon startup into initialize (database/registry/engine/session safety recovery) and activate (recovery dispatch + heartbeat). CLI composes API between them; initial health is alive but not ready. Restricted reporting listener is bound before activation and no ACP prompt is dispatched earlier. Existing Daemon.start convenience for socketless/native tests can call both phases; production ACP composition must follow the staged order.

Before activation reconcile, mark old-generation nonterminal ACP operations/bindings unknown and revoke credentials. Persisted session IDs do not establish a live process. Native sessions continue via their native transport even after config selection changes. Shutdown: stop new dispatch/heartbeat, retain restricted reporting during bounded worker cleanup, drain queued state writes, close API and SQLite last. Do not await a full turn deadline during stop. Startup failures clean up processes/listeners and leave durable uncertainty where writes may have happened.

Expose transport/profile, operation phase, unknown reason, cleanup state and required recovery action on run/feature/API/CLI projections; never tokens, env or raw configs. Health distinguishes configured, preparing, capacity-blocked and incompatible rather than equating config existence to availability. Timeline records permission denials, cancellation request/observed result, process exit and fences. Notify operator on execution uncertainty, credential misuse patterns and repeated readiness/config failures; no new pager service is introduced. Bounded slot/resource waits remain visible and consume no executable attempts before selection.

### D11. Explicit reconciliation with prior plans

Existing files are not changed or marked complete. This design is the authority for the ACP slice; runner-protocol remains unimplemented for the wider remote/native contract.

| runner-protocol decision/requirement | Disposition for this change |
|---|---|
| Stable identity + leased registration | **Deferred** for remote/native. ACP uses configured profile ID + durable run/process generation, not fake endpoint registration or lease survival. Existing native 60s/15s lease behavior preserved. |
| Daemon callback HTTP/media-type/version range | **Replaced for ACP only** with stable ACP 1 stdio negotiation; diagnostic gives requested/returned majors, not invented ranges. Native callback remains. |
| Durable offer before executable attempt | **Preserved outcome, narrower implementation**: existing resource_wait and bounded prepare reservation before run; no new distributed offer/accept queue. Post-session compatibility failure consumes setup attempt but never prompts; it is not represented as remote acceptance. |
| Idempotent create/prompt/redelivery | **Replaced for ACP** by local keyed operation journal and no replay of unknown. No receiver idempotence or original-effect lookup claim. Broader receiver-side native idempotency deferred. |
| Availability wake-up + heartbeat | **Preserved**: slot release can expedite reconcile; durable due resource waits remain correctness path. No ACP heartbeat invented. |
| Error ownership boundary | **Preserved**: adapter supplies structured safety/error facts, generic policy owns proven-safe retries; explicit unknown route bypasses retry. No ACP message regex classification. |
| Safe status + audited cancellation | **Preserved/strengthened** with explicit unknown, bounded cleanup and restart fence; no session/status invented. |
| Additive migration/rollback | **Preserved** as implementation convenience; no legacy compatibility obligation. Rollback cannot safely ignore new active ACP work. |
| Self-contained assignment/project routing | **Preserved**: exact cwd/run/role/model/instructions, strict roots and scoped MCP. No worker query into engine internals. |
| Atomic leased acceptance/two-runner race | **Deferred distributed mechanism**, preserved single-daemon atomic run claim, reservation and unique binding. |
| Parent sessions + non-inferential notes | **Optional for ACP**, absent native equivalent must not be emulated with inference; SQLite timeline preserved. Native supports both. |
| Conformance tasks 1.3 and quality 5.5 | **Preserved intent** with transport-independent capability-aware suite; unsupported guarantees tested as fail-closed, not asserted implemented. Full root checks mandatory. |

`harden-interactive-answer-delivery`: preserve durable acceptance, generation guards, native behavior and audit; replace ACP at-least-once replay with submitted/unknown dispositions. `retry-policy`: preserve budgets and explicit recovery, add a safety barrier outside retryable failures. `busy-silence-nudge`/`idle-silence-nudge`: native behavior remains, ACP busy turns cannot accept another prompt and uncertainty never permits one. `openspec/config.yaml` reporting decision is expanded by the MCP facade, not a competing authority. AGENTS.md greenfield constraints take precedence over stale additive-legacy language; no converters or compatibility format are added.

## Risks / Trade-offs

- [Real OpenCode full-turn/cancel/restart behavior unproven] → explicit user waiver, deterministic protocol/engine tests now, separate live project validation later; do not label multi-runtime compatible.
- [Crash between journal write and actual write] → conservative false-positive uncertainty; accepted loss of availability rather than duplicate external effects.
- [Same-UID worker can inspect host resources] → honest non-sandbox scope, deny-default API/callback policy, explicit env and operator isolation guidance. Security review is required before live use.
- [Stable ACP has no status query or receiver dedup] → durable ownership fence and manual recovery; the key accepted cost is less automatic recovery than native.
- [New run/answer dispositions affect consumers] → single-owner schema/types change, exhaustive API/CLI/web regression tests; never coerce uncertain to failed/succeeded.
- [Process-per-attempt overhead] → bounded configurable slots; no pooling before measured need. No new infra to host, back up or operate beyond existing SQLite plus local executables.
- [Secrets in arbitrary model output] → no raw protocol/argument/thought logging, allowlisted structured diagnostics; sanitization is defense in depth, not universal semantic detection.
- [Selection change during active work] → immutable binding by attempt. Disabling ACP only affects future dispatch; it cannot route an old session to native.

**What this makes harder later:** automatic seamless restart/resumption of an in-flight ACP attempt. That is an intentional consequence of refusing to assume receiver-side idempotence; adding it later requires genuine execution evidence, not just session/load.

## Migration Plan

1. Implement shared contracts/pure uncertainty route and additive DB dispositions first; no ACP enabled by default.
2. Add adapter and reporting bridge, integrate startup phases and API auth, then opt-in config routing. No running user's daemon/config is modified by this change.
3. Validate migrations from current schema, native records, empty DB and restart fault points; full root typecheck/lint/tests/build. Test both source and packaged entrypoints with deterministic fake peers.
4. Documentation describes operator-managed configuration and a later separately run OpenCode smoke test; do not run that test or claim deployment/dogfood here.
5. Future rollout: stop old daemon before migration, start upgraded daemon with native default, explicitly opt in a project. No rolling two-daemon ownership is supported. Rollback requires stop/cleanup and resolution or abandonment of all ACP attempts/deliveries; do not let old binaries retry unknown rows. Restore a pre-upgrade backup only with explicit operator acceptance of lost audit history. Preferred rollback is keep upgraded schema/code and select native for new work.

## Implementation notes

The adapter requires an injected operation Store, journals sending before execution writes, and records submission independently of asynchronous turn completion. Preparation precedes run insertion under a target guard; mode/config/model selection and bounded bridge-readiness waiting are implemented. Blocking-review remediation adds preparation liveness, unresolved-fence reconciliation protection, activity touches, startup completed-answer settlement and workflow-independent fencing with completion decisions. Process cleanup must prove group absence rather than leader exit — verified against a real spawned process with a TERM-ignoring descendant, not only a fake spawner's `groupAbsent()` contract.

A subsequent adversarial/security regression pass (tasks 6.1–6.4, 7.2) completed the requested matrices: a transport-independent conformance suite factory (in-memory and real NDJSON-framed stdio peers, plus native's actually-supported subset with explicit negatives); ACP-specific pause/resume/abandon interaction coverage including the fenced-resume's required-acknowledgment message at both the engine and HTTP API layers; specific `turn_deadline_exceeded`/`lost_create_response` fence-reason propagation (previously defined but never produced); and a client-capability security audit that found and fixed a critical gap — the pinned SDK's legacy `client()` wrapper unconditionally grants a fabricated success for `fs/read_text_file`/`fs/write_text_file`/`terminal/*` when the implementation omits them, rather than failing closed as D9 requires and the prior code's own (incorrect) comment assumed; every finding has a regression test proving the fix. This remains offline synthetic-peer verification, not live OpenCode compatibility, sandbox containment or deployment evidence — those stay explicitly out of scope for this change.

### Live-run corrections (2026-09-28/29)

Live OpenCode runs (a micro-project smoke and a full multi-agent production workflow) surfaced three defects that deterministic peers could not: (1) OpenCode advertises the agent mode only as a `mode` config option, not ACP `modes`, so mode selection accepts either advertisement and still fails closed; (2) OpenCode shell tools `setsid` their commands, so cleanup snapshots the whole `/proc` descendant tree before and after TERM and reports `confirmed_terminated` only when every observed descendant is gone; (3) selecting an OpenCode mode over ACP does not apply the mode's own model, so operators must bind `configOptions.model` per role. Operational notes are in `docs/install.md`.

Migrations 0022-0024 are intentionally **not** squashed: a production database has already applied them and the ledger requires an exact monotonic prefix, so a squash would make the daemon refuse to start.

## Open Questions

No blocking architecture decisions are left to the implementer. Later live testing will determine operational deadline/concurrency tuning and actual OpenCode profile/model compatibility; it does not change the fail-closed contract. Other runtimes and automatic conversation recovery are follow-up changes, not hidden tasks here.
