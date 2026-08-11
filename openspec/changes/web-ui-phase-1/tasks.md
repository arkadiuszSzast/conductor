# Tasks — web-ui-phase-1

## 1. Scaffold apps/web

- [x] 1.1 [web] Add `apps/web/package.json` (`@conductor/web`): React 19 + wouter + Vite + CSS Modules; scripts `dev`, `build`, `check`; add workspace dep
- [x] 1.2 [web] Vite config: root `apps/web`, `build.outDir = dist`, base `/`, dev server proxying `/v1` to the daemon (env `VITE_DAEMON_ORIGIN`), strict TS via shared `tsconfig.base.json`
- [x] 1.3 [web] App shell: `index.html`, entry, token file (colors/typography/status hues from variant-a.md), CSS Modules baseline, two routes (board, feature) + auth gate route
- [x] 1.4 [docs] Root wiring: `package.json` `build` runs the web build (typecheck + `vite build`) so CI exercises the SPA; verify `bun run build` at root produces `apps/web/dist`

## 2. Data layer (pure, DOM-free)

- [x] 2.1 [web] `apiFetch` wrapper: relative `/v1` base, bearer header injection, error-envelope mapping to typed `{code, message, requestId}`, `401` → auth-fail callback, JSON helpers for command responses
- [x] 2.2 [web] Auth store: token in localStorage, forget affordance, health probe decides `auth.mode: none` vs bearer
- [x] 2.3 [web] Fetch-based SSE reader: manual `event:`/`data:` frame parser (honor `retry:`, partial frames), bearer header on the request, reconnect with capped exponential backoff
- [x] 2.4 [web] Invalidation store: ~150 ms coalescing window, refetch targeting by kind (`feature`→board list, `transition`→detail+timeline, `run`→detail+runs, `finding`→findings), own-command echo skip, reconnect watchdog (health poll 5 s while stream down)
- [x] 2.5 [web] Data hooks: `useFeatures`, `useFeature`, `useRuns`, `useFindings`, `useTimeline`, `useHealth`, `useWorkflow` via `useSyncExternalStore`; command wrappers (`approve`, `request-changes`, `pause`, `resume`, `abandon`) applying fresh payloads
- [x] 2.6 [test] Data-layer tests: SSE frame parsing, coalescing (burst → one refetch), cursor-tail log pagination logic, error-envelope mapping, own-command echo skip — all `bun test`, no DOM

## 3. DAG layout + structure/runtime merge (pure)

- [x] 3.1 [web] `layout.ts`: layered layout from `needs` (layer = longest path), x/y slotting, node sizes, edge routing incl. fan-in/fan-out, no external graph lib
- [x] 3.2 [web] `merge.ts`: join workflow structure (`/v1/projects/workflow`) with detail runtime (`jobs.*.steps`, attempts, reruns) into graph node/edge models; status→glyph mapping (✓/●/◐/○/⤼); edge styling rules (succeeded green, into-current solid, future dashed)
- [x] 3.3 [web] Loop-edge predicate: back-edge drawn only when rerun-target job is active (feedback snapshot + live job state, per docs/http-api.md lifecycle); `⟲ round N` chip from `reruns`; stale-indicator from `workflowRef.stale`
- [x] 3.4 [test] Layout/merge tests: layer assignment, deep/wide/looped fixtures, edge positions, structure+runtime merge, loop-edge predicate cases (in-flight vs completed), stale flag

## 4. Board + graph strip

- [x] 4.1 [web] `<Board>`: kanban columns — fused NEEDS YOU zone (waiting_human + escalated), running, paused, collapsed terminal; card fields from the list payload (status glyph + age from `updatedAt`, title, project basename, workflow name, gate/current step, jobs progress `n/n`, findings badge, escalation reason)
- [x] 4.2 [web] Age rendering on a 30 s ticker; card selection toggles the graph strip (second click / Esc collapses)
- [x] 4.3 [web] `<WorkflowGraph>` SVG component (shared with the feature view): nodes/edges from layout+merge, amber current treatment, diagnostics card for workflow 404/409, stale banner
- [x] 4.4 [web] Graph strip decision row: gate name, last outcome, findings count, next step, Approve / Request changes (inline note, required), link to full feature view
- [x] 4.5 [test] Card model mapping + gate decision-row logic as pure functions; `bun test`

## 5. Feature view + step inspector

- [x] 5.1 [web] `<FeatureView>`: header (title, project/workflow, meta, pause/resume/abandon), enlarged `<WorkflowGraph>`, side panel, active run strip, findings list (severity groups), timeline
- [x] 5.2 [web] Step inspector: node/step click → drawer (board) / side panel (feature view); Outputs tab (≤500 chars, `truncated` → full via `GET /v1/runs/:id`), Logs tab (sources labeled)
- [x] 5.3 [web] Log tail: per-inspector-run cursor `after=<nextSeq>`, append on `run_log` SSE refetch while the run is live
- [x] 5.4 [test] Inspector data logic (truncation resolution, cursor advance) as pure functions; `bun test`

## 6. Gate flow + health

- [x] 6.1 [web] 2-click gate from the board (card → strip Approve); request-changes requires non-empty note (inline error, nothing sent); feature-view gate modal with report excerpt + findings
- [x] 6.2 [web] `409` race handling: toast with server message + refetch; `400` inline; `404` feature-gone toast + board refetch; `500` toast with `requestId`
- [x] 6.3 [web] Health top-bar dot + popover (phase, heartbeat, project states + diagnostics, runner) fed from `useHealth`; reconnecting chip while the stream is down
- [x] 6.4 [test] Gate flow logic (note-required validation, 409 → refetch) as pure functions; `bun test`

## 7. Integration + smoke

- [x] 7.1 [test] Build + real daemon smoke: `vite build` → serve `apps/web/dist` via `ApiConfig.ui.staticDir` on a real `startApiServer` listener → `index.html` reachable, `/v1/health` still guarded, SPA fallback for a deep route, modeled on `packages/server/api-integration.test.ts`
- [x] 7.2 [docs] Verify CI exercises the web build (root `build` wiring from 1.4); no `.github/workflows/ci.yml` edits needed if the root script covers it

## 8. Review + validation

- [x] 8.1 [review] `bun test && bun run typecheck && bun run lint && bun run build && openspec validate web-ui-phase-1`; confirm zero `packages/core` diffs, zero `packages/server` diffs, `docs/design/web-ui/` untouched
