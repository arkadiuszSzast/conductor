# ACP vs `runner-protocol` / `SessionClient` — gap analysis

> **Status: advisory note, NOT an approved plan.** This is
> the Stage 1 deliverable from `docs/development-roadmap.md` ("Track A —
> Stage 1 — Design review (read-only)"). It does not change code, does not
> contain commits, and does not replace `openspec/changes/runner-protocol/`.
> Every recommendation below requires a separate OpenSpec proposal before
> it becomes actionable (`AGENTS.md`, `openspec/config.yaml`).

Analysis date: 2026-09-25. ACP sources fetched the same day (links in the
[Sources](#sources) section); SDK/CLI versions **observed** via
`registry.npmjs.org` the same day — this is a point-in-time snapshot, **not**
a version pin/decision (pinning is a Stage 2 task) and not a
guarantee of immutability (ACP v1 received ≥15 stabilized RFDs over the
past year, see [`rfds/updates`](https://agentclientprotocol.com/rfds/updates.md)).

## 1. Purpose and scope

Compare the `SessionClient` boundary (`packages/server/src/ports.ts:112-141`)
and the unfinished `runner-protocol` contract
(`openspec/changes/runner-protocol/{proposal,design,tasks}.md`, **0/20
tasks completed** — verified with `grep -c '\[x\]' tasks.md` = 0) against
the Agent Client Protocol (ACP) in its stable v1 version (major=1) and the v2
draft (draft, 2026-07-20). Goal: for every design decision and every
requirement of the three `runner-protocol` specs, establish explicit **yes /
partial / no** coverage by ACP, identify the architectural and
operational boundaries that ACP **cannot** take over without
changing Conductor's foundations, and give a "preserve/change/replace" recommendation
— **not** "build a competing protocol".

### Methodology

- Code: `packages/server/src/{ports,runner-transport,runner-registry,engine}.ts`,
  `packages/runner-opencode/src/{sessions,hub,plugin,tools}.ts`,
  `packages/server/src/{migrations,store}.ts` (the `answer_delivery` fragments).
- Spec/design: `openspec/changes/runner-protocol/{proposal,design,tasks}.md`
  and all three `specs/*/spec.md`; context from `openspec/config.yaml` and
  `AGENTS.md`; status of the neighbouring changes `runner-liveness` (**8/8 shipped**)
  and `retry-policy` (**25/25 shipped**) as the reference point for what
  `runner-protocol` is meant to replace/extend.
- ACP: the `protocol/v1/*` pages (stable), `protocol/v2/*` (draft),
  `rfds/updates` (stabilization history), `announcements/acp-v2-draft`.
  Package versions **observed** (not pinned — see below) on
  `registry.npmjs.org` 2026-09-25: `@agentclientprotocol/sdk@1.5.0`,
  `opencode-ai@1.18.32`, `@agentclientprotocol/codex-acp@1.13.1`
  (dependency `@openai/codex@^0.156.1`), `@google/gemini-cli@0.61.0`.
- No SDK/runtime compatibility tests were run — that requires
  Stage 2 (spike). No package version in this note is a
  "pin" or a decision — they are point-in-time snapshots from the npm registry,
  to be verified/pinned only in Stage 2.

**SDK numbering vs protocol numbering (do not confuse):** `protocolVersion`
in `initialize` is a single integer identifying the **major
protocol version** (today `1`, [`initialization.md`](https://agentclientprotocol.com/protocol/v1/initialization.md):
"a single integer that identifies a MAJOR protocol version"). The SDKs have
their **own, independent** semver release numbers — `@agentclientprotocol/sdk`
at version `1.5.0` implements `protocolVersion: 1` (stable) and,
partially/experimentally, draft v2 artifacts (the SDK documents a separate,
unstable entry point for v2 — treat it as an opt-in experiment, not
the default path). Likewise Rust SDK `1.0.0`/Python SDK `0.12.1` or
`1.0rc2` are package numbering, not protocol numbering — an SDK at version `≥1.0.0` does not
mean "supports protocol v2", only "stable package API for
protocol v1". This note deliberately does **not** analyse the Rust/Python SDKs beyond
this single remark — that stays out of scope, so as not to dilute the focus on
TypeScript/Bun (in line with Conductor's stack).

**Role of Context7 in this analysis:** Context7 queries (run before this
revision) were used to **discover** candidate libraries/documentation
(e.g. confirming the existence and location of `@agentclientprotocol/sdk`,
`opencode-ai`, the OpenCode ACP documentation) — **not** as the deciding
source for any claim in this note. All
concrete protocol quotes/requirements rely on directly fetched
`agentclientprotocol.com` pages and tagged GitHub/npm sources
(links in the text and in the [Sources](#sources) section) — Context7 was a navigation
tool; the official/tagged sources are authoritative.

### Note on project context (no reopening)

`AGENTS.md` declares "Greenfield, no legacy obligations" — any part of
`opencode-conductor` may be replaced. `openspec/config.yaml` at the
same time contains "The DB schema is adopted additively: in-flight conductor
features survive the migration to the standalone daemon" and a list of
"Confirmed decisions (do not reopen without a proposal)" — including
"Agent report-back is the daemon's HTTP API plus a `conductor` CLI — a
runner only needs createSession/prompt/status/note." That last sentence
**is** exactly the `SessionClient` boundary this note examines — the mere
existence of that "confirmed decision" does not predetermine the outcome of Stage 1, but every
"replace" recommendation below conflicts with it and would require explicitly
reopening that decision in an OpenSpec proposal, not quietly working around it.

---

## 2. Map: what is implemented today

### 2.1 `SessionClient` — the port boundary (implemented, in the repo today — "production" here means: code on `main`, not "deployed/operated")

`packages/server/src/ports.ts:112-141` defines **six** operations:

| Operation | Signature | Semantics |
|---|---|---|
| `createSession` | `{title, directory, parentID?, runId?}` → `Promise<{id}>` | **Awaits the `id`** before the engine proceeds (`engine.ts:491-508`) — this is NOT fire-and-forget: the caller waits for the HTTP response with the created `id`; there is just no separate durable confirmed-delivery layer on top of that `await`. `runId` is an optional logging hint (see 2.4). |
| `prompt` | `{sessionID, text, agent?, model?}` → `Promise<void>` | The engine **awaits** the call (`engine.ts:530`), but the return only carries "the HTTP request succeeded", not "the agent processed/finished" — no retry or idempotency key at the port level. |
| `sessionExists` | `sessionID` → `Promise<boolean>` | Conservative: uncertainty → `true`. |
| `status` | `sessionID` → `Promise<"busy"\|"idle"\|"retry"\|"missing">` | `"retry"` = provider retrying (treated as busy by callers); uncertainty → `"busy"`. |
| `note` | `{sessionID, text}` → `Promise<void>` | Append **without invoking model inference** (`noReply`) — this is NOT a promise of "zero tokens, always"; it depends on the runner implementation on the other side of the port (the port contract only guarantees the absence of an *explicit* reply request). |
| `abort` | `sessionID` → `Promise<void>` | Best-effort; no-op on a finished/nonexistent session. |

Key point: **`note` is not called by `engine.ts` at all today**
(`grep -n "sessions\.\(note\|abort\|...\)" engine.ts` → no hit for
`note`). The port contract declares the operation, the engine does not use it — the same
is observed by the runner-protocol `design.md` ("Timeline notes do not trigger
inference" — see section 4; the requirement remains valid despite the absence of a current
call).

### 2.2 `runner-transport.ts` — the port implementation over HTTP (`packages/server/src/runner-transport.ts`)

- `NoLiveRunnerError` (lines 11-16) — a dedicated type for "no live
  runner"; caught by `engine.ts` to distinguish resource-wait from
  an ordinary failure (see 2.4).
- `probe()` (66-78): **health pre-probe** before every write —
  `GET /v1/health`, 10s timeout (`AbortSignal.timeout(10_000)`, line 57).
  Only *definitive* pre-connect errors (`ECONNREFUSED`, `ENOTFOUND`,
  `EAI_AGAIN`, `ConnectionRefused` — `isDefinitivePreConnectFailure`,
  lines 18-22) allow skipping a runner; everything else throws
  `NoLiveRunnerError` **without sending the write**.
- `write()` (79-88) and `sessionWrite()` (89-103): **an ambiguous POST failure
  is NOT replayed** against another runner — if the write already went out and
  the response was lost, the transport does not guess, it just propagates the error.
  The `runner-liveness` spec states this explicitly: "Ambiguous POST
  failures SHALL NOT be replayed against another endpoint by the
  transport."
- `owners` (line 41, LRU up to 1024 entries, line 45): an **in-memory**
  sessionID→runnerID map, non-durable, does not survive a daemon restart.
- `read()` (104-124): for `status`/`exists`, uncertainty (no known
  owner, error, invalid value) → `unknown→busy` /
  `unknown→true` (safe direction), in line with the port contract.
- `routeForDirectory()` (24-37): runner selection by the longest project
  path prefix — **not** by capability matching (because capabilities do not
  exist in today's registry).

### 2.3 `runner-registry.ts` — in-memory registry (`packages/server/src/runner-registry.ts`)

- Registration key: the **endpoint** (URL), not a stable runner identity
  (line `this.registrations.get(endpoint)`, around lines 44-52). A runner
  restart on a different port = a new identity.
- Lease: **60 000 ms** (`leaseMs = 60_000`, constructor, line 29),
  refreshed by the hub re-announce every **15 000 ms**
  (`DEFAULT_REANNOUNCE_MS = 15_000`, `packages/runner-opencode/src/hub.ts:81`).
- `list()` (around lines 82-86) removes expired registrations on every
  read (lazy expiry), not via a separate timer.
- **No** capabilities, protocol version, or stable identity beyond the
  endpoint — this is exactly the gap that the `runner-protocol` design.md
  names "Alternative: retain endpoint-keyed in-memory identity. Rejected
  because ephemeral ports and daemon restarts create false identities and
  stale availability."
- **Everything is in process memory** — daemon restart = empty registry
  (healed only by the hub re-announce, not by a durable record).

### 2.4 `engine.ts` — orchestration around the port

- **Lines 418-435** (`executeAgent`): `this.deps.runnerAvailable?.() === false`
  → **before** creating a run, records `resource_wait` with reason
  `"runner_unavailable"` via `decideResourceWaitRoute` (a pure
  interpreter function) and **returns without creating a run**. This is the "no
  runner at all" path — zero-attempt.
- **Lines 471-567**: when a runner is registered, the engine **first
  inserts the run** (`store.insertRun`, line 475 — *before* any
  `await`; a code comment explains this as closing a race with a
  concurrent reconcile), then creates the parent/child session
  (`createSession` ×2, lines 491-508) and only then `prompt` (line
  530). If `sessions.prompt` throws `NoLiveRunnerError` (line 548),
  the run is **rolled back** to `resource_wait` via
  `concludeRunForResourceWait` (lines 556-561) — **without consuming
  an attempt**. If it throws **any other** error (e.g. an ambiguous POST from
  `runner-transport.ts`), the run ends as `"failed"` with classification via
  `classifyThrownBoundary` (line 565) — **this consumes an attempt and can
  lead to duplicates**, because `createSession`/`prompt` may have
  actually executed on the runner side before the error reached the engine.
  **This is a real gap**, which the `runner-protocol` design.md explicitly
  addresses ("Idempotent create and prompt state machine... Lost create
  responses are redelivered with the same key... never blind fresh
  prompting").
- **Line 2279** (`classifyThrownBoundary`): error classification via
  **regex on the message text** (`/ECONNREFUSED|.../i`,
  `/429|rate limit.../i`, `/502|503|504.../i`, `/timeout|timed out/i`,
  fallback `"internal"`). This **directly contradicts** the rule in
  `runner-contract/spec.md`: "The engine SHALL apply the generic policy
  from `retry-policy` and SHALL NOT parse message text." Today's code
  does exactly what the planned design forbids — a gap between the current
  and the designed state, not an ACP gap.
- **Lines 1654-1664** (`pause`/`abandon`): both methods call **only**
  `this.dispatch(featureId, {kind: "human.paused"/"human.abandoned"})` —
  **neither calls `sessions.abort`**. The durable state (SQLite) changes
  immediately. `abort` is **not guaranteed** within any specific
  time frame after that: `reconcileFeature` (line 1693: `if (input.status ===
  "paused") return`) **skips** all subsequent reconcile steps for a
  paused feature — including `reconcileTtl`/`reap`, which are the only
  place that calls `abort` (see below). For `pause`, the runner may therefore
  remain un-aborted indefinitely (until the feature is
  resumed and only then possibly reaped after the TTL); for `abandon`
  (`feature.status === "abandoned"` checked at the start of `reconcileFeature`,
  line 1855) reconcile also returns early. Neither of the two paths
  guarantees session cancellation within any time window — this is
  best-effort without a deadline, not "sooner or later reap will clean up anyway".
- **Lines 2112-2135** (`reap`): the only place that calls
  `sessions.abort` (line 2125), and it is **best-effort in a try/catch** —
  an abort error is logged and never blocks the run's conclusion. The ordering
  is intentional: abort **before** conclude (code comment: if the
  daemon died between them, reconcile would reap the still-active run again;
  the reverse order would leave an orphaned session burning tokens).
- Only **when** the agent explicitly calls `report()` with `outcome`/
  `verdict` (`engine.ts:1013`, see section 5.5) does the engine consider the step
  finished — never based on `status: idle` from the port. `ask` (the same
  `report()` method, branch `input.ask !== undefined`, `engine.ts:1039-1062`)
  **does not finish** the step — `store.setRunQuestion` leaves the run in the
  `"running"` state and **parks** it on a question to the human; the step ends
  only with a later, separate `report()` call with `outcome`/`verdict`.

### 2.5 `packages/runner-opencode/` — the only adapter today

- `sessions.ts` (204 lines) implements `SessionClient` over the opencode
  SDK. `status()` (lines 155-202) has multi-layered "safe
  direction" logic: `lookup unknown → busy` (161), timeline unreachable →
  `busy` (193-197), no assistant message within a window of 5 → `busy` (189),
  last message without a `completed` timestamp or with a pending/running tool
  → `busy` (190-192). This is exactly the behaviour that
  `runner-lifecycle/spec.md` wants to standardize as "Unknown status is
  handled in the safe direction" — **implemented today
  opencode-specifically, not as a contract**.
- `hub.ts`: a single opencode process can serve many project
  directories (routing by longest prefix, `isPathPrefix`,
  lines 71-73); re-announce every 15s (line 81); auth via a fixed token
  or `CONDUCTOR_RUNNER_AUTH=none` (`authorized`, lines 66-70,
  `timingSafeEqual`).
- `plugin.ts`: registers `conductor_start/report/ask/status/approve/
  request_changes` as **opencode plugin tools**
  (`tool.schema.*` from `@opencode-ai/plugin`, lines 110-191) — **not as a
  run-scoped MCP server**. `tools.ts` implements them as simple
  HTTP calls to `ApiClient` (the daemon REST API), not to the internal
  engine. That means: reporting goes through the **daemon's CLI/HTTP API**,
  not through the agent protocol.
- The `note` port **exists** in `sessions.ts` (`noReply: true`,
  `session.promptAsync`) but — as in 2.1 — the engine does not call it.

### 2.6 Delivery of human answers — `answer_delivery` (SQLite, at-least-once)

`packages/server/src/migrations.ts:456-531` (migration `0014_answer_delivery`
+ `0015_answer_delivery_retry_schedule`): an `answer_delivery` table with
`delivery_token` (line 483, comment: "Conductor's own idempotency
marker, carried into the prompt so an opencode-side dedup can [happen]"),
a unique index `idx_answer_delivery_open_run` on `(run_id) WHERE status
IN ('pending','claimed')` (497-498) — **one open delivery per run**.
`store.ts:1168` checks dedup before insert; `engine.ts:1214` embeds
`[conductor delivery <token>]` in the prompt. This is **at-least-once with a
Conductor-side token** — **the runtime (opencode) does not dedup
on its own**; the token exists so that the *agent* can recognize it in the
content, not so that the transport protocol guarantees dedup.

### 2.7 Status of `runner-protocol` and neighbouring OpenSpec changes

| Change | Tasks | Status |
|---|---|---|
| `runner-protocol` | 0/20 (`grep -c '\[x\]'` = 0) | **Implementation not started.** `proposal.md`/`design.md`/`tasks.md` exist, the code does not. |
| `runner-liveness` | 8/8 | **Shipped.** Delivered the 60s lease + 15s re-announce + health-probe + ambiguous-write semantics described in 2.2-2.3 — this is the **current state**, not a plan. |
| `retry-policy` | 25/25 | **Shipped.** Delivered `FailureClass`, `resource_wait`, `recover()` with optimistic concurrency (`engine.ts:1490-1529`) — the general mechanism that the `runner-protocol` design.md cites as the owner of retry/budget/escalation. |

**Note on the freshness of `design.md`:** the runner-protocol `design.md` describes
"Decisions" (identity/lease, offer before attempt, idempotent
create/prompt) as if today's state were purely in-memory without a lease —
but `runner-liveness` (shipped) **already introduced** the 60s lease/15s
re-announce/health-probe/ambiguous-write-no-replay, which partially
covers the motivation of `design.md` (though not durable identity, not capability
matching, not idempotent create/prompt). **`design.md` is partially
out of date relative to the repo state** — context to take into account in any
revision of `runner-protocol`, not a reason to close it.

---

## 3. Coverage table: the 8 design decisions of `design.md`

Legend: **Yes** = stable ACP v1 covers the intent directly; **Partial**
= ACP provides a primitive, but weaker/optional/without the guarantees that
`runner-protocol` requires; **No** = ACP has no counterpart **at the protocol
layer** — even if the decision is internal to Conductor (e.g.
SQLite migrations), we classify it as **No** (ACP cannot cover it by
definition), not as "not applicable" — every row must have one of the
three values, without exception.

| # | Decision (`design.md`) | ACP | Rationale |
|---|---|---|---|
| 1 | Durable stable identity + leased registration | **No** | ACP `initialize` has `agentCapabilities`/`agentInfo`, but `agentInfo` is **not an identity** ([`initialization.md`](https://agentclientprotocol.com/protocol/v1/initialization.md): "Both take the following three fields... Intended for programmatic or logical use") — there is no stable ID surviving a process restart, and no lease at all. (Capability negotiation as a separate matter is assessed below, row 4.3 — here it is solely about identity+lease, which ACP does not have.) ACP has no notion of "a registry of many agents with a heartbeat" — it is a 1:1 client↔process model where the process is launched by the client (stdio transport), not an N:1 model (many projects through one registered runner, like `runner-opencode`). Stable identity and lease remain entirely Conductor's responsibility. |
| 2 | Daemon-initiated callback protocol (JSON HTTP, versioned media type) | **No** | ACP is **client-initiated at the connection level**: the client (Conductor as an ACP client) launches the agent as a subprocess over stdio ([`transports.md`](https://agentclientprotocol.com/protocol/v1/transports.md): "The client launches the agent as a subprocess... All Agents MUST support stdio"). This does NOT contradict today's daemon→runner callback direction — on the contrary, it is **consistent** with it: Conductor as an ACP client already initiates the connection to the runner today (today's `runner-transport.ts` POSTs to the runner's endpoint, exactly as an ACP client launches/connects to an agent). The difference lies elsewhere: (a) today's callback is a **custom wire format** (ad-hoc JSON HTTP), not ACP's JSON-RPC-over-stdio — that is what would be replaced, not the direction; (b) the **reverse** direction (runner→daemon) **already exists today**, not only in the planned `runner-protocol` — `hub.ts` already POSTs registration+heartbeat to the daemon today (`announce()`, `hub.ts:204-212`, called from `registerProject`/the re-announce timer, `hub.ts:138-158`, every 15s); however, this is **in-memory, endpoint-keyed** (section 2.3), not the durable/stable identity that `runner-protocol` demands. The "runner announces itself to a registry" direction itself therefore **exists** in Conductor — ACP does not define it as part of the agent↔client protocol (it has no notion of "a registry of many agents", see decision #1), but this is not a gap of "something that does not exist today", only a gap of "ACP does not standardize this pattern, which Conductor already has via its own mechanism". Once the connection is established, ACP **is** bidirectional within that one session: the agent can send requests to the client (`session/request_permission`, `fs/read_text_file`/`fs/write_text_file`, `terminal/*`, `elicitation/create`), not just push `session/update` — but this is still within the connection the client initiated, not a new outbound connection initiated by the agent. A remote HTTP transport for ACP itself (not to be confused with MCP-over-HTTP, see 4.1/4.3) is a separate RFD "Streamable HTTP & WebSocket Transport" — status **Active** (moved from Draft on 2026-07-02, verified via [`rfds/updates`](https://agentclientprotocol.com/rfds/updates.md)), and thus a current focus of the maintainers, but **not stable/completed** — treat it as an unstable proposal in motion, not as "still Draft". |
| 3 | Durable offer precedes executable run attempt (`wait_resource` before an attempt is created) | **No** | ACP has no notion of "runner offline" as a protocol state — the connection either exists (because the client opened it) or does not. There is no "durable assignment offer" waiting for a remote agent to become available; this is a purely orchestration-level Conductor concept, consistent with `retry-policy`'s `resource_wait`, with no counterpart in ACP. |
| 4 | Idempotent create/prompt state machine (idempotency key, redelivery, no blind resend) | **No** | ACP has **no** idempotency-key field on `session/new`/`session/prompt` in either v1 or v2. ACP v2 `prompt-lifecycle.md` explicitly admits the lack of a guarantee: "If the response is lost, the submission's outcome remains uncertain: replay may omit live-only or discarded messages, and a retry can create another submission." `messageId`/`toolCallId`/`_meta` serve **correlation**, not deduplication ([`extensibility.md`](https://agentclientprotocol.com/protocol/v1/extensibility.md): "JSON-RPC id correlation"). Embedding `run_id` in the prompt content and relying on `conductor_report` as confirmation **does not make `create`/`prompt` itself idempotent** — it works around the problem via an external mechanism (exactly the kind Conductor already has in `answer_delivery`, section 2.6), not a solution at the protocol layer. Hence **No**, not "Partial" — ACP provides no primitive in this direction, it only names the problem. |
| 5 | Availability wake-up as an optimization, heartbeat as correctness | **No** | Without a multi-agent registry model (see #1) there is nothing to "wake up" — ACP does not define a "new agent available" event. |
| 6 | Error ownership boundary (`compatible_runner_unavailable` as a resource reason, not an operation failure; the rest mapped to `FailureClass`, without text parsing) | **Partial** | ACP has `StopReason` (`prompt-turn.md`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) — a closed, small set of **turn conclusions**, not a general taxonomy of execution errors. Transport errors are plain JSON-RPC errors (code + `message` string) — without a standardized `transient_upstream`/`capacity`/`timeout` class in the style of `retry-policy`. Mapping onto Conductor's `FailureClass` still requires adapter-side logic (today: regex on text in `classifyThrownBoundary`, `engine.ts:2279` — and that already violates Conductor's own "no message parsing" rule today, independently of ACP). |
| 7 | Safe status and cancellation (unknown→no nudge/reap; cancel best-effort, audited) | **Partial** | Cancellation: `cancellation.md`/`prompt-turn.md` — `$/cancel_request` and `session/cancel` are **best-effort**, "MAY cancel", the agent "SHOULD stop... as soon as possible" — directionally consistent with Conductor's "best-effort", but **auditing (request+observed result) remains entirely Conductor's responsibility** — ACP neither logs nor guarantees any durable record of the cancellation result. Status: ACP **has no `session/status` method** at all — there is only the `session/update` stream (push) and the `session/prompt` response at the end of a turn (`stopReason`, v1 only; in v2 via `state_update`). There is no way to **query** "is session X busy/idle/retry/missing" other than by observing the live stream — and inferring state from the `session/update` history **is not** a safe replacement: silence in the stream is just as ambiguous as today's "uncertainty" (it does not distinguish "long-running tool" from "lost connection" from "nothing was ever going to arrive"). This is a significant gap relative to the `runner-lifecycle/spec.md` requirement "Status SHALL distinguish busy, idle, provider-retrying and missing." |
| 8 | Migration (additive, no destructive rollback) | **No** | A purely internal Conductor decision (SQLite migrations) — ACP by definition has no role here, so coverage is **No**, not "not applicable": ACP cannot cover this decision, just as it does not cover 1/2/3/4/5. |

---

## 4. Coverage table: requirements of the three specs

### 4.1 `agent-assignment/spec.md` (4 requirements)

| Requirement | ACP | Rationale |
|---|---|---|
| Every assignment is self-contained (run/attempt ID, cwd, role, prompt, capabilities, reporting instr., lease) | **Partial** | `session/new` carries `cwd` (absolute, `session-setup.md`: "MUST be an absolute path... MUST remain the base for relative-path resolution") and `mcpServers` — this covers *directory routing* and *injection of reporting tools* (via an MCP server in `mcpServers`). It does not carry role/capability requirements or a lease — these must be added by layers above ACP (e.g. prompt content, per-run MCP configuration). |
| Unassigned work is durable and visible (offer without a failed run, recoverable after restart) | **No** | No counterpart — see decision #3 in section 3. |
| Assignment acceptance is leased and atomic (one runner, a race between two runners resolved atomically) | **No** | ACP has no model of multiple candidate runners per task — the client chooses *up front* which agent to launch (a configured command/binary) before establishing the connection. No "race" at the protocol layer. |
| Timeline notes do not trigger inference (best-effort note, failure does not block) | **No** | `rfds/session-notices` (Preview, 2026-09-24) introduces `notice` — but it goes **from the agent to the client**, exactly the opposite direction from Conductor's `note()` (Conductor→agent session). The direction is decisive here, not just maturity: even if `notice` were stable, it would not address the requirement "the client appends something to the agent's session without invoking inference", because it is on the wrong side of the protocol. The only client→agent channel in ACP is `session/prompt`, which is always model input. Hence **No**, rather than "Partial" — `notice` is irrelevant to this particular requirement, not a weaker version of it. |

### 4.2 `runner-lifecycle/spec.md` (5 requirements)

| Requirement | ACP | Rationale |
|---|---|---|
| Runner availability is leased, not assumed (heartbeat, expiry, no identity deletion) | **No** | See decisions #1/#5 in section 3 — no registry model with a heartbeat. |
| Availability changes wake compatible waiting work | **No** | Same as above. |
| Session creation and prompting are idempotent (idempotency key, redelivery without duplicates) | **No** | See decision #4 in section 3 — ACP has no idempotency-key field at all; `messageId` correlates **agent responses**, it does not deduplicate **client requests**. Zero protocol primitives in this direction. |
| Unknown status is handled in the safe direction (busy/idle/retry/missing distinguished; missing endpoint → transient error) | **No** | No `session/status` method in ACP at all (see decision #7 in section 3) — you cannot "query for uncertainty", because you cannot query at all. Inferring from the `session/update` history (streaming) is not a safe replacement for a request/response `status()` (see section 3, row 7) — it is a different model, not a weaker version of the same one. |
| Cancellation is best-effort and audited (request does not wait for runner availability; audit of request+result) | **Partial** | `session/cancel` (a notification, does not block on a response) + `$/cancel_request` are exactly best-effort: "MAY cancel... The calling side MAY implement graceful cancellation processing by waiting for the response" — matches "request does not wait". But the **audit** (durable record of request+observed result) is entirely Conductor's responsibility — ACP neither logs nor stores any of it; hence **Partial**, not **Yes**: the protocol covers only half of the requirement (the request mechanics), not auditability. |

### 4.3 `runner-contract/spec.md` (3 requirements)

| Requirement | ACP | Rationale |
|---|---|---|
| Runners implement a small versioned contract (version negotiation, capability reg/heartbeat, create/prompt/status/note/cancel) | **Partial** | Version negotiation: **a partial fit**, not a full one — ACP does negotiate the version (`initialization.md`: "If the Agent supports the requested version, it MUST respond with the same version. Otherwise... the latest version it supports"), but `runner-contract/spec.md` demands diagnostics of "both supported **ranges**" on incompatibility — ACP `protocolVersion` is a **single integer major version** per side (today `1`), not a range of multiple simultaneously supported versions; the "range on both sides" diagnostic therefore has no exact counterpart — the agent/client returns a single number, not a list/range, so this particular part of the requirement is only **partially** achievable (the incompatibility itself can be reported, "ranges" not in the literal sense). Create/prompt/cancel: **Yes** as primitives (`session/new`, `session/prompt`, `session/cancel`). Capability registration/heartbeat as a separate **registry** (see #1/#5): **No**. Status: **No** (see above). Note: **No** (see 4.1, opposite direction). Overall: the "session" core (create/prompt/cancel) is covered, version negotiation partially, the "registry" core (capability/heartbeat/status/note-to-agent) is not covered. |
| Capabilities are negotiated before assignment (required tool surface, opaque model binding, no assignment without a compatible runner) | **Partial** | `initialize` capabilities (`mcpCapabilities.http/sse`, `promptCapabilities.image/audio/embeddedContext`, `sessionCapabilities.{loadSession,resume,close,delete,additionalDirectories}`) negotiate **protocol features**, not **task-specific execution capabilities** (e.g. "does this runner have access to worktree X"). A few clarifying distinctions: (a) **`parentID` is NOT part of stable ACP v1** — `session/new` in ACP carries only `cwd`/`mcpServers` ([`session-setup.md`](https://agentclientprotocol.com/protocol/v1/session-setup.md)); "parent session" is a concept of Conductor's own port (`SessionClient.createSession({parentID})`, today's pattern via the opencode SDK, `engine.ts:491-508`), with no counterpart in ACP itself — not to be confused with `session/fork` (still Draft), which is **something else** (branching the history of an existing session), not a transport for `parentID`; an ACP adapter would have to implement the parent/child hierarchy outside the protocol (e.g. via its own layer on top of multiple independent `session/new` calls). (b) Model/variant/mode are **not universal identifiers** — `configOptions` with `category: "model"` is an *optional* mechanism, each agent defines its own `value`/`id` with no shared vocabulary across runtimes; validation is, however, possible **after session creation, before the prompt**: `session/new` may return initial `configOptions` in its response, and/or `session/set_config_option` returns the **full, current** list with `currentValue` — Conductor can read it and **reject before sending `session/prompt`** if the requested model is not among the options; this is not "no way to reject before an attempt", but "validation is possible only after `session/new`, not before it" — assignment-gating **before session creation** (at the runner selection stage) remains impossible, validation **after creation, before the prompt** is possible. (c) The "required tool surface" (e.g. `conductor_report` via MCP) depends on whether the agent **actually accepted and connected** the configured MCP server — `session-setup.md`: "Agents **SHOULD** connect to all MCP servers specified by the Client" (SHOULD, not MUST) — there is no confirmation in the `session/new` response that a given MCP server is ready/its tools visible; readiness has to be verified empirically (see section 7.1, OpenCode risk), not assumed from the mere acceptance of `mcpServers` in the request. In summary: assignment-gating **before** session creation, based on required capabilities, remains Conductor's responsibility — only part of the validation (model) can be moved to "after creation, before the prompt". |
| Runner errors use the shared failure model (stable error class, resource-unavailability ≠ operation failure) | **Partial** | See decision #6 in section 3 — `StopReason` is a closed set of turn conclusions, not a general taxonomy; JSON-RPC error codes (`-32800` Cancelled, the standard `-32601`/`-32602` etc.) provide structure, but not classes in the style of `transient_upstream`/`capacity` — mapping still requires adapter logic. |

**Note on counting:** this note deliberately does **not** aggregate the rows of sections 3
and 4 into a single "X/Y coverage" number. Design decisions (section 3) and
spec requirements (section 4) are not units of comparable weight —
summing them would suggest a measurement precision that this qualitative
analysis does not have. The quantitative conclusion is simpler and more robust: **no
row in either of the two tables is "Yes" except cancellation mechanics
(section 4, partial) and version-negotiation/create/prompt/cancel as
individual session primitives (section 4.3, within a row assessed
as Partial overall)** — "No" and "Partial" dominate, which
suffices for the conclusion in section 10 without the need for a numerical sum.

---

## 5. Boundary analyses: six architectural + permissions/auth/isolation

The boundaries below are fundamental to Conductor's architecture
(`AGENTS.md`, `openspec/config.yaml`) and **none of them is what ACP
is** — confusing them leads to an architecture in which ACP silently
takes on responsibility it should not have. Sections
5.1-5.6 are the six architectural boundaries (source-of-truth, interpreter
purity, retry ownership, review/gates ownership, end_turn-vs-success,
conversation-recovery-vs-execution-recovery). Sections 5.7-5.8 add two
operational boundaries — permissions/authorization/isolation and
process identity/lease/supervision — which the review of this note
identified as missing and which **are not covered** by the other six:
they address a different question ("what is the agent allowed to do,
under what identity, and who supervises the process itself", not "where
does the truth of state/effects/retry/gates live").

### 5.1 State truth: SQLite vs the ACP session

`AGENTS.md`: "SQLite is the source of truth. Sessions are disposable
executors." ACP has no notion of durability beyond the optional
`session/load` (history replay) and `session/resume` (no replay) —
**both depend on whether the agent itself keeps durable state**
(capability `loadSession`/`sessionCapabilities.resume`, both optional,
both may be `false`). ACP **does not guarantee** that any state survives
an agent restart — that is a decision of the agent implementation, not
of the protocol. Conductor already today does not rely on session
durability (`state.sessionId` is re-established via `sessionExists` +
re-creation, `engine.ts:484-497`) — this is consistent with ACP, but
**for a different reason**: Conductor designs sessions as disposable by
intent, whereas ACP simply does not promise durability.
**Conclusion: SQLite as the source of truth remains unchanged; ACP
cannot and should not replace it — that is not its role.**

### 5.2 Interpreter purity: where side effects live

`AGENTS.md`: "Interpreter pure, engine owns I/O. Routing decisions live
in a pure function; all side effects live in the engine/reconciler."
ACP is by nature **a** side-effect protocol — `session/prompt`
invokes the model, the agent executes tools and **reports** them via
`tool_call`/`tool_call_update` (observation of state, not a request for
the client to execute), and `session/request_permission` is a request
for a client **decision** (allow/deny), not the execution of the action
itself — the side effect (e.g. writing a file) is performed by the
agent, only **after** permission, if any, is granted.
Regardless of this distinction, ACP as a whole remains a protocol
carrying side effects that the interpreter should not touch
directly. If Conductor's interpreter (a
pure function deciding graph routing) gained direct access to the
ACP client, that would break the split. **The boundary stays: the
interpreter still only decides "what next" (e.g. `decideResourceWaitRoute`,
`engine.ts:422`), and the ACP call (the analogue of today's `sessions.prompt`)
stays in `engine.ts`/the I/O layer, just as today `SessionClient` is
injected into the engine, not into the interpreter.** An ACP adapter would
replace `runner-opencode`/`runner-transport.ts` as a **port implementation**,
not change the layered architecture.

### 5.3 Retry / failure-classification ownership: `retry-policy` vs ACP

`runner-contract/spec.md`: "The engine SHALL apply the generic policy
from `retry-policy` and SHALL NOT parse message text." `retry-policy`
(**shipped**, 25/25) already provides `FailureClass`, tries-and-elapsed
budgets, `resource_wait`, and `recover()` with optimistic concurrency
(`engine.ts:1490-1529`). ACP `StopReason` (5 values) and JSON-RPC error
codes **are not** and cannot be a retry taxonomy — they carry no retry
hints (the `retry hint` from the `runner-contract` requirement "Provider outage is
classified" has no ACP counterpart other than free-form error text).
**Every ACP adapter must translate its errors into `FailureClass` on
Conductor's side — exactly as `classifyThrownBoundary` does today (badly,
via regex).** ACP does not take over, and should not take over,
retry ownership.

### 5.4 Ownership of the review/findings lifecycle and human gates

Structured review (`conductor report --review`, findings with ID/severity/
blocking/acceptanceTests — `tools.ts` `createReportTool`, full schema
in `plugin.ts:40-78`) and human gates (`approve`/`requestChanges`,
`conductor_approve`/`conductor_request_changes`, `plugin.ts:164-190`) are
**fully owned by Conductor** — the state lives in SQLite (`findings` table,
`store.listFindings`), transitions go through the interpreter's `dispatch()`
(`human.paused`/`human.abandoned`/analogous ones for approve). ACP has no
notion of a "finding", "review verdict" or "approval gate" as a first-class
concept — the closest thing ACP has is `session/request_permission`
(a single tool call, per action, not a per-run gate) and **elicitation**
(`elicitation/create`, stable since 2026-07-24). Elicitation, however, is
**UI interaction**, not a durable gate: the request is scoped to the live
agent↔client connection (`elicitation.md`: "Agents MUST bind each
elicitation and related state to the receiving Client connection"),
**does not survive a restart**, has no findings-style budget/audit, and
is explicitly not an execution authority ("An accept response means the
user consented to open the URL. It does not mean the external
interaction completed"). **Human gates and the findings lifecycle remain
100% on Conductor's side; ACP elicitation is not a substitute for them —
it is a different layer (per-tool-call UI prompt vs per-run durable approval
state machine).**

### 5.5 `end_turn` (StopReason) ≠ task success

This is the **most dangerous** potential design mistake.
ACP v1 `prompt-turn.md`: `stopReason: "end_turn"` means only "The
language model finishes responding without requesting more tools" —
**nothing about whether the task was completed correctly, or even
reported at all**. ACP v2 `prompt-lifecycle.md` says the same, plus explicitly:
"A successful prompt response is not an `idle` signal" (for `session/
prompt` itself) and separately defines the `idle` `state_update` as
the end of foreground work — but **none of these signals is
Conductor's `run.status = "succeeded"`**. Conductor already today
**deliberately does not** infer success from `status: idle` (`sessions.status()`) — the closest
authoritative signal is an explicit `report()` call (`engine.ts:1013`,
guard `if (run.status !== "running") return alreadyConcludedText(...)`)
by the agent with an `outcome`/`verdict`. But even this needs to be made
precise rather than simplified to "report/ask = finished":

- `report(..., ask: question)` **DOES NOT end the run** — quite the opposite,
  it **suspends** it: `store.setRunQuestion` (`engine.ts:1050`) leaves the
  run in the `running` state and waits for the human's answer as a new prompt;
  this is "end of turn, not end of task" (see below, the supplement to
  section 6), neither success nor failure.
- A run **can conclude without any `report()` from the agent at all** —
  `reap()` (`engine.ts:2112-2135`) concludes the run as `"reaped"` after
  the silence TTL is exceeded, regardless of whether the agent ever
  calls `conductor_report`. The authority of `report()` is therefore
  conditional: it is the only **positive** success signal, but **not**
  the only way a run ends — reap and other
  `concludeAndDispatch` paths (prompt error, `step.failed`) end the run without
  the agent's involvement.

If an ACP adapter started treating `stopReason: "end_turn"` by itself
as a signal that the **step** has completed (successfully), it would break
exactly this principle — end_turn is a **language-model event** (end of a
prompt turn), `report()` is a **Conductor business-protocol event**
(end of the task), and receiving neither of them leads to reap, not to
default success. **Conclusion: the ACP adapter must still wait for an explicit,
positive `report()` (via a run-scoped MCP tool, see section 6) for
success, and leave TTL/reap as the only path for silence — never
infer success from `stopReason` alone.**

### 5.6 Conversation recovery ≠ execution recovery

`session/load` (replay of the full history before responding) and `session/
resume` (no replay, "MUST NOT replay... restores the session context...
returns once ready") are **connection/conversation-context recovery** —
they answer the question "how do I get back to the conversation with the same agent". That
**is not** the same as "recovery of a workflow step's execution" — i.e. the
question that `retry-policy` asks: whether a given `run`/`attempt` has
concluded, whether it needs to be retried, with what budget, with what failure class.
Direct evidence from ACP v2: "If the response [to `session/prompt`] is lost,
the submission's outcome remains uncertain: **replay may omit live-only
or discarded messages, and a retry can create another submission**." —
ACP **admits** that even with `session/load`, it is not possible to safely
reconstruct "whether a given prompt arrived" without an additional mechanism outside
the protocol. Clarifying the role of `messageId`/`load`, so as not to
generalise beyond what the spec actually says:

- `messageId`/`toolCallId`/`_meta` serve **request↔response correlation**
  — this is not limited to a single, still-live connection:
  if the agent retains and replays a message (on `session/load`),
  it MUST use **the same** `messageId` as on the original send
  (`session-setup.md`/`prompt-lifecycle.md`: "If the message is retained
  and replayed, the Agent MUST use the same ID") — so the identifier
  *may* survive across connections, provided the agent chooses to
  store history. What is missing is **deduplication of client
  requests** (an idempotency key on the `session/prompt` side), not
  response correlation as such — these two things are not the same.
- `session/load`, where the agent **supports** `loadSession` (an optional
  capability), **does actually deliver durable conversation history** —
  this is not "ACP never guarantees durability" in a blanket sense;
  it is "durability is an optional capability, dependent on the
  agent implementation", a distinction that matters for the per-agent
  assessment in section 7 (which of the three candidates actually supports it and for how
  long). What `session/load`/`session/resume` **do not** guarantee
  is not context durability itself (which, when supported, they deliver), but
  **confirmation that the side effects reported in that history actually
  occurred exactly once** — replay/resume restores the **conversation
  context**, it does not audit **effects in the external world** (files,
  commits, tool invocations). This distinction — context vs effects —
  is the crux of this boundary, not a lack of durability per se.

**Conclusion: `session/resume`/`session/load`, where supported, can
genuinely help resume the conversation and context with the agent after loss
of the transport connection, but that does not solve execution. Conductor
still needs its own mechanism (an idempotency key/delivery_token in
the style of today's `answer_delivery`, section 2.6) — but even that
mechanism **correlates delivery attempts**, and without deduplication and
receiver-side proof it does not even confirm exactly-once delivery.
**Nor does it prove on its own** that a side effect in the external
world occurred exactly once: a token without effect-specific proof
(e.g. checking repo/PR state) leaves a crash-after-effect-before-report
in an **unknown** state (see section 6, "Critical caveat") — ACP
provides (optionally) context/conversation recovery; neither ACP nor the
correlation token alone provides an audit of execution and its effects.**

### 5.7 Permissions, authorization, isolation (headless daemon, deny-default)

Conductor runs agents **without an interactive human at the
keyboard** — it is a headless orchestrator, not an IDE. ACP assumes in
many places the presence of a client with a UI (Zed, an editor) and does **not**
by itself define a safe posture for a headless host. This boundary is
separate from 5.1-5.6: it concerns **what the agent is allowed to do and under what
identity**, not where the truth of state lives.

- **`cwd` is a convention boundary, not a sandbox.** `session-setup.md`:
  "This root set **SHOULD** serve as a boundary for tool operations on
  the file system" — `SHOULD`, not `MUST`, and "boundary for tool
  operations" is not equivalent to hermetic process isolation.
  ACP sandboxes nothing by itself — `cwd`/`additionalDirectories`
  are an instruction to a *well-behaved* agent, not OS-level enforcement.
  Real isolation (namespace/chroot/container/system
  permissions) must come from the **host launching the agent process**
  (today's `PluginProcessSpawner`, `ports.ts:101-103, in the context of
  long-lived processes), not from ACP.
- **`session/request_permission` is optional on the agent side, not
  universal enforcement.** `tool-calls.md`: "The Agent **MAY** request
  permission from the user before executing a tool call" — `MAY`, not
  `MUST`. An agent that decides a given tool does not require confirmation
  (or is badly implemented) will simply execute it without asking.
  Conductor **cannot rely** on `request_permission` as the only
  line of defence for a headless run — it needs its own deny-default
  policy (e.g. process sandboxing, a directory allowlist, no network
  access beyond what is explicitly permitted) **independent** of whether
  a particular agent asks.
- **Provider authorization ≠ run authorization.**
  `authentication.md` governs only whether the agent has valid
  credentials for its model/API (`authenticate`, `authMethods`,
  `logout`) — that is the question "can this agent talk to the
  provider at all", entirely separate from Conductor's question "is **this
  run/this workflow** allowed to perform this task here in this repo".
  ACP has no notion of authorization at the run/attempt level — this must
  remain exclusively on Conductor's side (e.g. today's
  `CONDUCTOR_RUNNER_TOKEN`/`timingSafeEqual` in `hub.ts:66-70`, or
  its counterpart in the MCP-report layer, see section 6).
- **Deny-default, bounded, headless waiting for confirmation.** Since
  `request_permission` is optional and UI-oriented by nature (the client
  "presents" options to the user), Conductor's headless hosting must
  answer these requests **itself** (either via an automatic
  allow/deny policy, or via escalation to a human through the existing
  `conductor_ask`/human-gate mechanism, not by waiting forever for a
  UI that does not exist) — with an explicit, time-bounded timeout, not
  indefinite blocking of the ACP connection.
- **OS/process/env/network restrictions remain entirely outside ACP.**
  The protocol has no notion of resource limits, network restrictions,
  restrictions on environment variables passed to the subprocess,
  or supervision of the process tree. All of this is — and remains —
  the responsibility of Conductor's hosting layer (the one launching
  the agent/adapter process), analogous to today's
  `PluginProcessSpawner`/`ProcessRunner`.

**Conclusion: ACP provides neither a sandbox, nor enforced run
authorization, nor an OS/network/process policy. Deny-default is not
fully implemented today even for `runner-opencode` — token auth on the
callback exists (`hub.ts:66-70`), but directory routing (`hub.ts:247-258`,
`sessionsForDirectory`) **falls back to the first registered project in
sort order** when the requested directory lies outside all
registered roots, instead of rejecting the request — this is a
permissive fallback, not an enforced allowlist. The ACP adapter therefore must
not only "import" the existing assumptions, but **actually close** this
gap (reject, not fall back, outside the declared `cwd`/roots) —
ACP by itself neither replaces nor weakens this requirement, but it also does not
solve it for Conductor.**

### 5.8 Identity, lease and process supervision — durability stays on Conductor's side

A supplement to 5.1/5.7 focused specifically on the **process**, not just on
data: ACP identifies the **connection and session** (`sessionId` returned from
`session/new`), not the **operating-system process**. Several consequences:

- **No PID-based identity.** A subprocess launched by the client
  over stdio has no stable identifier that survives a restart —
  `sessionId` belongs to ACP (optionally durable, if the agent
  supports `loadSession`/`resume`), but the **process** that served it
  dies and is replaced by a new one on every client restart. Fencing
  (preventing two processes for the same logical work from
  running concurrently and colliding) is not part of ACP — it must be
  built by the host (Conductor). Today's `RunnerRegistry`
  (section 2.3) **is not** an example of a ready solution to this
  problem — it is keyed by endpoint, **in process memory**, neither
  durable nor stable across a restart (gap #1 in section 3); it is rather
  an illustration that even today's non-ACP mechanism has not yet
  solved fencing/stable identity — a point that an ACP adapter
  would inherit as an open problem, not as something Conductor already
  has ready and only needs to plug in.
- **Process-tree supervision is the host's job, not ACP's.** When the client
  cancels (`session/cancel`) or terminates the connection, ACP does not
  guarantee that the **entire** child process (and its own sub-processes,
  e.g. tools launched by the agent) has actually died —
  the protocol speaks only of session/turn state (`cancelled` stop reason),
  not of OS process state. Verifying the process tree remains
  the host's obligation (see spike scenario 8.3 item 9).
- **No durability is automatic.** Even when the agent supports
  `loadSession`/`resume`, it is *its* implementation choice whether and for how
  long it keeps state — ACP neither imposes nor guarantees a retention
  period. Conductor cannot assume that "since the agent declared
  `resume`, the state will survive a restart" — that depends solely on the
  agent implementation, verifiable only empirically (spike,
  scenario 8.3 items 5/6).

**Conclusion: durable identity, fencing and process supervision remain
100% the responsibility of Conductor (the host) — ACP identifies
connections/sessions, not system processes, and promises no durability beyond
what a given agent chooses to implement on its own.**

---

## 6. Recommendation: an adapter, not a competing protocol

**Do not build** a second wire protocol parallel to `SessionClient`/
`runner-protocol`. Instead, if Stage 2 (spike) turns out positive:

- **Preserve (unchanged):** SQLite as the source of truth (5.1); interpreter
  pure / engine owns I/O (5.2); `retry-policy` as the sole owner of
  `FailureClass`/budgets/`resource_wait` (5.3); findings lifecycle and
  human gates as Conductor state, not ACP state (5.4); `conductor_report` as
  the only authoritative success signal, not `stopReason` (5.5); the door to
  native integration (`SessionClient` directly over a runtime's SDK, as
  `runner-opencode` does today) remains open — ACP does not forcibly replace it
  for runtimes that have a better native integration.
- **Change (the adapter implements the port, the port does not change radically):**
  The reference point for any adapter should be the **stable
  v1**, not the v2 draft — v2 is in Draft (since 2026-07-20) and its semantics
  ("acceptance means insertion, not completion", `prompt-lifecycle.md`)
  **are not** what v1 guarantees. In v1, `session/prompt` **is a
  long-lived request** ([`prompt-turn.md`](https://agentclientprotocol.com/protocol/v1/prompt-turn.md):
  the response with `stopReason` arrives only **at the end of the turn**, after
  all `session/update`s) — the adapter must not treat the local
  sending of the request as equivalent to a durable confirmation of acceptance;
  the only thing v1 guarantees immediately is that the request was sent, not that
  it was "accepted" in the v2 sense. A `runner-opencode`-style adapter for
  ACP would implement **the same** `SessionClient` (or an extended
  `runner-protocol` port, once that exists) over an ACP connection instead of
  over the opencode SDK: `createSession` → `session/new`; `prompt` →
  `session/prompt` (long-lived in v1, not fire-and-forget); `abort` →
  `session/cancel`. Separate time budgets per operation, rather than a single 10s one (like today's
  `runner-transport.ts:57`), are necessary:
  **startup** (launching/connecting to the agent process), **write**
  (delivering a single JSON-RPC request), **turn** (the whole
  `session/prompt` until `stopReason` — may take minutes), **cancel**
  (waiting for a confirmed `cancelled` after `session/cancel`) — a single
  shared timeout would confuse "long-running agent" with "dead connection".
  `status`/`sessionExists` → **have no portable counterpart common to all
  agents** (gap confirmed in section 3 row 7, section 4.2)
  — the only options are (a) inference from the `session/update` history
  kept in the adapter, which **is not a safe replacement**
  (silence in the stream does not distinguish "agent is computing" from "connection dropped"
  — do not infer "idle"/"missing" from transcript silence alone), or (b)
  an extension via a `_`-prefixed custom method (`extensibility.md`),
  which is by definition **non-portable** across agents that do not
  implement it — each of the three candidates in section 7 would have to be
  verified separately, not assumed. Reporting
  (`conductor_report`/`conductor_ask`) goes through a **run-scoped MCP
  server**, injected via `mcpServers` in
  `session/new`/`session/load`/`session/resume` over stdio (baseline, MUST
  be supported by every ACP agent — `session-setup.md`; HTTP auth headers
  are available as an MCP transport option, but the MCP-HTTP/SSE
  capabilities themselves are optional on the agent side, not MUST) — **not** via
  today's model of "opencode plugin tools calling the HTTP API" (2.5),
  because that is opencode-specific, not ACP. The MCP tool surface exposed
  to the agent should be limited to `report`/`ask` (and reading the status of
  its own run) — **not** `approve`/`request_changes`/admin
  operations: a broad admin scope via a tool invoked by the very agent
  being executed would invert the boundary from 5.7 (an agent granting
  itself permissions). The MCP calls themselves should hit **the
  same** existing daemon/SQLite API (`ApiClient`/`store`), not a
  parallel path of truth — the MCP server is a transport here, not a new
  source of state.
- **Replace (the only candidate for replacement):** the `runner-opencode` transport
  (today's `hub.ts`/`sessions.ts`, HTTP callback daemon→runner) **for
  runtimes that have a maintained ACP adapter** — but this is a per-runtime
  decision (see section 7), not a blanket replacement, and it requires reconciliation
  with `runner-protocol` (the same version/capabilities/lease contract, or
  an explicit closing of selected decisions of it as superseded by the
  ACP+MCP-report boundary — **never silent duplication**).

### Supplement: MCP-report credential scope and stdio log hygiene

If reporting goes through a run-scoped MCP server (above), several
additional conditions must be met, independently of ACP:

- **A credential scoped to a single attempt**, not to the session/agent
  in general — the token/key injected into the MCP configuration should
  identify exactly `run_id`/`attempt`, analogously to today's
  `delivery_token` (section 2.6), so that a duplicate/stale call can
  be unambiguously rejected on the daemon side (stale/duplicate validation
  must live in Conductor — the MCP transport does not provide it for free).
- **`session-setup.md` MCP stdio carries `env`** (environment variables
  passed to the MCP server process) — if the credential travels this
  way, it must be treated as a secret: never log the MCP process
  arguments/env verbatim (the same redaction requirement that today's
  `boundDiagnostic` already applies to error messages, `engine.ts:537-546`).
- **Distinguish `mcpCapabilities.http` (ACP, optional for the agent) from
  "ACP over HTTP" (the transport of ACP itself, still an RFD in Active state, not
  stable)** — these are two different things: the first is the agent's ability to
  connect to MCP servers over HTTP (part of stable ACP v1), the second
  is a hypothetical remote transport for the client↔agent connection itself
  (see section 3, row 2) — do not confuse the maturity of one with the other.

### Critical caveat: MCP-report durability ≠ automatic idempotency

A durable MCP report (the agent calls `conductor_report` via a run-scoped MCP
tool) **commits the result** to SQLite with the same rigour as today
(`WHERE status = 'running'` guard, `run_already_concluded` on a duplicate —
`tools.ts` `describeError`/`ApiError` handling). This solves "did the result
arrive", it does **not** solve "did the side effect (e.g. `git commit`, `gh pr
create` performed by the agent) occur exactly once". A crash **after**
the remote effect, **before** the report is written, leaves the state **UNKNOWN** —
it requires proof (e.g. checking the repo/PR), a fencing token, or escalation to
a human — **not** a blind retry. This is exactly the same problem
that `retry-policy`/`runner-protocol` already design for in general
(`resource_wait`, `recover()` with an operator-selected target) — ACP changes
nothing here and simplifies nothing.

### `conductor_ask` / human gates: end of turn ≠ end of task (supplement to 5.5)

`conductor_ask` (`plugin.ts:135-154`) ends the prompt turn (the agent ends the
turn, the session stays alive, the human's answer arrives as a **new**
prompt) — this is a pattern that **fits** ACP: `end_turn` does indeed
end the turn, and the answer is a new `session/prompt`. This is the only place
where `end_turn` and "task paused pending human" align with intent — but
**only because Conductor explicitly differentiates "end of turn" from
"end of task"** (durable `answer_delivery`, section 2.6, does not rely on
the session "remembering" that it is waiting). ACP elicitation (5.4) should **not**
replace this mechanism — elicitation is scoped to the live connection and
has no delivery-token/retry-schedule in the style of `answer_delivery`.

---

## 7. Per-agent go/no-go + spike on the same task

### 7.1 OpenCode — native ACP

- **Version:** `opencode-ai@1.18.32` (npm, verified 2026-09-25).
  Command: `opencode acp --cwd <ABS>` (native, built into the `opencode`
  binary, no external intermediary adapter). Documentation: <https://opencode.ai/docs/acp/>,
  <https://opencode.ai/docs/cli/>. Source (tag `v1.18.32`):
  <https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/acp/service.ts>.
- **Observed capabilities:** `load`/`list`/`resume`/`close`/`fork`
  advertised — but `fork` is **still a draft** in ACP itself (`rfds/updates`:
  "session/fork RFD moves to Draft stage", 2025-11-20, not stabilized
  as of 2026-09-25) — advertising a draft capability is an
  interoperability risk, not a reason to reject native OpenCode.
  MCP HTTP/SSE: supported.
- **Risk:** MCP server registration is **directory-scoped, not
  session-scoped** in the service source, and **ignores some errors** when
  connecting — this undermines the guarantee of "reporting tool readiness
  before the first prompt" (`agent-assignment` requirement "Required
  tool surface unavailable"). Requires an explicit test in the spike: whether
  the `conductor_report` MCP is ready before the agent can call it, or
  whether polling/waiting is needed.
- **Auth:** `opencode-login` returns success, but **external provider
  auth is still required** separately (this is not "magic" auth via ACP).
- **Abort:** abort errors are **swallowed** in the source — the actual
  `cancelled` stop reason / process state must be observed; do not trust
  the `session/cancel` call alone as proof.
- **Go/No-Go: GO** (native, actively developed, lowest risk of an
  additional intermediary process) — **condition:** the spike must verify
  MCP readiness and the actual effect of `session/cancel` (not just the absence of an error).

### 7.2 Codex — conditional GO (maintained adapter, not native)

- **Codex CLI is NOT natively ACP** — `codex app-server`
  (<https://developers.openai.com/codex/cli/reference/>, CLI 0.157.0) is
  a separate protocol, not ACP. The old `zed-industries/codex-acp` **redirects**
  to the maintained `agentclientprotocol/codex-acp`.
- **Adapter version:** `@agentclientprotocol/codex-acp@1.13.1` (npm,
  verified 2026-09-25) declares a dependency on `@openai/codex@^0.156.1` in
  its `package.json` — for `0.x` versions, the semver caret locks the range at
  the patch level (`^0.156.1` = `>=0.156.1 <0.157.0`), so this
  declared range **excludes** `0.157.0` — the released Codex CLI version
  observed in this note (section 7.2, first item). The adapter
  and the currently released Codex CLI may therefore **not be declared
  compatible** — this is not a confirmed incompatibility (the adapter may
  actually work despite the narrower declaration, or the authors have not yet
  updated the range), but it is a signal to verify in the
  spike, not to ignore. **Two pins required in the spike**:
  the adapter version AND an actually verified, compatible version of the
  Codex binary (`CODEX_PATH`, probably `0.156.x`, to be confirmed
  empirically, not by assumption) — do not assume compatibility in either direction
  without a test. Source (commit `b1b8490cd165c18626dc3fe83836cdacdef94cd3`):
  <https://github.com/agentclientprotocol/codex-acp/blob/b1b8490cd165c18626dc3fe83836cdacdef94cd3/src/CodexAcpServer.ts>.
- **Capabilities:** `load`/`resume`/`list`/`close`/`fork`/`delete`
  advertised; MCP HTTP **true**, SSE **false**.
- **Launch:** a future pinned command (binary explicitly
  installed) or `npx -y @agentclientprotocol/codex-acp@1.13.1` —
  **not executed in this note** (outside the scope of Stage 1, read-only).
- **Auth:** ChatGPT login **or** `CODEX_API_KEY`, which takes precedence over
  `OPENAI_API_KEY` — requires an **explicit choice of method** before the spike;
  `NO_BROWSER` hides the login, it does not replace authorization ("no auth magic").
- **Risk:** the intermediary process (adapter) is an **additional failure
  layer** beyond the Codex CLI itself — an adapter crash ≠ a Codex crash, requiring
  separate observation in the spike (process tree, not just the ACP connection).
  Do not generalize from this adapter to Codex "background tasks"/extensions
  — out of scope for this note.
- **Go/No-Go: CONDITIONAL GO** — condition: pinning **both** versions
  (adapter + `CODEX_PATH`), an explicit choice of auth method, a restart test of the Codex
  child process independently of the ACP adapter process.

### 7.3 Gemini — conditional GO (native flag)

- **Version:** `@google/gemini-cli@0.61.0` (npm, verified
  2026-09-25), requires Node ≥20. Command: `gemini --acp` (native flag;
  `--experimental-acp` is **deprecated** per
  <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts>).
- **Documentation vs code discrepancy:** the guide
  (<https://github.com/google-gemini/gemini-cli/blob/v0.61.0/docs/cli/acp-mode.md>)
  describes "MCP initialize", but the dispatcher code
  (<https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpRpcDispatcher.ts>)
  shows `session new`/`session load` — **the documentation does not accurately
  reflect the code path**; this requires verification in the spike, not trusting
  the guide alone.
- **Capabilities observed in the dispatcher:** `load` **true**, MCP
  HTTP/SSE **true**. (`session/new` is not a separately negotiated
  capability — it is part of the baseline method set that **every** ACP agent
  MUST support: `initialization.md`, "As a baseline, all Agents MUST
  support `session/new`, `session/prompt`, `session/cancel`, and
  `session/update`" — it does not need confirmation in the dispatcher.) `list`/
  `resume`/`close` are **not explicitly advertised** in the dispatcher —
  treat them as unsupported until confirmed in the spike: per ACP
  ("Clients MUST NOT attempt to call" a non-advertised optional method),
  the absence of an advertised capability means **no fallback** — do not assume
  that the operation "might work anyway", but rather that it is unavailable
  until the spike confirms otherwise.
- **Model API:** legacy unstable model API (preceding the removed
  `session/set_model`, ACP `rfds/updates` 2026-06-01) — **not portable**,
  requires adapter-specific handling of model selection, not generic
  `configOptions`.
- **Reproduction risk (unverified bug, requires a test):**
  <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpSessionManager.ts>
  — history replay on `load` is **not awaited** in the apparent code
  path — this may (unconfirmed) lead to a race in the ordering of
  events on `session/load`. **Requires an explicit test in the spike**, not
  an assumption in either direction.
- **Auth:** API key **or** Vertex/cached login — isolate settings
  (<https://geminicli.com/docs/get-started/authentication/>), explicitly choose
  the method **before** the spike, because `load` may require a previously saved
  method.
- **Not tested:** no paid model calls were made as part of this
  note.
- **Go/No-Go: CONDITIONAL GO** — condition: verify in the spike (a) whether
  `acp-mode.md` actually describes the real code path or is
  outdated, (b) the event ordering on `session/load` (race or not),
  (c) which capabilities are actually advertised live (not just in
  the source at a given tag).

### 7.4 Summary: the same small spike on all three

The Stage 2 condition from `docs/development-roadmap.md` — "the same small
task on OpenCode/Codex/Gemini via ACP" — see section 8 for the full
specification of the environment, scenarios, and success criteria. None of the three
agents is disqualifying on its own; OpenCode has the lowest
risk (native, no intermediary), Codex and Gemini require additional
conditions before the spike is launched, not after it has started.

---

## 8. Spike specification (Stage 2 — not executed in this note)

### 8.1 Environment

- **A separate, disposable worktree**, outside `main`, not integrated
  with any workspace package. Do not modify `packages/*`.
- **One process/attempt** — per-runtime profile isolation (no agent
  shares a directory/profile with another during the test, except for the explicit scenario
  8.3 "isolation of the same `cwd`").
- **A temporary SQLite database** (not production, not `gloam-idle`), consistent
  with the `answer_delivery`/`runs` schema if the spike reproduces that part, or
  a minimal effect log if the spike is purely protocol-level.
- **A mocked MCP report as the first step** — only after verifying the
  mechanics on the mock, move on to real agents; **real model
  calls require a separate, explicit budget/approval** (cost), and should be treated
  as a **separate, separately approved stage** of the spike, not the default
  continuation of the mock.
- **Stack:** Bun + TypeScript (consistent with Conductor's stack,
  `AGENTS.md`), plus a pinned ACP SDK (`@agentclientprotocol/sdk`, see
  section 9 for the version to be confirmed in the spike itself — Node ≥20 for
  Gemini CLI means the execution environment must meet that same
  minimum runtime regardless of Bun).
- **Egress blocked by default (offline-first).** The mock phase (see
  above) runs **without network egress** — only the phase with real
  agents, after separate budget approval, opens access to the model
  provider's network, and does so explicitly, not as a side effect of the default
  configuration.
- **Timebox: two working days** for the whole of Stage 2 (environment + 15
  scenarios × 3 runtimes + report) — exceeding this window is a
  signal to stop and reduce scope (e.g., to 2 of 3
  runtimes), not to extend the spike indefinitely (in line with
  the principle from section 8.4: this must remain a small, bounded experiment).
- Candidate versions as in section 7 (`opencode-ai@1.18.32`,
  `@agentclientprotocol/codex-acp@1.13.1` + `CODEX_PATH` to be verified
  against the actually installed `@openai/codex`, `@google/gemini-cli@0.61.0`)
  — **pinning happens in the spike itself** after verification; it is not
  fixed here in advance as a certainty.

### 8.2 Task (identical on all three)

A small, deterministic task with a side effect markable by `run-id`:
e.g., "append the line `spike-marker-<run_id>` to the file `MARKER.md` in the given
worktree and report the result via a `conductor_report` equivalent (run-scoped
MCP tool)". Requires: an effect log (whether the file was actually changed),
a report (whether the MCP call arrived), `ask` (one required question to
a human along the way), then `cancel` on a separate repetition.

### 8.3 Scenarios (all three runtimes, the same set)

1. Lost response to `session/new` (create) — the client process simulates
   losing the response after the request actually arrived.
2. Lost `session/prompt` **before** the side effect occurs.
3. Lost `session/prompt` **after** the side effect occurs (the agent
   managed to write to the file before the response/acknowledgement was lost).
4. Lost MCP report ACK (`conductor_report` equivalent called,
   response did not arrive) → duplicate report.
5. Death and restart of the agent/client process (for Codex: **separately** the Codex child
   process vs the `codex-acp` adapter process).
6. Report durably persisted **before** the crash (positive baseline —
   check that it *works* before testing the negatives).
7. Cancel during model generation.
8. Cancel while waiting on `session/request_permission`.
9. Cancel during a slow-running tool + verification of the process
   tree (whether the child process actually dies, not just that the
   ACP connection reports `cancelled`).
10. Stale/outdated **scoped credentials** (MCP credentials scoped
    to the attempt, section 6, not a "delivery ID" — that is a different layer: the delivery
    ID correlates a message, the credential authorizes a call) on the
    mock side — make sure that a stale/revoked credential is
    explicitly rejected, not silently accepted or non-deterministically
    handled.
11. Worktree isolation — and **separately**, for OpenCode: multiple **actual
    ACP registrations** (not an analogy to `hub.ts`) on the same `cwd` —
    verify the **real** behavior of native `opencode acp` on a
    directory collision; do not assume that today's
    `runner-opencode`/`hub.ts` routing (which is specific to today's
    callback protocol, not ACP) carries over directly.
12. `session/load` of the transcript **vs** an interrupted task — do not perform
    a blind "resend" after `load`; confirm that the Conductor-side logic does not
    assume that `load` = "the task did not execute".
13. Unsupported capabilities (e.g., `resume` not advertised) — must
    **fail closed** (explicit error/refusal), not silently pretend to resume.
14. Missing valid credentials — test **on all three**,
    including OpenCode (not just Codex/Gemini): OpenCode requires
    separate provider authorization independent of `opencode-login` (see
    section 7.1) — it must produce an explicit, distinguishable auth error, not be confused
    with "runner unavailable".
15. MCP server did not manage to connect before the first prompt (for
    OpenCode in particular, see the 7.1 risk) — verify readiness.
16. **Positive success baseline** (`end_turn` + a correct `report()`) —
    verify **first** that the happy path works on all
    three before testing negatives; without this reference
    point the results of the negative scenarios cannot be correctly interpreted.
17. **Negative: `end_turn` without any `report()`** — verify that
    the Conductor-side logic (reap after TTL, section 5.5) actually
    triggers and does **not** confuse a bare `end_turn` with task success —
    a direct test of the boundary from section 5.5.
18. **Allow/deny permission policy** (`session/request_permission`) —
    verify both automatic `allow` and `deny` at the
    client/mock level, and confirm that a permission denial is not
    confused with a transport error and does not block the run indefinitely
    (see section 5.7).
19. **Bounded cancellation with a hard limit** — after `session/cancel`,
    if the `cancelled` stop reason/`state_update` does not arrive within
    a fixed window (e.g., 5 s), the spike client **kills the process tree**
    and **records** this event as an observed fact (does not hide it in
    the log) — exactly the boundary that section 5.8 calls "ACP does not
    guarantee process-tree supervision".
20. **Log redaction** — confirm that no raw JSON-RPC log
    written by the spike contains, in plain text,
    credentials/tokens/API keys passed via `env` in the
    MCP stdio configuration (section 6) or in the content of provider errors.

### 8.4 Success criteria

- All **3** runtimes tested on **the same** task and
  **the same** set of scenarios (8.3), with a reproducible report
  (steps + raw JSON-RPC logs, not just a summary).
- **≥2 of 3** runtimes show consistent behavior: the MCP report arrived
  exactly once (or a duplicate was explicitly detected, never silently), `cancel`
  observed as an actual stop (not just the absence of an error), and
  safe recovery (no scenario ends in a blind retry or a
  false success) — **before** moving on to Stage 3.
- The "unsupported capabilities" scenario (13) must end in fail
  closed on **each** of the three, not just on the majority — this is
  a hard safety condition, not a statistical one.
- This is a **small, bounded experiment**, not the construction of production
  infrastructure — a spike that itself starts to look like a miniature `runner-protocol`
  means the scope of Stage 2 has been exceeded.

---

## 9. Risks and unknowns

- **ACP as a protocol is still actively evolving** (≥15 RFDs stabilized
  in ~a year, v2 in Draft since 2026-07-20 with open RFDs such as Session Notices
  still in Preview as of 2026-09-24) — any "pin to v1" decision requires
  monitoring `rfds/updates`, not assuming stability ad infinitum.
- **No measured runtime↔SDK compatibility** — no test was run
  in this note; the versions are a point-in-time snapshot from registry.npmjs.org,
  not proof that they work together.
- **Documentation/code discrepancy in Gemini CLI** (7.3) — unknown extent,
  requires verification in the spike.
- **Unknown event ordering on `session/load`** in Gemini
  (`acpSessionManager.ts`, replay uncertain with respect to await) — a potential
  bug, not confirmed in this note (read-only).
- **Adapter as an additional failure layer** for Codex (a separate
  `codex-acp` process + a separate `codex` child process) — doubles the surface
  to monitor for restarts compared to today's single-layer
  `runner-opencode`.
- **Fork (`session/fork`) is a draft in ACP itself** — if any
  runtime advertises `fork` as ready, the advertisement is ahead of the protocol's
  stabilization; do not build any critical path on it.
- **runner-protocol `design.md` partially outdated** (section 2.7) —
  if Stage 3 happens at all, it requires a revision of `design.md` against
  what `runner-liveness`/`retry-policy` have already delivered, before
  an ACP layer is added on top.
- **Elicitation/session-notices are UI-layer features of the ACP client**
  (Conductor as a headless orchestrator has no "user in a dialog
  window" in the same sense as Zed) — their usefulness for a
  headless daemon is unclear and requires a separate assessment in the spike, not
  the assumption that "they exist in the spec, so they are suitable".
- **Configuration contradiction** (see section 1, "Note on project
  context") between "greenfield, no legacy obligations" and "confirmed
  decisions" listing today's `createSession/prompt/
  status/note` contract — unresolved in this note, to be explicitly addressed
  in any future proposal, not silently worked around.
- **Mapping of runner-protocol `design.md` risks to concrete ACP decisions
  (so that a future revision of `design.md` does not have to search again):**
  - *Idempotency storage retention* (`design.md` "Risks/Trade-offs":
    "Idempotency storage grows... finite retention after attempts become
    terminal") — directly concerns the gap from section 3 row 4: ACP has
    no idempotency-key field at all, so retention of such entries
    remains entirely on the Conductor side, regardless of whether
    the transport is today's HTTP callback or a future ACP.
  - *Stable local identity configuration / cloning rules* (`design.md`:
    "reference adapter persists/generated identity outside ephemeral
    process state and documents cloning rules") — directly concerns the
    gap from section 3 row 1 (no stable identity in ACP) and section
    5.8 (no PID-based identity) — if an ACP adapter is ever
    built, it must solve identity/cloning **with exactly the same
    mechanism** that `design.md` already designs for today's
    transport, not a separate one for ACP.
  - *Conformance suite* (`runner-protocol` task 1.3: "transport-independent
    conformance suite for versioning, capabilities, idempotency, safe
    status and cancellation") — if an ACP adapter is to replace
    `runner-opencode` for a given runtime (section 6, "Replace"), it must
    pass **the same** conformance suite once it exists — not a
    separate, ACP-specific test set, to avoid exactly what
    `design.md` warns against in "Protocol surface precedes second
    adapter": "conformance suite and mock runner prevent
    opencode-specific leakage" — analogously, prevent ACP-specific
    leakage.

---

## 10. Decision gate and a ready-to-paste prompt for the next task

**Stage 1 → Stage 2 gate** (from `docs/development-roadmap.md`): does ACP
cover enough to justify a spike? **Result of this note: YES,
conditionally.** ACP provides shared primitives for sessions, prompts, events,
cancellation, and MCP configuration. At the same time, the tables in sections 3-4 show
that the complex durable-execution requirements remain covered only partially
or not at all. The value of a shared session integration is enough to justify
a spike **testing the specific gaps**
(idempotency, status-without-query, end_turn-vs-success, capability-gating)
— it does not justify moving straight to Stage 3. The eight boundaries from section 5
(5.1-5.8: six architectural + permissions/auth/isolation +
identity/lease/process supervision) remain inviolable regardless
of the spike's outcome.

### Ready-to-paste prompt (to paste as the next task — Stage 2)

> Carry out Stage 2 (compatibility spike, disposable, outside `main`) from
> `docs/development-roadmap.md`, based on
> `docs/acp-gap-analysis.md` (this note — in particular section 7
> per-agent go/no-go and section 8 specification of the environment/scenarios/
> success criteria). Build the same small task (section 8.2) on
> OpenCode (`opencode-ai@1.18.32`, native `opencode acp`), Codex
> (`@agentclientprotocol/codex-acp@1.13.1` — **verify and pin**
> a compatible `@openai/codex`/`CODEX_PATH` version in the spike itself; do not
> assume `^0.156.1` from `package.json` without a test, see section 7.2) and
> Gemini (`@google/gemini-cli@0.61.0`, `gemini --acp`) via ACP, in a
> separate worktree, not integrated with `packages/*`. Start with a mock
> MCP report (no real model calls), then — **only after
> separate, explicit budget approval** — real agents. Test
> **all** scenarios from section 8.3 on all three
> runtimes; **no blind retries** under any
> uncertainty (in line with "safe unknown status" from
> `runner-lifecycle/spec.md`). Deliver: the spike code (not integrated),
> a report with a capability × runtime matrix, a list of connection-loss
> cases and the observed recovery behavior (raw JSON-RPC logs),
> a recommendation of the ACP version to pin. Success criteria: section 8.4 of this
> note (≥2/3 runtimes consistent on MCP report + cancel + safe
> recovery; the "unsupported capabilities" scenario must fail closed on
> all three). Finish with an explicit go/no-go gate for Stage 3
> (the actual ACP adapter + reconciliation with `runner-protocol` —
> **requires a separate OpenSpec proposal**; do not carry out Stage 3 in this
> task).

---

## Sources

The abbreviations in the form `` `name.md` `` used in the text refer to
the following ACP pages (all retrieved 2026-09-25):

- `initialization.md` — <https://agentclientprotocol.com/protocol/v1/initialization.md>
- `session-setup.md` — <https://agentclientprotocol.com/protocol/v1/session-setup.md>
- `prompt-turn.md` — <https://agentclientprotocol.com/protocol/v1/prompt-turn.md>
- `cancellation.md` — <https://agentclientprotocol.com/protocol/v1/cancellation.md>
- `tool-calls.md` — <https://agentclientprotocol.com/protocol/v1/tool-calls.md>
- `authentication.md` — <https://agentclientprotocol.com/protocol/v1/authentication.md>
- `transports.md` — <https://agentclientprotocol.com/protocol/v1/transports.md>
- `extensibility.md` — <https://agentclientprotocol.com/protocol/v1/extensibility.md>
- `elicitation.md` — <https://agentclientprotocol.com/protocol/v1/elicitation.md>
- `session-config-options.md` — <https://agentclientprotocol.com/protocol/v1/session-config-options.md>
- `prompt-lifecycle.md` (v2) — <https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md>
- `rfds/updates` — <https://agentclientprotocol.com/rfds/updates.md>
- `rfds` (RFD process, definitions of Draft/Active/Preview/Completed) — <https://agentclientprotocol.com/rfds>
- `rfds/session-notices` — <https://agentclientprotocol.com/rfds/session-notices.md>
- `rfds/streamable-http-websocket-transport` — <https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md>
- `announcements/acp-v2-draft` — <https://agentclientprotocol.com/announcements/acp-v2-draft.md>

SDK/CLI (versions observed on `registry.npmjs.org` 2026-09-25):

- `@agentclientprotocol/sdk@1.5.0` — <https://registry.npmjs.org/@agentclientprotocol/sdk/latest>, SDK documentation: <https://agentclientprotocol.github.io/typescript-sdk/>
- `opencode-ai@1.18.32` — <https://registry.npmjs.org/opencode-ai/latest>; docs: <https://opencode.ai/docs/acp/>, <https://opencode.ai/docs/cli/>; source (tag): <https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/acp/service.ts>
- `@agentclientprotocol/codex-acp@1.13.1` — <https://registry.npmjs.org/@agentclientprotocol/codex-acp/latest>; source (commit `b1b8490cd165c18626dc3fe83836cdacdef94cd3`): <https://github.com/agentclientprotocol/codex-acp/blob/b1b8490cd165c18626dc3fe83836cdacdef94cd3/src/CodexAcpServer.ts>; upstream Codex CLI docs: <https://developers.openai.com/codex/cli/reference/>
- `@google/gemini-cli@0.61.0` — <https://registry.npmjs.org/@google/gemini-cli/latest>; docs (guide): <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/docs/cli/acp-mode.md>; dispatcher source: <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpRpcDispatcher.ts>; auth: <https://geminicli.com/docs/get-started/authentication/>
