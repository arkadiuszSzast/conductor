# API projections for the web UI

## Why

The web UI design session (`docs/design/web-ui/01-api-gaps.md`) verified that
phase-1 of the board/feature UI cannot be built honestly on today's HTTP API
payloads: the list payload carries no timestamps (no "age" column), the detail
payload strips per-step state (no step-level view), no route exposes the
workflow structure (no DAG layout, no gate icons), timeline events arrive as
JSON-encoded strings, findings badges would need N+1 fetches, and a browser
SPA has no way to reach the API at all (no static serving, no CORS). All the
data already exists in the store and workflow registry — the gaps are pure
projections, so filling them changes zero engine/interpreter semantics.

## What Changes

- Feature projections (list + detail) gain `createdAt`/`updatedAt` (epoch ms)
  sourced from the `feature` table's `time_created`/`time_updated` columns.
  The core `FeatureState` shape is untouched — timestamps are store metadata,
  returned by the store alongside the state, and joined into the projection
  by the API.
- The feature **detail** payload returns full per-job runtime (`status`,
  `currentStep`, `attempts`, `reruns`, `outputs`, `steps` with per-step
  status). Step outputs in the detail are truncated to a bounded length with
  a `truncated: true` marker and the `runId` of the step's newest run, so
  full output stays one `GET /v1/runs/:id` away. The list payload keeps
  today's `{status, currentStep}` summary.
- New `GET /v1/projects/workflow?dir=<projectDir>`: a structure-only
  projection of the registered workflow (`name`, `stale`, job `needs` edges,
  step ids and kinds, diagnostics). Workflow structure is a property of the
  project, not the feature — the feature detail payload only carries a light
  `workflowRef: {name, stale}` hint. No prompts, no expressions, no `with:`
  blocks ever appear in the response. Unregistered → 404; invalid (never
  successfully loaded) → 409 with diagnostics.
- Optional static SPA serving: `ApiConfig` gains `ui: {staticDir}`. When
  configured, the daemon serves `GET` assets from that directory with an
  `index.html` fallback for non-`/v1` paths; `/v1/*` always takes precedence;
  path traversal is rejected. Absent → behaviour identical to today. There is
  no default directory — no path is ever inferred from the package location
  or a home directory.
- `GET /v1/features` accepts `?status=a,b` (comma list validated against
  `FeatureStatus`; unknown value → 400).
- Feature list items gain `findingCounts: {new, fixed, dismissed, reopened}`
  computed by one grouped store query (no N+1).
- Timeline entries return `event` as a parsed object (consistent with the
  already-parsed `decisions`). Greenfield — no compatibility shim for the
  string shape.

### Decisions recorded

- **No CORS.** The daemon serves the SPA same-origin (`ui.staticDir`), which
  removes the need for `Access-Control-Allow-*` entirely. A dev SPA server
  proxies `/v1` itself — that is the dev server's concern, not the daemon's.
- **GAP-8 (`activeRun` on list items) is out of scope** — P2, consciously
  deferred; `updatedAt` carries freshness for the board.
- **GAP-9 (pagination) is out of scope** — P2 per the gap analysis.

## Capabilities

### New Capabilities

- `api`: the HTTP API's UI-facing projection contract — feature-projection
  timestamps, full per-step detail with bounded step outputs, a
  project-scoped workflow-structure route, opt-in static UI serving, a
  status filter, finding counts, and object-shaped timeline events.

### Modified Capabilities

_None — the `standalone-daemon` capability (still an active change) covers
the API's existence and command surface; this change specifies the
projection contract on top of it as its own capability._

## Impact

- `packages/server/src/store.ts` — feature reads return row timestamps
  alongside state; one grouped finding-count query; parsed timeline events.
- `packages/server/src/api.ts` — projection changes, new route, static
  serving, status-filter validation; `ApiDeps` gains a workflow-status
  lookup; `ApiConfig` gains optional `ui`.
- `packages/server/src/daemon.ts` / compositions — pass
  `registry.getStatus` where the API is constructed.
- No migrations (columns exist), no engine/interpreter changes, no
  `@conductor/core` changes, SSE unchanged.
- `docs/` — API surface notes updated.
