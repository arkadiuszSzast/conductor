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
| `GET /v1/events` | SSE invalidation stream: `{kind: feature\|transition\|run\|finding, featureId}`; subscribers refetch over REST. |
| `GET /v1/features` | Feature list. Filters: `?project=<dir>`, `?active=true`, `?status=a,b` (comma list of feature statuses; unknown value → 400). |
| `POST /v1/features` | Start a feature. |
| `GET /v1/features/:id` | Feature detail (see payloads below). |
| `GET /v1/features/:id/runs` · `/findings` · `/timeline` | Per-feature resources. Timeline entries carry `event` as a parsed object. |
| `POST /v1/features/:id/approve` · `/request-changes` · `/pause` · `/resume` · `/abandon` | Gate and lifecycle commands; responses carry the fresh feature payload. |
| `GET /v1/runs/:id` | One run, with full (untruncated) `outputs`. |
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
  feature's project currently resolves to.

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
precedence. There is no default directory and the API emits **no CORS
headers**: the shipped SPA is same-origin by construction, and a dev SPA
server is expected to proxy `/v1` itself.
