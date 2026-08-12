# Variant B — "Flight Sheet"

**Philosophy:** htop, not Jira — one dense table is the whole board;
scanning speed and keyboard flow beat spatial metaphors, and every field
fights for its column.

## Layout

Two routes. Board = full-width dense table with status-grouped sections.
Feature view = dedicated page: header + pinned decision bar + job/step
list (left, wide) + context rail (right). Health = status cluster in the
table header + slide-over drawer.

### Board

```
 CONDUCTOR                                    ● ready · hb 4s · runner ✓ ▾
 [all projects ▾]  [filter ⌕____________]   8 active · 3 need you
──────────────────────────────────────────────────────────────────────────────
 ⚠ NEEDS YOU ─────────────────────────────────────────────────────────────
 ST    TITLE                  PROJECT    STEP           JOBS   FIND  AGE    ACTIONS
 ◐ w   pdf export             conductor  ⛒ approve-pr   4/4    ⚑3    2h 3m  ✓ ✎ ❚❚ ✖
 ◐ w   migrate-db             bench      ⛒ confirm      2/6    —     6h12m  ✓ ✎ ❚❚ ✖
 ✖ e   cache layer            core       ✖ review-loop  2/5    —     41m    ↻ ✖
      └ maxRounds exhausted (3/3) — review/fix loop                          ← reason row
──────────────────────────────────────────────────────────────────────────────
 ● RUNNING ─────────────────────────────────────────────────────────────────
 ● r   implement-api          core       ci · test      2/4    ⚑1    12m    ❚❚ ✖
 ● r   ci-loop                runner     verify         5/6    —     2h 4m  ❚❚ ✖
 ● r   docs refresh           server     gen · action   1/2    —     6m     ❚❚ ✖
──────────────────────────────────────────────────────────────────────────────
 ❚❚ PAUSED ─── spike-auth · bench · 3d · ▶ resume · ✖ abandon ────────────
 ✓ DONE (12) · ✖ ABANDONED (5) ─── ▸ expand ──────────────────────────────
```

- One table, sections pinned in attention order: NEEDS YOU (waiting +
  escalated) → RUNNING → PAUSED → collapsed terminal sections (fetched on
  expand via `?status=done,abandoned`).
- Row anatomy, all from `GET /v1/features`: 2-letter status code + colored
  left border; title; project basename; current step with a ⛒ glyph
  marking human gates (gate job = per-job `currentStep` while
  `feature.status === "waiting_human"`); jobs `n/n` + micro-bar from job
  statuses; findings badge from `findingCounts`; age from `createdAt`;
  inline icon actions. Escalated rows get an indented reason row (the
  `escalation` string, verbatim).
- Keyboard-first: `j/k` move, `enter` open, `a` approve, `x` request
  changes, `p` pause, `r` resume, `.` abandon, `/` filter.
- Sort by attention-age (waiting/escalated oldest first); columns
  sortable; density toggle (28 px / 36 px rows).

### Feature view

```
← board  pdf export · conductor/apps · default · pr #42 · feat/pdf · 2h 3m
         ⚠ WAITING HUMAN @ approve-pr
──────────────────────────────────────────────────────────────────────────────
 DECISION  note: [___________________________________]  [✓ Approve] [✎ Request changes]
──────────────────────────────────────────────────────────────────────────────
 JOBS & STEPS                                        │ CONTEXT
                                                     │ ACTIVE RUN
 ▾ design        ✓ succeeded                         │ none — waiting on gate
    plan         ✓ agent · 1 att · 4m · outputs ▾    │ last: review/check 6m
 ▾ implement     ✓ succeeded                         │ nudges 0 · sess d1e7…
    code         ✓ agent · 3 att · 18m · outputs ▾   │
 ▾ review        ✓ succeeded                         │ FINDINGS ⚑3 new
    check        ✓ agent · 6m · ⚑3 · outputs ▾       │ high   api.ts:412  new
 ▾ merge-gate    ● running                           │ med    store.ts:88 new
  ▶ approve-pr   ◐ waiting human — 41m               │ low    api.ts:121 new
    worktree     ✓ action · git/worktree@v1          │
                                                     │ TIMELINE ▾ (latest 10)
 Declaration order & kind chips: /v1/projects/workflow│ 14:02 wait_human
 Live status/attempts/reruns: detail jobs.<id>        │ 14:02 step.completed
                                                     │ 13:41 failed → retry 2/3
```

- Jobs as collapsible cards in **declaration order** and steps with real
  **kind chips** (`agent/command/action/human` — from
  `GET /v1/projects/workflow?dir=`); live state from the detail payload:
  status glyph per step (`jobs.<id>.steps.<id>.status`), attempt counters
  (`attempts`), rerun round counters (`reruns`), duration from runs.
- Human gates are identified by `kind: "human"` exactly — no inference.
- Step outputs expandable in place; values arrive cut at 500 chars — on
  `truncated: true` a "full output" link fetches `GET /v1/runs/:id` via
  the step's `runId`.
- The **decision bar** is pinned directly under the header whenever
  `waiting_human` — note field + both buttons, always visible, zero
  navigation. `escalated` → bar shows the reason + `[Resume (reset &
  retry)]` + `[Abandon]`.
- Right rail: active run card (session, elapsed, attempt, nudges, outputs
  toggle), findings (severity-grouped, status chips), timeline condensed.

## Human gate flow

Board: row actions are always visible. Click `✓` (1) → inline confirm
popover with optional note field → click `Approve` (2) → done, row flips
in place. `✎` opens the same popover with the note required. **2 clicks,
never leaving the board.** Deep path (read findings first): `enter` →
feature view (decision bar already pinned) → click `Approve`. Keyboard:
`a` → note prompt → `enter`.

## Stack

- **Svelte 5 (runes) + Vite.** Compiled away, tiny runtime; stores map
  naturally onto the SSE invalidation bus (`readable` wrapping the fetch
  reader); the table re-renders surgically without a memoization dance.
- **Tailwind CSS v4.** A dense table is a hundred small spacing/typography
  decisions — utilities iterate on those fastest; design tokens still live
  in `@theme` so the palette is centralized. (Justified against A: A's
  bespoke SVG argues against a utility framework; B's uniform table argues
  for it.)
- **svelte-spa-router** (hash-based, tiny) — two routes, deep-linkable.
- **Data layer:** hand-rolled client + SSE store exactly per brief. No
  query library: five resources, invalidation-driven, server-authoritative.

## Typography / color / density

- Base `#0d1117`, zebra `#0f1420`, hairline `#21262d`, text `#e6edf3`.
- Inter 12–13 px UI; JetBrains Mono 12 px for data cells (times, paths,
  ids, statuses).
- Status = 3 px left border + glyph: waiting `#f0b429`, escalated
  `#f85149`, running `#58a6ff`, paused `#8b949e`, done `#3fb950`,
  abandoned `#6e7681`. Accent (links/focus) `#58a6ff`. Only the NEEDS YOU
  section header and waiting-glyph get a pulse animation.
- 28 px rows → **30+ features per viewport**; highest density of the three.

## Trade-offs

**Great at:** the fastest triage surface of the three — everything
scannable in one screen, act without leaving it; cheapest build — every
wireframe field maps 1:1 onto an API field post-#23, zero visualization
debt; keyboard parity for every action. **Sacrifices:** no structural
overview — you read a feature's shape as a list, not a picture (parallel
branches read as flat rows, even though `needs` data exists); table
density can feel austere; inline popovers are smaller decision context
than A's modal.

## Cost

**M** — no custom rendering beyond a micro-bar; the table, popovers and
decision bar are standard components; the keyboard layer is the only
non-trivial extra (~a day). Fastest path to a complete phase 1.
