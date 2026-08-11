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
| `POST /v1/features` | Start a feature. |
| `GET /v1/features/:id` | Feature detail (see payloads below). |
| `GET /v1/features/:id/runs` · `/findings` · `/timeline` | Per-feature resources. Timeline entries carry `event` as a parsed object. |
| `POST /v1/features/:id/approve` · `/request-changes` · `/pause` · `/resume` · `/abandon` | Gate and lifecycle commands; responses carry the fresh feature payload. |
| `GET /v1/runs/:id` | One run, with full (untruncated) `outputs`. |
| `GET /v1/runs/:id/logs` | Cursor-incremental run-log tail: `?after=<seq>&limit=<n>`. |
| `POST /v1/runs/:id/logs` | Append log lines to a running run (step authors and runner agent-log push). |
| `POST /v1/runs/:id/report` | Agent/runner report-back. |
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
  "diagnostics": []
}
```

Structure only — prompts, expressions, `with:` payloads and retry policies
never appear. `stale: true` (with `diagnostics`) means the served snapshot
survived a failed reload of an edited `conductor.yaml`. An unregistered
project is 404; a registered project that never loaded validly is 409 with
the load diagnostics. Workflow structure belongs to the project, not the
feature — the graph view fetches here, not from the feature payload.

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
