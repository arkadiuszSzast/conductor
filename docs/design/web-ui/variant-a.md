# Variant A — "Control Room"

**Philosophy:** the GitHub-Actions mental model, mirrored — work flows
across status columns on the board, and the workflow graph is always one
click away. Anyone who can read a GHA run page can read this cold (repo
guardrail: "the GHA mental model is the UX benchmark").

## Layout

Two routes. Board = kanban columns **with an inline graph expansion**: a
feature view = full page for deep detail. Health lives in the top bar as a
dot + popover.

### Board

```
 CONDUCTOR  board                                   ● ready · hb 4s ▾
──────────────────────────────────────────────────────────────────────────────
 ⚠ NEEDS YOU (3)         RUNNING (3)          PAUSED (1)      DONE(12)·ABAND(5) ▸
┌────────────────────┐ ┌────────────────────┐ ┌────────────────┐
│ ◐ WAITING    2h 3m │ │ ● implement-api    │ │ ❚❚ spike-auth  │
│ pdf export         │ │ core · 12m         │ │ bench · 3d     │
│ conductor · web    │ │ ci · test          │ └────────────────┘
│ gate: approve-pr   │ │ ▓▓○○ jobs 2/4      │
│ ⚑ 3 new            │ │ ⚑ 1 new            │
└────────────────────┘ └────────────────────┘
┌────────────────────┐ ┌────────────────────┐
│ ✖ ESCALATED   41m  │ │ ● ci-loop …        │
│ cache layer · core │ └────────────────────┘
│ maxRounds 3/3 out  │
└────────────────────┘
═══ selected: pdf export ═══ full workflow graph ════════════════════════════
 legend: ✓ done · ● running · ◐ waiting/gate · ○ pending · ⤼ skipped
                                                              ┌────────────┐
   ┌────────┐   ┌───────────┐   ┌────────┐   ┌───────────┐   │ post-merge │
   │ design │──▶│ implement │──▶│ review │──▶│ merge-gate│─▶ │ ○ pending  │
   │ ✓ 4m   │   │ ✓ runda 2 │   │ ✓ 6m   │   │ ◐ WAITING │   └────────────┘
   └────────┘   └─────┬─────┘   └───┬────┘   └───────────┘     ▲ amber =
                      │         ┌───┴───────┐      ▲            current node
                      └────────▶│ smoke-tests│──────┘
                                │ ✓ 2m      │
                                └───────────┘
         (⟲ back-edge drawn only while implement is re-running; afterwards
          the job keeps a "⟲ round 2" chip and the edge disappears)
 gate approve-pr · review: approved · ⚑3 new · next: post-merge
 [✓ Approve]  [✎ Request changes]              otwórz pełny widok →
```

- Columns: `waiting_human` + `escalated` fused into a leftmost **NEEDS YOU**
  zone (amber/red card borders, soft pulse on the zone header), then
  `running`, `paused`, then collapsed terminal columns.
- Card fields, all straight from `GET /v1/features`: status glyph + age
  (`createdAt`/`updatedAt`), title, project (basename of `projectDir`) +
  workflow name, gate step or current step (per-job `currentStep`), jobs
  progress (`n/n` from job statuses), findings badge (`findingCounts`),
  escalation reason (verbatim string, 2-line clamp).
- No per-row "running for X m" clock — consciously deferred with GAP-8.

### Graph expansion (the answer to "gdzie jesteśmy i co dalej")

Selecting a card pins a full-width **graph strip** below the board. It
renders the complete workflow DAG for that feature:

- **Structure** from `GET /v1/projects/workflow?dir=<projectDir>` (needs
  edges, declaration step order, step `kind`), **live state** joined by
  job/step id from the detail payload (`jobs.<id>.status`,
  `steps.<id>.status`, `attempts`, `reruns`).
- Job nodes layered left→right by `needs` depth (custom SVG edges,
  hand-rolled layered layout ~150 LOC; graphs here are tens of nodes — no
  dagre/elk). Succeeded edges solid green, edges into the current node
  solid, future edges dashed dim.
- The **current position reads from color alone**: the active/waiting
  node gets the amber treatment (border + halo), its current step row is
  highlighted — no floating markers. Pending downstream nodes are
  dashed/dimmed, so "what's next" reads at a glance. `skipped` gets ⤼.
- **Rerun loops show only while in flight.** The dashed amber back-edge
  (routing job → rerun target) is drawn **only when a rerun target job is
  the currently active one** — i.e. the loop is mid-round. Label = the
  feedback message ("why it was sent back"). Once the round completes the
  edge disappears; what remains is a quiet `⟲ round N` chip on the job
  (from `JobRuntime.reruns`). Rationale: with many loop-capable steps,
  permanent back-edges turn the graph into spaghetti — history belongs to
  the chip and the timeline, the edge means "happening now".
  Data: precise targets + message need the feedback snapshot exposed —
  **GAP-12** (`02-api-extensions-request.md`); timeline-only inference is
  the degraded fallback.
- **Step inspector.** Clicking any node/step opens the inspector (drawer
  under the strip; side panel on the feature page) with two tabs:
  - **Outputs** — always present: step outputs from the detail payload
    (≤500 chars, `truncated` → full via `GET /v1/runs/:id` + `runId`).
  - **Logs** — the narrative, per run (each attempt/round separately):
    `agent` steps get the session log (live tail while running, full
    history after), `command` steps interleaved stdout/stderr, step
    authors can append custom lines. **Requires GAP-11** (log capture +
    store + `GET /v1/runs/:id/logs` + `run_log` SSE kind) — specified in
    `02-api-extensions-request.md`; until it lands the tab shows only
    outputs/`reason`.
- **Glyph legend** (on the strip): `✓/●/◐/○/⤼` step states, `⟲` rerun
  loop, `⚑` findings on the producing step, `N att` = attempt count
  (`JobRuntime.attempts` — how many times the step executed, incl.
  retries). Budgets (`maxAttempts`/`maxRounds`) are NOT exposed — raw
  counts only; "x/y exhausted" exists only inside escalation reason
  strings (see `01-api-gaps.md` GAP-10).
- The strip carries the **decision row**: gate name, last outcome,
  findings count, next step — plus `Approve` / `Request changes` buttons
  and a link to the full feature view.
- `workflowRef.stale` / endpoint `stale` → banner "workflow changed since
  this feature started" (structure is the project's current snapshot, not
  the start revision); `404`/`409` from the workflow endpoint → the strip
  shows the diagnostics card instead of a graph.

### Feature view (deep detail)

```
← board   pdf export                     ⚠ WAITING HUMAN — gate: approve-pr
          conductor/apps · default · pr #42 · feat/pdf · 2h 3m
──────────────────────────────────────────────────────────────────────────────
 PIPELINE (same graph component, enlarged)        side panel (selected node)
 ACTIVE RUN — session d1e7… · nudges 0 · outputs ▾ (truncated → /v1/runs/:id)
──────────────────────────────────────────────────────────────────────────────
 FINDINGS (severity groups, status chips)         TIMELINE (events+decisions)
```

- Same DAG component as the strip, enlarged; selecting a node opens the
  step inspector (kind, status, attempts/reruns + Outputs/Logs tabs as
  above).
- Active run strip, findings list, timeline — the full context for hard
  decisions. Header: `pause`/`resume`/`abandon`; gate buttons while
  `waiting_human` (open the modal).

## Human gate flow

**From the board — 2 clicks:** click the card (1) → graph strip opens with
the gate's decision row → click `Approve` (2). `Request changes` opens an
inline note field in the strip (required — mirrors the API's `400`). The
strip answers "where are we" *while* deciding — no navigation away.
**Deep path:** card → `otwórz pełny widok` → feature view → modal with
report excerpt + findings → confirm. `409` → toast "state changed" +
refetch.

## Stack

- **React 19 + Vite.** The most ambitious visualization of the three wants
  the largest component/hiring ecosystem; nothing exotic is used.
- **No CSS framework** — a small token file + CSS Modules. Justification:
  a long-lived operator tool with a bespoke graph component; design tokens
  outlive utility-class churn, and the DAG SVG needs custom styling anyway.
- **wouter** (~2 kB) for the two routes.
- **Data layer:** hand-rolled `apiFetch` wrapper + fetch-based SSE reader
  + a ~100-line invalidation store exposed via `useSyncExternalStore`. No
  react-query: the model is invalidate→refetch of five resources, and
  command responses carry fresh state.
- **DAG layout:** one shared component (`<WorkflowGraph>`) used by the
  board strip and the feature view; layered layout by `needs` depth.

## Typography / color / density

- Base `#0b0e14`, surface `#11151d`, border `#1e2430`, text `#e6e9ef`.
- UI font Inter 13 px; ids/times/paths IBM Plex Mono 12 px.
- Status hues: waiting `#f5a623` (amber, pulsing halo), escalated
  `#ff5c5c` (red, static — red+blink is hostile), running `#4da3ff`,
  paused `#9aa4b2`, done `#3fb68b`, abandoned `#6b7280`.
- Radius 8 px, card min-height 96 px → ~14–18 cards per 1080p viewport
  before the strip; the strip takes the lower half when open.

## Trade-offs

**Great at:** instant structural comprehension — the graph strip answers
"na jakim kroku jesteśmy i co będzie dalej" directly on the board, one
click from any card; the GHA-familiar metaphor needs zero learning; gate
decisions happen with the pipeline visible. **Sacrifices:** lowest board
density (open strip halves the visible cards — mitigated: strip collapses
on second click / Esc); kanban columns waste horizontal space when one
status dominates; structure is per-project, so a feature started before a
workflow edit renders against the newer graph (hinted via `stale`).

## Cost

**L** — the only variant with real visualization work (SVG edges, layered
layout, strip/panel sync). The API no longer blocks anything; the cost is
genuine rendering engineering. Longest path to phase 1, highest ceiling
for phase 2.
