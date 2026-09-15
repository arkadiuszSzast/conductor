# HTTP API v1

The daemon's control surface: REST plus an SSE invalidation stream. The API
is a pure projection over the store and workflow registry — commands route
through the same engine methods every other client uses, and no workflow
logic lives in the HTTP layer. Errors share one envelope:
`{error: {code, message, requestId}}`.

Authentication is explicit (`auth.mode: "none"` or `"bearer"`); only
`/v1/livez` and `/v1/readyz` are unauthenticated.

## Routes

| Route | Description |
|---|---|
| `GET /v1/livez`, `GET /v1/readyz` | Probes (unauthenticated). |
| `GET /v1/health` | Full daemon health snapshot: heartbeat, per-project workflow state (`valid`/`stale`/`invalid`/`unregistered`) with diagnostics, runner availability. |
| `GET /v1/events` | SSE invalidation stream: `{kind: feature\|transition\|run\|finding\|run_log, featureId}` or `{kind: "plugins"}`; subscribers refetch over REST. `run_log` notifications are throttled at the source (at most one per run per second). |
| `GET /v1/features` | Feature list. Filters: `?project=<dir>`, `?active=true`, `?status=a,b` (comma list of feature statuses; unknown value → 400). |
| `POST /v1/features` | Start a feature (below). |
| `GET /v1/features/:id` | Feature detail (see payloads below). |
| `GET /v1/features/:id/runs` · `/findings` · `/timeline` | Per-feature resources. Timeline entries carry `event` as a parsed object. |
| `POST /v1/features/:id/approve` · `/request-changes` · `/pause` · `/resume` · `/abandon` | Gate and lifecycle commands; responses carry the fresh feature payload. |
| `POST /v1/features/:id/recover` | Re-arm an escalated feature's currently recoverable failed/blocked step (below). |
| `GET /v1/runs/:id` | One run, with full (untruncated) `outputs`. |
| `GET /v1/runs/:id/logs` | Cursor-incremental run-log tail: `?after=<seq>&limit=<n>`. |
| `POST /v1/runs/:id/logs` | Append log lines to a running run (step authors and runner agent-log push). |
| `POST /v1/runs/:id/report` | Agent/runner report-back (`outcome`/`verdict`), or a mid-step `ask`. |
| `POST /v1/runs/:id/answer` | Human answers a run's pending question; the notes flow into the live session. |
| `GET /v1/projects/workflow?dir=<projectDir>` | Structure-only workflow projection (below). |
| `GET/POST /v1/runners`, `DELETE /v1/runners/:id` | Runner endpoint registration (when a registry is configured). |
| `GET /v1/plugins`, `POST /v1/plugins/session`, `ANY /v1/plugins/:id/*` | Plugin listing, session cookie exchange, and per-plugin reverse proxy (below; when a plugin control is configured). |

## Runner registration and callback health

`POST /v1/runners` accepts `{name, endpoint, token?, projects}`. Endpoint
refresh preserves its id and unions projects. Registrations expire 60 seconds
after the last announce; the opencode hub already announces every 15 seconds.
`GET /v1/runners` projects `{id, name, endpoint, projects, registeredAt,
expiresAt}` for unexpired registrations, never callback tokens. Daemon health
reports runner availability from this lease-fresh set, not a successful probe.
Different live endpoints on the same host are never superseded by hostname/PID.

Runner callbacks must implement `GET /v1/health` using the same authentication
as session routes, returning `200 {"ok": true}` when ready. The daemon probes
before each write with a 10-second timeout and no redirects. Only definitive
pre-connect failure permits skipping an endpoint. Rejected/inconclusive probes
send no write and enter bounded runner resource waiting; ambiguous POST
reset/timeout propagates through ordinary failure handling without transport
replay. HTTP write errors are not registration eviction signals.

Deploy the updated runner callback before the daemon, or update both together.
An old callback without health support safely blocks writes until upgraded.
No database migration or configuration change is required.

## Feature payloads

Both list items and the detail carry the feature state plus projection
metadata: `escalation`, `currentStep`, `createdAt`/`updatedAt` (epoch ms,
from the store row — not part of the core interpreter state).

- **List items** additionally carry
  `findingCounts: {new, fixed, dismissed, reopened}` (one grouped query
  server-side) and a per-job summary `jobs: {<id>: {status, currentStep}}`.
- **Detail** returns the full per-job runtime: `status`, `currentStep`,
  `attempts`, `reruns`, job `outputs`, and `steps` with per-step `status`
  and `outputs`. Step output values longer than 500 characters are cut and
  the step is marked `truncated: true` with the `runId` of its newest run —
  the full output stays available via `GET /v1/runs/:id`. The detail also
  carries `workflowRef: {name, stale} | null` — a hint at the workflow the
  feature's project currently resolves to — and `feedback` (detail only,
  never on list items). When the feature is `escalated`, the detail
  additionally carries `recoverableTargets: [{jobId, stepId}]` — every
  currently recoverable job/step, in the order `POST .../recover` would
  pick as its default (untargeted) choice; absent otherwise.

### Activity projection

Both list items and the detail carry `activity`, a derived summary a
client can render directly without re-deriving "is anything actually
happening" from raw job/run state:

```json
{
  "state": "waiting_retry",
  "activeCount": 0,
  "targets": [],
  "target": { "jobId": "main", "stepId": "implement" },
  "reason": "transient_upstream",
  "diagnostic": "provider 503",
  "nextAt": 1732000030000,
  "deadlineAt": 1732000600000,
  "message": "No agent is active — waiting for the next retry."
}
```

`state` is one of `active` | `waiting_retry` | `blocked` | `waiting_human`
| `paused` | `escalated` | `terminal`:

- `blocked` — a durable resource wait is open (no compatible runner /
  binding yet); `target`/`reason`/`diagnostic` describe it, `nextAt` is
  the next observation time, `deadlineAt` is the wait's finite deadline.
- `waiting_retry` — a durable retry episode is scheduled; `reason` is the
  classified failure class, `diagnostic` its bounded message, `nextAt` the
  scheduled attempt time, and `deadlineAt` the retry's elapsed budget
  deadline (`startedAt + maxElapsedMs` for that class — see
  [Retries, failure classes and recovery](concepts.md#retries-failure-classes-and-recovery)).
  An attempt past `deadlineAt` is never dispatched — the client should not
  expect `nextAt` to still fire once `deadlineAt` has passed.
- `waiting_human` | `paused` | `escalated` | `terminal` (`done`/
  `abandoned`) mirror the feature's own status.
- `active` — the fallback: the feature is `running` with no open
  wait/retry; `activeCount`/`targets` list the live runs (empty
  `activeCount` with `running` status and no wait/retry is itself worth
  surfacing — the `message` calls this out explicitly rather than reading
  as "everything is fine").

`target`/`reason`/`diagnostic`/`nextAt`/`deadlineAt` are `null` outside
`blocked`/`waiting_retry`. `message` is always a short, human-readable
sentence version of the same information — safe to render directly
without a client-side switch on `state`.

### Feedback lifecycle

`feedback` is the rerun feedback snapshot the engine persists:
`{jobs: {<jobId>: {<stepId>: {<name>: <value>}}}, message} | null`. Its
lifecycle follows the engine's persistence semantics exactly:

- It is **written only by a rerun transition** — the routing step's
  rejection/changes-requested outcome that resets target jobs/steps. The
  snapshot carries the outputs of the completed steps feeding the rerun
  and a message describing the routing outcome.
- It is **never cleared**. Once a feature has gone through its first
  rerun, the snapshot persists for the feature's lifetime — completing
  the loop, approving the gate, or finishing the feature does not null
  it.
- A **later rerun replaces it** wholesale with the new round's snapshot.

A client that needs "is a rerun loop in flight right now" must therefore
combine the snapshot with live job state (a job named in `feedback.jobs`
is active again with `reruns > 0`) — the snapshot's mere presence only
means "at least one rerun has ever happened".

### Recovering an escalated feature

`POST /v1/features/:id/recover` body:

```json
{
  "notes": "the flaky provider is back — retry",
  "target": { "jobId": "deliver", "stepId": "pr_create" },
  "expectedVersion": 1732000000000,
  "idempotencyKey": "op-123"
}
```

- `notes` is required (non-empty).
- Target selection takes **exactly one** of three forms (combining them
  is `422 invalid_request`):
  - `target` — one `{jobId, stepId}` (backwards compatible);
  - `targets` — a non-empty array of `{jobId, stepId}` to recover
    several failed steps in one atomic operation;
  - `all: true` — every currently recoverable candidate, resolved
    server-side under the same version check.
- Candidates come from the CURRENT durable failed/blocked frontier
  (`recoverableTargets` on the detail payload, or GET the feature
  first) — open resource waits and failed jobs' failed steps — never
  from run history alone; history only orders and explains candidates.
  - Zero candidates: `409 conflict`, "no recoverable failed or blocked
    step found".
  - Exactly one candidate and no selection: recovers it (backwards
    compatible).
  - More than one candidate and no selection: `409` with
    `code: "ambiguous_target"`, a top-level `targets: [{jobId,
    stepId}]` array to choose from, and `allowAll: true` advertising
    the recover-all form.
  - Any named target (in `target` or `targets`) not among the current
    candidates: `409` with `code: "stale_target"` — the WHOLE request
    is rejected, nothing re-armed, no fallback to another candidate.
- All selected targets are re-armed in **one transaction**: one version
  check, one idempotency key, one `human.recovered` transition row
  carrying every `execute_step` decision — a partial re-arm is never
  observable. The `200` response carries `recovered: [{jobId, stepId}]`
  listing what was re-armed.
- `expectedVersion` (the feature's `updatedAt` your view was rendered
  from) rejects with `409 stale_version` if the feature moved since —
  this also bounds `all`: a stale view can never silently widen the
  recovered set.
- `idempotencyKey` dedupes a retried delivery of the same logical
  recover: a repeat with the same key returns `200` with the fresh
  feature payload and no new work armed.
- On success, every recovered step's retry budget resets — a fresh
  finite episode per step, chained to its prior one for audit history —
  so a subsequent failure of a recovered step gets its own
  attempt/elapsed allowance instead of inheriting the exhausted one's
  count.
- **Recover notes reach the agent.** The `notes` string is stamped
  onto the recovered step's `run` row (`run.recoverNotes`, surfaced by
  `GET /v1/runs/:id`) AND injected into the agent session prompt as a
  deterministic `[conductor] This step was recovered by an operator.
  Operator notes:\n<notes>\n\n` block in the same header that already
  carries the `[conductor] Job ... step ...` line. The propagation is
  durable across a daemon restart between the recover commit and the
  actual dispatch (the `recovery_dispatch` outbox row is the source of
  truth), so the agent sees the operator's intent on every future
  recovery, including every automatic retry in that target's recovery
  episode. Scheduled retries and runner resource waits retain the same
  literal notes, even across restart. Completion, terminal routing and
  rerun/reset end inheritance; later jobs or loops receive no old notes.
  A subsequent recover replaces the selected target's guidance. Historical
  run snapshots remain unchanged. Migration 0020 does not reactivate
  already-consumed pre-upgrade notes; those need a separately authorized
  new recovery. A normal first-attempt prompt has no recovery block. See
  `openspec/changes/recover-notes-to-agent` for the design.

## Starting a feature

`POST /v1/features` body:

```json
{
  "title": "Add dark mode",
  "project": "/path/to/project",
  "description": "optional task text",
  "workflow": "optional — the workflow name the caller observed",
  "pr": 123,
  "inputs": { "feature": "auth", "count": 5 }
}
```

`title` and `project` are required; every other field is optional. `inputs`
is a JSON object of input name → value matching the workflow's declared
`InputDef`s (see [Workflow structure](#workflow-structure) below) —
**omitting the field entirely** is equivalent to `{}`, so existing requests
against a workflow with no required inputs remain valid unchanged. An
explicit `"inputs": null` is NOT the same as omitting the field: it is a
non-object payload like any other and is rejected (see below), never
silently treated as `{}`.

Any typed HTTP/API client (the browser Control Room, the daemon-client
`ApiClient` the CLI uses internally, or a hand-rolled integration) may
send `inputs` on this request — the wire contract and the resolution
behaviour below are the same regardless of caller. The `conductor start`
CLI **command's own syntax is unchanged**: it has no `--inputs`-style flag
today, so a human running it starts a feature exactly as before (defaults
apply for any declared optional inputs; a workflow with required inputs
and no other client to supply them rejects the start, same as any other
caller that omits them).

Before any feature, run, session, command or action is created, the daemon
resolves `inputs` against the project's currently valid (or retained-stale)
workflow snapshot — the same canonical, deterministic resolver every client
shares:

- an unknown input name, a missing required input, or a value whose JSON
  type does not exactly match its declared `string`/`number`/`boolean`
  (a non-finite number counts as the wrong type) is rejected;
- a non-object `inputs` payload (a string, array, `null`, or anything else
  that is not a JSON object) is rejected outright, before any per-input
  check runs;
- an omitted optional input is filled from its declared default.

A rejected request has **no side effects** — nothing is created — and
responds `422` with the standard error envelope plus a `diagnostics` array
naming every problem found (not just the first):

```json
{
  "error": { "code": "invalid_input", "message": "...", "requestId": "..." },
  "diagnostics": [
    { "name": "feature", "kind": "missing_required", "message": "input \"feature\" is required (type: string)" }
  ]
}
```

`diagnostics[].kind` is one of `invalid_payload` | `unknown_input` |
`missing_required` | `wrong_type`; `name` is absent only for
`invalid_payload` (the payload itself, not a specific input, is wrong).
This is distinct from `project_not_configured` (no valid workflow for the
project) and `unknown_workflow` (the caller's observed `workflow` no
longer matches what the project currently resolves to) — both unchanged
by this validation and checked first. A successful start persists the
fully resolved input map on the feature (`feature.input`) before
`feature.start` dispatches, so the first agent/command/action step's
`{{ inputs.<name> }}` template context sees it immediately.

## Run logs

Every run accumulates a bounded, per-run narrative log in SQLite: command
steps persist their chronologically-interleaved stdout/stderr
(`source: "process"`), action executions log through the action host
(`source: "action"`), the opencode runner streams agent session output
(`source: "agent"`, pushed from the plugin on a ~1 s debounce), and step
authors append custom lines (`source: "step"`, the default). Log lines
never appear inside feature or run payloads — the endpoints below are the
only way to read them.

Storage is capped at **2 MB of chunk text per run**, enforced at write
time by dropping the oldest lines (the tail survives); appends never fail
because of the cap. Retention beyond the per-run cap (pruning on feature
terminal state, retention windows) is deliberately out of scope for now.

### `GET /v1/runs/:id/logs?after=<seq>&limit=<n>`

Bearer-authenticated. Returns

```json
{
  "lines": [{"seq": 1, "time": 1767600000000, "source": "process", "text": "…"}],
  "nextSeq": 1,
  "truncated": false
}
```

- `after` returns only lines with `seq` strictly greater than the cursor
  (default 0). `nextSeq` is the highest `seq` the caller has seen — a
  client tails by refetching `after=nextSeq`.
- `limit` bounds the page; default 500, hard maximum 2000 (larger values
  are clamped). `truncated: true` means more lines exist beyond the page.
- Unknown run → 404 in the standard error envelope. Non-integer `after`/`limit` → 400.

### `POST /v1/runs/:id/logs`

Bearer-authenticated. Body: `{lines: [{text, source?}]}`.

- `source` defaults to `"step"`; the only accepted values are `"step"`
  and `"agent"` — anything else → 400 (`process`/`action` are daemon-
  internal sources and can never be forged over HTTP).
- An empty/malformed `lines` array → 400. At most 2000 entries per
  request; each line's `text` is bounded at 64 KiB (oversized → 400), so
  a single request can never blow through the per-run storage cap.
- Appends to a run that is no longer `running` → 409
  (`run_already_concluded`, consistent with the report route) — a runner's
  late agent-log flush after conclusion is dropped this way. Unknown run → 404.
- A successful append emits a `run_log` SSE invalidation event (throttled
  to at most one per run per second), so an open inspector can refetch the
  tail.

### Structured review reports

An agent configured with `reviewHead` must send a successful review as:

```json
{
  "verdict": "changes_requested",
  "notes": "One accepted blocker",
  "review": {
    "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "findings": [{
      "path": "src/example.ts",
      "line": 12,
      "severity": "major",
      "blocking": true,
      "body": "Describe the reachable bug and required correction.",
      "acceptanceTests": ["tests/example.test.ts: invalid input is rejected"],
      "status": "new"
    }]
  }
}
```

CLI: `conductor report <run-id> --verdict changes_requested --review @review.json`.
The file contains the `review` object, not the entire request.
The opencode runner's `conductor_report` tool accepts the same optional `review`
object alongside `run_id`, `verdict` and optional `notes` (not a JSON-encoded string).
The tool forwards it unchanged; the daemon checks configured-head freshness,
verdict consistency, gate ownership and lifecycle before atomic completion.
The tool does not infer a verdict or override a contradictory one. Ordinary reports
omit `review`. This requires the updated runner plugin as well as the daemon;
already-loaded older tool schemas cannot submit the object until a separately
approved runtime upgrade/reload.
Unknown review/finding
fields are rejected. Head must be a full lowercase 40/64-character Git SHA matching
the configured template. Locations are relative paths and positive line numbers;
severity is blocker/major/minor/nit; blocking is an explicit boolean independent of
severity. Blocking findings require nonempty acceptance-test descriptions/locations.
These descriptions are not automatically executed as shell commands.

New entries omit `id` and use status `new`. The daemon allocates feature-local F IDs.
Every previous finding owned by this job/step must be included by ID, including
fixed/dismissed findings. Status fixed/dismissed/reopened requires a nonempty
`resolution`; reactivating a fixed/dismissed ID requires `reopened`. Another gate's
IDs cannot be updated. No semantic deduplication or automatic prose parsing occurs.

Active blockers (new/reopened and blocking=true) require `changes_requested`;
otherwise the verdict must be `approved`. Invalid reports return 400 and leave the
run active without mutation. Failed reports may omit review; review cannot accompany
failure or ask. Unconfigured steps reject structured payloads but retain plain notes.

Completion atomically updates existing findings, routing and immutable
`outputs.work_order` JSON containing the accepted review plus source run/job/step.
The findings endpoint adds `blocking` (null for old unclassified rows),
`acceptanceTests`, `sourceJobId`, `sourceRunId`, and `reviewedHead`.
Duplicate completion remains 409 without finding mutations.

### `POST /v1/runs/:id/report` — the `ask` shape

Besides `outcome` and `verdict`, a running agent run may report
`{ask: "<question>"}` — the three shapes are mutually exclusive. An ask
does NOT conclude the run: the session stays alive, the question is
persisted on the run (`pendingQuestion`, `askedAt` — restart-safe) and the
feature flips to `waiting_human`. Asking on a concluded run → 409
(`run_already_concluded`), same as a stale report. The feature detail's
`activeRun` prefers an asking run over the merely-newest one so answering
surfaces always see the question.

Asking is a per-step privilege: only agent steps declared
`interactive: true` in the workflow may ask. An ask from any other step is
refused with a 200 whose result text instructs the agent to decide
autonomously and report an outcome — no state changes, the run stays
running. The workflow-structure projection marks such steps with
`interactive: true`.

### `POST /v1/runs/:id/answer`

Bearer-authenticated. Body: `{notes: string}` (required, non-empty).

Acceptance and delivery are two separately durable steps (see
[Answer delivery](concepts.md#answer-delivery-accepted-durably-before-it-is-delivered)):
the notes are persisted **before** any attempt to forward them into the
run's session, so this call returning success never depends on the
session actually receiving the prompt. Delivery is attempted immediately
for low latency and, if it doesn't land right away, retried by the
reconciler until confirmed — no new call to this endpoint is needed. The
response's `run` field carries the fresh run projection with
`answerDelivery` (below) reflecting whichever of the outcomes applied.
Errors:

- unknown run → 404 (`not_found`)
- run not running, no pending question, **or a prior answer for the same
  question is already accepted and awaiting delivery** → 409
  (`no_pending_question` — the same code covers all three; a repeated
  answer while the first is accepted-but-undelivered is a conflict, never
  an idempotent replacement)
- session gone, or the immediate delivery attempt hit a TERMINAL
  (deterministic/invalid/internal) prompt error → 409 (`session_lost`) —
  the step is concluded `failed` through normal failure routing
  (retry/onFail), never left as a zombie wait. A TRANSIENT prompt error
  (transport/capacity/upstream/timeout) on the immediate attempt does
  **not** surface as `session_lost`: this call still returns 200 (see
  [bounded delivery retries](concepts.md#answer-delivery-accepted-durably-before-it-is-delivered)
  below), and only reconciler-driven retries exhausting that bounded
  schedule eventually route to failure — which, like any LATER
  reconciler-driven delivery attempt, obviously can't surface as this
  request's response.

#### `answerDelivery` projection

Every run projection (`GET /v1/runs/:id`, the feature detail's
`activeRun`/`activeRuns`, `GET /v1/features/:id/runs`, and the `run` field
returned by this endpoint and by `/report`) additively carries
`answerDelivery: {status: "pending" | "claimed", acceptedAt: <epoch ms>}`
whenever an answer has been accepted for that run's question but not yet
confirmed delivered. It sits alongside the run's existing
`pendingQuestion` — the question stays visible, but `answerDelivery`'s
presence tells a client the human has already acted and delivery is in
flight, so the answer form should disable resubmission instead of
offering it again or claiming the feature is already back to `running`.
The field is **absent** once delivery is confirmed, fails, or was never
accepted — existing clients that only read `pendingQuestion` see no shape
change.

#### Bounded delivery retry schedule and terminal behavior

A delivery attempt that fails with a TRANSIENT classification
(transport/capacity/upstream/timeout) is retried on a finite,
exponentially-backed-off schedule — up to 5 attempts, 1s initial delay
doubling to a 60s cap with full jitter, bounded by a 10-minute elapsed
deadline measured from acceptance — the same class-default budget a
step's own transient retries use. `answerDelivery.status` stays `pending`
across these retries (a client sees no visible change between one and
several transient retries); exhausting either bound concludes the step
`failed` through the run's normal `retry`/`onFail` routing, exactly like
a session-gone or terminal prompt error. A DETERMINISTIC/INVALID/INTERNAL
prompt error is never retried — it routes to that same failure on its
first attempt. This bound exists specifically so a persistently
unreachable session/runner cannot keep a delivery `pending` — and,
correspondingly, the feature `waiting_human` — forever.

Confirming a delivery also verifies the run's currently open question is
still the SAME one this delivery answers (not merely that some question
is pending) — guarding against the delivery's at-least-once redelivery
edge landing after the agent has already asked a newer question. A
mismatch atomically cancels the stale delivery instead of confirming it,
leaving the newer question completely untouched; the run's
`pendingQuestion`/`answerDelivery` then reflect that newer question as
normal.

## Workflow structure

`GET /v1/projects/workflow?dir=<projectDir>` returns

```json
{
  "name": "default",
  "stale": false,
  "jobs": {
    "implement": {
      "needs": ["design"],
      "steps": [{"id": "code", "kind": "agent"}, {"id": "approve", "kind": "human"}]
    }
  },
  "inputs": {
    "feature": { "type": "string", "presence": "required" },
    "count": { "type": "number", "presence": "optional", "default": 3 }
  },
  "diagnostics": []
}
```

Structure only — prompts, expressions, role/model bindings, `with:`
payloads and retry policies never appear. `inputs` is the ONE exception to
"structure only": it is the workflow's declared `InputDef` map (per input:
`type`, `presence`, and `default` when `presence` is `optional`) — safe to
expose because defaults and required/optional presence are user-facing
start-form values, not authoring secrets. It is exactly what
`POST /v1/features`'s `inputs` (see [Starting a feature](#starting-a-feature)
above) resolves against, from the same snapshot served here — including a
stale one. `stale: true` (with `diagnostics`) means the served snapshot
survived a failed reload of an edited `conductor.yaml`; its `inputs` are
the retained snapshot's, not any newer (possibly broken) edit.
`diagnostics` here is an array of **plain message strings** — unlike
`GET /v1/health`'s per-project diagnostics (`{sourcePath, message}`), this
route never includes `sourcePath`: it is an absolute path on the daemon's
own filesystem, and this route promises structure-only, browser-facing
content. An unregistered project is 404; a registered project that never
loaded validly is 409 with the load diagnostics (same messages, joined
into the error's `message`). Workflow structure belongs to the project,
not the feature — the graph view fetches here, not from the feature
payload.

## Plugins

These routes are absent (404, `not_found`) when the daemon has no plugin
control configured (`ApiDeps.plugins` unset) — same "absent optional
dependency → 404" convention as `/v1/runners`. See [Plugins](plugins.md)
for the manifest, backend, and bridge contracts these routes expose.

### `GET /v1/plugins?project=<id>`

Bearer-authenticated (or plugin-session cookie — see below). Returns

```json
{
  "enabled": true,
  "plugins": [
    {
      "id": "openspec",
      "scope": "project",
      "project": "proj-1",
      "panel": { "title": "OpenSpec", "icon": "list-checks" },
      "state": "running",
      "diagnostics": []
    }
  ],
  "diagnostics": []
}
```

- `plugins[].project` is present only for `scope: "project"` entries.
- `plugins[].state` is one of `running` | `stopped` | `disabled` | `error`.
- `plugins[].diagnostics` are diagnostics scoped to that one plugin (e.g.
  it shadows another plugin). The top-level `diagnostics` are load-level
  (broken manifests, same-scope id conflicts) not tied to any one
  registered plugin.
- The optional `project` query parameter scopes the listing: global
  plugins not shadowed for that project, plus that project's own plugins.
  Omitting it returns every discovered plugin, unfiltered.
- A `plugins` SSE frame (`{"kind": "plugins"}` on `GET /v1/events`) is
  emitted whenever a plugin's state changes (spawn, crash, restart,
  budget exhaustion, shutdown) — refetch this listing on it.

### `POST /v1/plugins/session`

Bearer-authenticated (harmless no-op under `auth.mode: none`). Mints a
session cookie scoped to the plugin namespace and returns `204`:

```
Set-Cookie: conductor_plugin_session=<64-hex-char value>; Path=/v1/plugins; HttpOnly; SameSite=Strict; Max-Age=43200
```

The daemon accepts **either** the `Authorization` bearer header **or**
this cookie for any `/v1/plugins/...` request — nowhere else on the API.
Sessions are in-memory only (a daemon restart invalidates every issued
cookie); the TTL is 12 hours. This exists because iframe navigations and
panel-originated `fetch` calls cannot attach a bearer header — the SPA
performs this exchange once after login.

### `ANY /v1/plugins/:id/*`

Reverse-proxies to the resolved plugin's backend (or serves its static
`ui/` directory for a backend-less plugin), stripping the
`/v1/plugins/:id` prefix so the backend sees the root-relative remainder
— `GET /v1/plugins/openspec/changes` reaches the backend as `GET
/changes`. Accepts the same optional `?project=` query parameter as the
listing to disambiguate a project-scoped plugin from a global plugin
sharing its id; without it, resolution prefers a global plugin, falling
back to the first project plugin with that id.

Header handling: the daemon's own `Authorization` header is never
forwarded to the backend; hop-by-hop headers (`Connection`, `Keep-Alive`,
`Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`) and `Proxy-*` headers are
stripped from both the request and the response. Request bodies are
streamed through unmodified.

Errors use the standard envelope:

- unknown plugin id, or a plugin currently `disabled` → `404 not_found`
  (a disabled plugin's backend is never reached),
- a plugin whose backend isn't running (parked in `error`, no live port)
  or whose connection fails outright → `503 unavailable`.

A static-only plugin serves `/v1/plugins/:id/ui/*` through the same
hardened static-file rules the daemon uses for the SPA (traversal
rejected); any other path on a backend-less plugin is `404 not_found`.

## Static UI serving

`ApiConfig.ui: {staticDir}` opts the daemon into serving a built SPA from an
explicitly configured directory: `GET`/`HEAD` on non-`/v1` paths serve files
with extension-derived content types, unmatched paths fall back to
`index.html`, path traversal is rejected, and `/v1/*` always takes
precedence. Static assets are served without authentication (a browser's
page-load and asset fetches cannot attach a bearer header); everything under
`/v1` stays guarded. There is no default directory and the API emits **no CORS
headers**: the shipped SPA is same-origin by construction, and a dev SPA
server is expected to proxy `/v1` itself.
