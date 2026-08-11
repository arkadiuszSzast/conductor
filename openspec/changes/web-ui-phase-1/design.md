# Design — web-ui-phase-1

## Context

See `proposal.md` for motivation. Current state: the API v1 is complete
from the UI's perspective (PR #23 `api-ui-projections` closed every P0/P1
gap; PR #24 `run-log-capture` delivered logs + `run_log` SSE); the design
session (`docs/design/web-ui/00-brief.md`, `variant-a.md`) chose **variant
A — Control Room**. The server already serves a built SPA when
`ApiConfig.ui.staticDir` is set (`api.ts:399-402`), with SPA fallback and
`/v1` precedence. The workspace root has scripts `typecheck`, `test`,
`lint`, `build`; `tsconfig.base.json` is strict (ES2023, noUncheckedIndexedAccess,
verbatimModuleSyntax). `apps/` currently has no web package. CI is a single
job (`check`) that runs the root scripts.

## Goals / Non-Goals

**Goals:**
- A static SPA build under `apps/web` that the daemon can serve today —
  same-origin, no CORS, no per-environment URL config in the bundle.
- All UI-specific logic (SSE→refetch coalescing, DAG layout, structure+runtime
  merge, error mapping) lives in pure, DOM-free modules that `bun test`
  exercises directly.
- The whole UI rides the existing API contracts — zero server changes unless
  static serving forces one (expected: none).

**Non-Goals:**
- No query library, no CSS framework, no polling, no optimistic writes.
- No `packages/core` or `packages/server` behavior changes.
- No mobile layout, no light theme, no feature-start UI, no runner
  management (brief's phase-1 non-goals).
- No per-feature workflow snapshots — the graph renders the project's
  current structure, with the `stale` hint.

## Decisions

- **Stack: React 19 + wouter + CSS Modules + Vite, no build-time SSR.**
  Chosen per `variant-a.md` and the brief. React 19 + `useSyncExternalStore`
  is the natural fit for the hand-rolled invalidation store; wouter (~2 kB)
  covers exactly two routes plus the auth gate; CSS Modules + a token file
  keep the bespoke SVG graph styling out of any utility-class system. The
  bundle is fully static (no server rendering), so the existing daemon
  static-serving path works unchanged.
  Alternative: Svelte (variant B's stack) — rejected on the product decision
  for A; Preact (variant C) — rejected on ecosystem size for the graph.
- **Data layer: hand-rolled `apiFetch` + SSE reader + invalidation store,
  surfaced through `useSyncExternalStore`.** One `DataSource` module owns:
  the fetch wrapper (bearer header, error-envelope mapping, `401` →
  auth-fail callback), the fetch-based SSE reader (~60 lines parsing
  `event:`/`data:` frames; native `EventSource` cannot set the header), the
  ~150 ms coalescing window, per-resource refetch targeting by kind, the
  "own command, skip echo" window, and the reconnect watchdog (health poll
  every 5 s while the stream is down). Individual components subscribe to
  the resources they need (board list, feature detail, runs, findings,
  timeline, health).
  Alternatives: react-query — rejected: the model is five resources and
  command responses carry fresh state; a query lib adds weight without
  touching the invalidate→refetch shape. Polling — rejected: the brief
  mandates SSE, and the watchdog health-poll only runs while the stream is
  down.
- **DAG: hand-rolled layered layout in pure functions, one shared
  `<WorkflowGraph>`.** No dagre/elk: graphs here are tens of nodes, `needs`
  depth is a faithful layering key, and the SVG edge/color treatment is
  bespoke anyway (`variant-a.md` costs this at ~150 LOC). The layout is
  extracted into pure modules (`layout.ts`: layer assignment from `needs`,
  x/y slotting, edge routing for fan-in/fan-out and back-edges; `merge.ts`:
  join workflow structure with detail runtime into graph node/edge models)
  so the geometry is unit-tested without a DOM. SVG edges are hand-drawn
  paths; colors/ambers follow the token file. Rerun back-edge rendering is
  a pure predicate over (feedback snapshot + live job status) per the
  lifecycle semantics in `docs/http-api.md` — snapshot presence alone never
  means "loop in flight".
- **Component testing boundary.** Gate flow, card rendering, and the board's
  decision logic are extracted into pure/plain-IO functions (decision state
  machines, payload → card model mappers) and tested with `bun test`. Full
  DOM component testing (jsdom/happy-dom + RTL) is deliberately not added
  in phase 1: it would introduce a heavy test-infrastructure dependency for
  greenfield UI code whose behavioral core is already pure and tested. The
  one infrastructure-heavy integration test that IS worth the weight is a
  build + real-daemon smoke (below), which the stack supports natively.
- **Build wiring.** `apps/web` gets `dev` (Vite, `server.proxy['/v1']` →
  daemon), `build` (`vite build` → `dist/`, also run a typecheck), `check`
  (`tsc --noEmit`). Root `build` becomes `bun run typecheck && bun run -w build:web`-equivalent
  so the existing CI `Build` step exercises the SPA build without touching
  `.github/workflows/ci.yml`.
- **Auth storage.** Token in `localStorage` per the brief's documented
  trade-off, with a forget affordance. The SSE reader and every fetch share
  the same auth header from one auth store.
- **Time handling.** All ages derive from `createdAt`/`updatedAt` and
  re-render on a 30 s ticker; no per-row clocks (GAP-8 deferral honored).
- **Step inspector logs.** Cursor per open inspector run: `after=<nextSeq>`,
  append on refetch, `run_log` invalidations scoped to the open run drive
  the tail while it is live. Sources labeled (`process`/`action`/`agent`/
  `step`).

## Risks / Trade-offs

- [Board density drops when the graph strip is open] → collapse on second
  click/Esc; strip is the lower half, not a replacement screen.
- [Per-project workflow structure can mislead features started before a
  workflow edit] → `workflowRef.stale`/endpoint `stale` banner, exactly as
  `01-api-gaps.md` prescribes; no per-start snapshots in phase 1.
- [Hand-rolled SSE parser is the most novel runtime code] → isolated module,
  unit-tested against crafted frame streams (incl. `retry:` and partial
  frames); watchdog bounds the blast radius of a silent drop.
- [No DOM component tests] → behavioral logic is pure and tested; a real
  daemon smoke covers the static build end-to-end. Full RTL comes with the
  phase where the UI grows beyond two routes.
- [SVG geometry drift for unusual DAGs (deep chains, wide fan-in)] → pure
  layout functions with property-based-ish fixtures (deep/wide/looped) and
  edge-intersection sanity checks in tests.

## Migration Plan

Greenfield add-on: `apps/web` is a new workspace package; nothing existing
changes. Deploy = `bun install` (new deps) + point `ApiConfig.ui.staticDir`
at the built `dist/`. Rollback = unset `staticDir`; the API surface is
identical. `docs/design/web-ui/` stays untracked (design-session records,
not shipped docs).

## Open Questions

None — the design phase resolved the trade-offs; the deferrals (GAP-8/9/10)
are honored by construction, not deferred decisions.
