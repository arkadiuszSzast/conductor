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
| `GET /v1/events` | SSE invalidation stream: `{kind: feature\|transition\|run\|finding\|run_log, featureId}`; subscribers refetch over REST. `run_log` notifications are throttled at the source (at most one per run per second). |
| `GET /v1/features` | Feature list. Filters: `?project=<dir>`, `?active=true`, `?status=a,b` (comma list of feature statuses; unknown value → 400). |
| `POST /v1/features` | Start a feature (below). |
| `GET /v1/features/:id` | Feature detail (see payloads below). |
| `GET /v1/features/:id/runs` · `/findings` · `/timeline` | Per-feature resources. Timeline entries carry `event` as a parsed object. |
| `POST /v1/features/:id/approve` · `/request-changes` · `/pause` · `/resume` · `/abandon` | Gate and lifecycle commands; responses carry the fresh feature payload. |
| `GET /v1/runs/:id` | One run, with full (untruncated) `outputs`. |
| `GET /v1/runs/:id/logs` | Cursor-incremental run-log tail: `?after=<seq>&limit=<n>`. |
| `POST /v1/runs/:id/logs` | Append log lines to a running run (step authors and runner agent-log push). |
| `POST /v1/runs/:id/report` | Agent/runner report-back (`outcome`/`verdict`), or a mid-step `ask`. |
| `POST /v1/runs/:id/answer` | Human answers a run's pending question; the notes flow into the live session. |
| `GET /v1/projects/workflow?dir=<projectDir>` | Structure-only workflow projection (below). |
| `GET/POST /v1/runners`, `DELETE /v1/runners/:id` | Runner endpoint registration (when a registry is configured). |

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
  never on list items).

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
Delivers a human's answer to an asking run: the notes are forwarded as a
prompt **into the run's existing session**, the pending question is
cleared, and the feature returns to `running`. Errors:

- unknown run → 404 (`not_found`)
- run not running or no pending question → 409 (`no_pending_question`)
- session gone / prompt delivery failed → 409 (`session_lost`) — the step
  is concluded `failed` through normal failure routing (retry/onFail),
  never left as a zombie wait.

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
