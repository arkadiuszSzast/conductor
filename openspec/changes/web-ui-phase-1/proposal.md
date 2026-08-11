## Why

The daemon's entire control surface today is the HTTP API and the CLI —
there is no visual surface for the operator's two questions ("where am I
needed?" and "what is happening right now?"). The UI design session
(`docs/design/web-ui/`) verified that every field every wireframe needs is
already served by the API after PR #23/#24 (`api-ui-projections`,
`run-log-capture`), and picked **variant A — Control Room**: a kanban board
with an inline workflow-graph expansion plus a full feature view. The
operator benefit is the GHA-familiar "work flows across status columns, the
graph answers where we are" reading; the repo guardrail ("the GitHub Actions
mental model is the UX benchmark") is the benchmark this UI mirrors.

## What Changes

- **New `apps/web` SPA** (`@conductor/web`): React 19 + wouter + CSS Modules
  + Vite, built to a static bundle. Two routes only — the board (default)
  and the per-feature view — plus an auth gate. No query library, no CSS
  framework: a hand-rolled `apiFetch` + fetch-based SSE invalidation store
  (`useSyncExternalStore`), and a token file + CSS Modules for styling.
- **Board** (Control Room): kanban columns — a fused `waiting_human` +
  `escalated` "NEEDS YOU" zone, `running`, `paused`, collapsed terminal
  columns. Cards carry status glyph + age, title, project basename +
  workflow name, gate/current step, jobs progress `n/n`, findings badge,
  escalation reason. Selecting a card pins the workflow-graph strip below.
- **Workflow graph** (`<WorkflowGraph>`, shared by the board strip and the
  feature view): hand-rolled layered SVG DAG from `GET /v1/projects/workflow`
  (needs edges, declaration step order, step kinds) joined with the live
  per-step runtime from the feature detail (status, attempts, reruns).
  Current node reads from color alone (amber treatment); pending downstream
  edges dashed/dim; rerun back-edges drawn only while a round is in flight;
  `skipped` gets the ⤼ glyph; a `⟲ round N` chip carries rerun history.
- **Step inspector**: clicking a node opens a drawer/side panel with
  Outputs (≤500 chars, `truncated` → full via `GET /v1/runs/:id`) and Logs
  tabs. Logs tail via cursor (`?after=<seq>`) with `run_log` SSE
  invalidations driving refetch while a run is live.
- **Human gate flow (≤2 clicks)**: from the board, click the card → graph
  strip's decision row → Approve (or Request changes with a required inline
  note). Deep path: feature view → gate modal. `409` race → toast with the
  server message + refetch. Command responses carry fresh state and are
  applied directly (no refetch after own writes).
- **Health**: top-bar dot + popover from `GET /v1/health` (phase, heartbeat,
  per-project workflow state, runner), feeding off the SSE watchdog's health
  poll while the stream is down.
- **Auth**: bearer token on a pre-bootstrap screen, stored in `localStorage`,
  sent on every request including the SSE stream (fetch-based reader — native
  `EventSource` cannot set the header).
- **Refresh model**: one SSE invalidation stream per app; invalidations
  coalesced over a ~150 ms window; targeted refetch by kind
  (`feature` → board list, `transition` → detail+timeline, `run` → detail+
  runs, `finding` → findings); own commands skip the echo; zero polling.
- **Deployment**: the daemon already serves the SPA (`ApiConfig.ui.staticDir`,
  PR #23) — the build outputs a static dir, same-origin by construction, no
  CORS. Dev uses the Vite proxy on `/v1`.
- **CI**: the web build/typecheck/tests are wired into the workspace root
  scripts so the existing CI job exercises them.

## Capabilities

### New Capabilities

- `web-ui`: the browser application surface — board, feature view, workflow
  graph, step inspector, human-gate flow, health indicator, auth, and the
  SSE→refetch data layer. All behavior is against the existing HTTP API v1;
  no server, core, or interpreter semantics change.

### Modified Capabilities

_(none — the API already covers every field the UI needs; the design phase
closed GAP-1..7 and consciously deferred GAP-8/9/10, which phase 1 works
around with raw counters and `updatedAt` freshness.)_

## Impact

- **Code**: new `apps/web/` package (`@conductor/web`) with its own
  `dev`/`build`/`check` scripts. Root `package.json` scripts gain the web
  build into `build` (or the CI invokes it). No `packages/core` changes.
  `packages/server` changes only if static serving needs something the
  existing `ui.staticDir` mechanism lacks — expected: none.
- **Migration**: none. No schema, no engine, no workflow-format change; the
  DB is read-only from the UI's perspective.
- **gloam-idle configs**: untouched. The UI reads the daemon's existing API.
- **Docs**: `docs/design/web-ui/*` are design-session records and stay
  untracked/untouched; the shipped UI implements variant A.
