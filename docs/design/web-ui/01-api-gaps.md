# API gaps — resolution record

Gaps found during the UI design pass against the original
`packages/server/src/api.ts`. **All P0 and P1 landed in PR #23
(`36e7071`, `api-ui-projections`)**; the shipped reference is
`docs/http-api.md`. This file stays as the record of what the UI asked
for, what shape it actually shipped in (GAP-4 was remodeled), and the two
conscious deferrals.

## Landed

### GAP-1 → ✅ `?status=a,b` on `GET /v1/features`
Comma list of feature statuses, composes with `?project=` and
`?active=true`; unknown value → `400 invalid_request`. The board still
groups client-side into sections, but filtered fetches (e.g. terminal
states on demand) are now possible.

### GAP-2 → ✅ `createdAt` / `updatedAt`
Epoch ms, on list items and detail, sourced from the store row (not the
core interpreter state). The board's age column builds from the list
alone.

### GAP-3 → ✅ full per-step runtime in detail
`GET /v1/features/:id` returns `jobs.<id>: {status, currentStep, attempts,
reruns, outputs, steps}` with `steps.<id>: {status, outputs, truncated?,
runId?}`. Output values are cut at 500 chars; `truncated: true` comes with
the `runId` of the step's newest run → full output via `GET /v1/runs/:id`
(robust even when the run falls outside the 100-run history window). The
list payload deliberately keeps the `{status, currentStep}` summary.

### GAP-4 → ✅ workflow structure — shipped per-PROJECT, not per-feature
`GET /v1/projects/workflow?dir=<projectDir>` →

```json
{
  "name": "default",
  "stale": false,
  "jobs": {"implement": {"needs": ["design"], "steps": [{"id": "code", "kind": "agent"}]}},
  "diagnostics": []
}
```

Structure only — no prompts, expressions, `with:` payloads or retry
policies. `kind ∈ agent|command|action|human`. Codes: `404` unregistered,
`409` registered-but-never-valid (diagnostics in `message`), `200` for
valid **and** stale (`stale: true` + `diagnostics` when the last-good
snapshot is being served after a broken edit). The feature detail carries
only the hint `workflowRef: {name, stale} | null`; the UI fetches the
graph from the project endpoint using `feature.projectDir` as `dir`.

**Consequence for the design:** a faithful DAG (needs edges, declaration
step order, human-gate icons via `kind: "human"`) is fully buildable. The
interim run/timeline reconstructions documented in earlier drafts of the
variants have been removed. Known caveat (by design): the projection is
the project's *current* snapshot — a feature started before a workflow
edit renders against the newer graph. Mitigation: `workflowRef.stale` /
endpoint `stale` → "workflow changed since this feature started" hint.

### GAP-5 → ✅ `findingCounts` on list items
`{new, fixed, dismissed, reopened}` per item (one grouped query
server-side; zeros when none). Board badges without N+1.

### GAP-6 → ✅ timeline `event` is a parsed object
`{kind: "step.completed", ...}` directly in the response. No client-side
`JSON.parse`.

### GAP-7 → ✅ variant (a): the daemon serves the SPA
`ApiConfig.ui: {staticDir}` (explicit, no default): `GET`/`HEAD` on
non-`/v1` paths serve files with extension-derived content types,
unmatched paths fall back to `index.html`, traversal rejected, `/v1/*`
takes precedence. Static assets are unauthenticated (page loads cannot
attach a bearer header); `/v1` stays guarded. **No CORS headers and none
planned** — the shipped SPA is same-origin; a dev SPA server proxies `/v1`
itself (e.g. Vite `server.proxy`).

## Consciously deferred

### GAP-8 — no `activeRun` on list items
"Running for 12 m" per board row remains unavailable; freshness comes from
`updatedAt`. Revisit if the board needs live per-row run clocks.

### GAP-9 — no pagination
`runs` limit 100, `timeline` limit 50, no cursors; `listFeatures`
unbounded. Fine at self-hosted scale; revisit when long rerun loops can
accrue >100 runs per feature.

### GAP-10 — retry/rerun budgets not in the workflow projection — P2

**Today:** `/v1/projects/workflow` is structure-only (needs, step ids,
kinds). `retry.maxAttempts` and `rerun.maxRounds` are not exposed, so the
graph can show raw counters (`JobRuntime.attempts`, `JobRuntime.reruns`)
but never "attempt 2/3" or "round 2/5". The only place a budget surfaces
is the escalation reason string ("maxRounds exhausted (3/3)").
**Proposal:** optional per-step `budgets` in the projection
(`{retry?: {maxAttempts}, rerunMaxRounds?: n}` for steps whose outcomes
map to rerun routes). Still structure-only — no prompts.
**Interim:** raw counts; the escalation reason carries the
saturated-budget story exactly when it matters.

## Requested next (specified separately)

**GAP-11 (run logs)** and **GAP-12 (feedback snapshot in detail)** came
out of the variant-A step-inspector and loop-edge review — full handoff
spec for the server-side agent lives in `02-api-extensions-request.md`.

## Non-gaps (verified in code, still true)

- **Health**: `GET /v1/health` carries everything the indicator needs —
  `alive, ready, phase`, `heartbeat.{lastCompletedAt,lastError,cycles}`,
  `projects[].state` (`unregistered/valid/stale/invalid`) with
  `diagnostics[]`, `runner: available/unavailable`.
- **Escalation reason** (`feature.escalation`, string) is on both list and
  detail payloads — the board shows *why* without opening the feature.
- **Gate discovery**: when several jobs run concurrently, global
  `currentStep` is `null` by design, but per-job `currentStep` +
  `feature.status === "waiting_human"` identifies the gate job; with
  GAP-4 landed, `kind: "human"` confirms the gate step exactly.
- **Command responses carry fresh state** (`approve`, `request-changes`,
  `pause`, `resume`, `abandon`) — no refetch after own writes.
- **Conflict semantics**: `409` with a human-readable `message` on raced
  gate decisions and on pause/abandon of terminal features.
- **SSE shape**: `change` events `{kind: feature|transition|run|finding,
  featureId}` + `hello` frame + `retry: 2000`. Client note: `EventSource`
  cannot send the bearer header → use a fetch-based SSE reader.
- **RunSummary** includes `outputs`, `nudges`, `reason`, `attempt`,
  `sessionId` — the runs list needs no per-run follow-up fetch (except
  via `runId` when a detail step reports `truncated`).
