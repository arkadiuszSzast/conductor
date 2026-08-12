# Web UI — shared brief

Design-phase document. Three candidate directions live in `variant-a.md`,
`variant-b.md`, `variant-c.md`; this file holds everything they share.

**API status:** every gap found during design has landed — PR #23
(`36e7071`, `api-ui-projections`). `01-api-gaps.md` keeps the resolution
record; the shipped reference is `docs/http-api.md`. Every field in every
wireframe is served by the API today.

## Persona

**The operator** — a developer running a self-hosted Conductor daemon that
drives several agent features across a handful of projects (dogfooding
included). They open the board a few times a day with exactly two questions:

1. **Where am I needed?** — `waiting_human` gates and `escalated` features.
2. **What is happening right now?** — which feature is on which step, is the
   daemon healthy, are any workflows `stale`/`invalid`.

They are not browsing; they are triaging. Every second of scanning costs
attention they would rather spend on the decision itself. Density and
scan-speed beat ornament. Desktop-first, dark mode is the primary theme.

## Key flows

### F1 — Triage (the 5-second scan)
Open board → attention states (`waiting_human`, `escalated`) are visually
loud and sorted first → pick one → land on the decision.

### F2 — Gate decision (≤ 2 clicks from the board)
From a `waiting_human` row/card: open the gate affordance (click 1), read
context, optionally type a note, confirm `approve` / `request-changes`
(click 2). `request-changes` requires a non-empty note — the API enforces
this (`400 invalid_request`), the UI enforces it before the request.

### F3 — Escalation triage
Board shows the escalation reason inline (`feature.escalation` string) →
open feature → read timeline + failed run `reason` → `resume` (resets the
stuck step's budget and retries) or `abandon`.

### F4 — Ambient health
Health is **not a screen**. It is a persistent, quiet indicator (daemon
phase/heartbeat/runner + per-project workflow state `valid`/`stale`/
`invalid` with diagnostics on demand) that only asks for attention when
something is wrong.

## Screen map

```
        ┌────────────────────────────────────────────┐
        │  persistent chrome: health indicator        │
        ├────────────────────────────────────────────┤
 token  │                                            │
 gate ──▶│  BOARD (default route)                     │
 (auth) │    │                                       │
        │    ▼ click a feature                       │
        │  FEATURE VIEW (per feature id)             │
        │                                            │
        └────────────────────────────────────────────┘
```

Exactly two routes plus an auth gate. No settings screen in phase 1
(configuration is daemon-side, not UI). No "start feature" UI in phase 1
(`POST /v1/features` exists but is out of scope).

## Screen → endpoint map

Everything below exists in the API today (full reference:
`docs/http-api.md`).

| Screen element | Endpoint | Notes |
|---|---|---|
| Auth validation | `GET /v1/health` | first call with the entered token; `401` = wrong token; success without a token = `auth.mode: "none"` → skip the auth screen |
| Board list | `GET /v1/features` | each item = `FeatureState` + `escalation` + `currentStep` + **`createdAt`/`updatedAt`** (epoch ms) + **`findingCounts {new,fixed,dismissed,reopened}`** + `jobs` summary (`{status, currentStep}` per job) |
| Board filters | `?project=<dir>` · `?status=a,b` · `?active=true` | composable; unknown status → `400`; grouping into board sections still happens client-side |
| Feature header + full runtime | `GET /v1/features/:id` | `{feature, activeRun}`; detail `jobs.<id>` = **full runtime**: `status, currentStep, attempts, reruns, outputs, steps.<id> {status, outputs, truncated?, runId?}`; plus `workflowRef: {name, stale} \| null` |
| Pipeline per-step status | detail `jobs.<id>.steps` | all seven `StepStatus` values direct from the payload, with live retry/rerun counters |
| Step outputs (full) | `GET /v1/runs/:id` | detail step outputs are cut at 500 chars; `truncated: true` + `runId` (newest run for the step) → fetch the full output here |
| Pipeline structure (DAG) | `GET /v1/projects/workflow?dir=<projectDir>` | `{name, stale, jobs: {<id>: {needs[], steps: [{id, kind}]}}`, diagnostics}; `kind ∈ agent\|command\|action\|human`; structure only. `404` unregistered, `409` never-valid (diagnostics in message), `200` valid/stale |
| "Workflow changed since start" hint | `workflowRef.stale` on detail, `stale` + `diagnostics` on workflow endpoint | structure is per-project (current snapshot), not per-start-revision |
| Active run card | `activeRun` from feature payload | `RunSummary`: `jobId, stepId, stepType, attempt, sessionId, nudges, timeStarted, outputs, reason` |
| Run history | `GET /v1/features/:id/runs` | `RunSummary[]`, newest first, limit 100 |
| Findings | `GET /v1/features/:id/findings` | `FindingView[]`: `stepId, path, line, severity, tags, body, status (new/fixed/dismissed/reopened), resolution, synced` |
| Timeline | `GET /v1/features/:id/timeline` | `TransitionEntry[]`, newest first, limit 50; `event` is a **parsed object** (`{kind: "step.completed", ...}`) |
| Gate actions | `POST /v1/features/:id/approve` · `POST .../request-changes` | body `{notes?}`; notes **required** for request-changes; `409 conflict` when not `waiting_human`; **response carries the fresh feature payload — apply directly, no refetch** |
| Lifecycle actions | `POST .../pause` · `POST .../resume` · `POST .../abandon` | response = fresh feature payload; pause/abandon `409` on terminal features |
| Health indicator | `GET /v1/health` | `DaemonHealth`: `alive, ready, phase, database{...}, heartbeat{...}, projects[]{projectDir, state, diagnostics[]}, runner` |
| Live updates | `GET /v1/events` | SSE invalidation stream (below) |

Endpoints that exist but phase 1 does not use: `POST /v1/features`,
`GET/POST /v1/runners`, `DELETE /v1/runners/:id`, `POST /v1/runs/:id/report`
(runner-facing), `GET /v1/livez` / `/v1/readyz` (unauthenticated probes —
the indicator uses `/v1/health` since it carries project state).

## Refresh model: SSE → refetch

`/v1/events` is an **invalidation stream**. Frames arrive as
`event: change` with `data: {"kind":"feature"|"transition"|"run"|"finding","featureId":"..."}`.
The payload deliberately carries no state — after a change is durable, the
client refetches authoritative state over REST.

Client rules (shared by all variants):

1. **One SSE connection per app**, opened after auth, fanned out to a
   subscription bus.
2. **Coalesce**: batch invalidations over a ~150 ms window; a feature that
   invalidates `transition`+`run`+`feature` in one burst triggers one
   refetch pass, not three.
3. **Targeted refetch** by kind:
   - `feature` → board list (refetch the list — it is small — and patch
     the row; a single-item list fetch does not exist)
   - `transition` → feature detail + timeline
   - `run` → feature detail (activeRun) + runs
   - `finding` → findings
   - events for features not on screen only refresh the board list.
4. **Own commands skip the echo**: `approve`/`pause`/… responses already
   contain the fresh payload; apply it and ignore the SSE invalidation
   that arrives for the same feature within a short window.
5. **No optimistic writes.** The button shows pending until the response;
   `409 conflict` means "state moved under you" → refetch and show the
   server's message.
6. **Auth**: native `EventSource` cannot send an `Authorization` header.
   Use a fetch-based SSE reader (`fetch` + `ReadableStream`, parse
   `event:`/`data:` frames manually — ~60 lines) so the bearer header is
   set. The server sends `retry: 2000`; honor it as the reconnect delay,
   with a capped exponential backoff on repeated failures.
7. **Liveness watchdog**: the stream is silent when the system is idle,
   so silence is not proof of life. Track stream errors/closes; after a
   drop, show a "reconnecting" chip and poll `GET /v1/health` every 5 s
   until the stream is back. This doubles as the health indicator's data.
8. **Local clocks**: "x m ago" labels re-render on a 30 s ticker from
   `createdAt`/`updatedAt` timestamps — never from polling the API.

## Auth & deployment

- **Bearer token** entered on a pre-bootstrap auth screen; stored in
  `localStorage` (persists across restarts — documented trade-off; a
  "forget" button clears it). Sent as `Authorization: Bearer <token>` on
  every request including the SSE stream.
- **Production deployment: the daemon serves the SPA.**
  `ApiConfig.ui: {staticDir}` (explicit, no default) serves the built
  assets: `index.html` fallback for non-`/v1` paths, `/v1/*` takes
  precedence, path traversal rejected. Static assets are unauthenticated
  (page loads cannot attach a bearer header); `/v1` stays guarded.
  Same-origin by construction — **the API emits no CORS headers and none
  are planned**.
- **Dev deployment:** the Vite dev server proxies `/v1` to the daemon
  (`server.proxy`); the SPA always calls a relative `/v1` base, so no
  per-environment URL config exists in the bundle at all.
- The only client-side configuration is therefore: nothing in prod
  (same-origin), a proxy target in dev (env for `vite.config`).

## Error model (shared)

Errors are `{error: {code, message, requestId}}`. UI mapping:
`401` → back to auth screen; `400` → inline form error (e.g. empty note on
request-changes); `404` → "feature gone" toast + board refetch;
`409` → toast with server `message` + refetch (state raced you);
`500` → toast with `requestId` for log correlation.
The workflow endpoint's `404`/`409` are **not** errors in the UI sense —
they render as "no workflow registered" / "workflow invalid" states with
diagnostics.

## Non-goals (phase 1)

- Starting features, runner management, editing anything.
- Mobile layout. Light theme.
- Log/session transcript streaming (no such endpoint; `sessionId` is an
  opaque id rendered as text).
