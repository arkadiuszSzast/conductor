# Variant C — "Console"

**Philosophy:** the daemon is a machine; the UI is its console — a
monospace watch-view where the event stream is the product and every
action is a command.

## Layout

Two routes, one persistent chrome: a tmux-style status bar on top and a
command line on the bottom. Board = status-grouped feature rows + live
event feed. Feature view = the transition log as the primary narrative.
Health is **ambient** — it is the status bar itself, always visible.

### Board

```
 conductor ● ready · hb 4s · runner opencode ✓ · projects: conductor ✓ bench ⚠stale(2)
──────────────────────────────────────────────────────────────────────────────────────
━━ NEEDS YOU (3) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▸ ◐  2h03  pdf-export        conductor  @approve-pr ⛒        jobs 4/4  ⚑3n
   ◐  6h12  migrate-db       bench      @confirm ⛒           jobs 2/6
   ✖  41m   cache-layer      core       review-loop ✖ "maxRounds exhausted (3/3)"
━━ RUNNING (3) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ●  12m   implement-api    core       ci/test              jobs 2/4  ⚑1n
   ●  2h04  ci-loop          runner     verify               jobs 5/6
   ●  6m    docs-refresh     server     gen/action           jobs 1/2
━━ PAUSED (1) ━━━ spike-auth · bench · 3d ━━━ DONE (12) · ABANDONED (5) ▸ ━━━━
───────────────────────────── LIVE ─────────────────────────────────────────────
 14:02:07  pdf-export     transition   wait_human @approve-pr
 14:02:07  pdf-export     finding+     api.ts:412 high
 14:01:55  implement-api  run+         ci/test attempt 1
 14:01:40  cache-layer    transition   escalate "maxRounds exhausted (3/3)"
──────────────────────────────────────────────────────────────────────────────────────
:▊                                            a:approve x:changes p:pause o:open /:grep
```

- Rows are pure text, all from `GET /v1/features`: status glyph, age
  (`createdAt`), title, project, current step (⛒ marks the gate), jobs
  `n/n`, findings (`findingCounts`), escalation reason inline.
- The LIVE strip renders the SSE invalidation stream itself (enriched from
  already-fetched state) — the "something changed" heartbeat of the
  daemon; it doubles as the reconnect indicator (watchdog state shows
  here).
- Projects line in the status bar carries `valid ✓ / stale ⚠ / invalid ✖`
  chips from `/v1/health`; focus expands diagnostics.
- Everything is keyboard-driven; the `:` command line takes verbs
  (`approve [note]`, `changes <note>`, `pause`, `resume`, `abandon`,
  `open <id>`, `grep <text>`). Mouse equivalents exist on row hover.

### Feature view

```
 f:pdf-export · conductor/apps · pr #42 · ⚠ WAITING HUMAN @approve-pr · 2h03
──────────────────────────────────────────────────────────────────────────────────────
 structure   design ✓ ─▶ implement ✓ ─▶ review ✓ ─▶ [approve-pr ◐]   (needs edges,
             ⚠ stale — workflow changed since start                    live status)
──────────────────────────────────────────────────────────────────────────────────────
 13:31:02  feature.start
 13:31:03  → execute_step design/plan
 13:35:44  ✓ step.completed design/plan outcome:done
           └ run a4f2 · agent · 4m41s · attempt 1 · nudges 0        [outputs ▾]
 13:41:20  ✖ step.failed implement/code "exit 1" · attempt 1/3
           └ run b8c1 · agent · 5m35s · reason: exit 1
 13:41:50  ↻ retry backoff 30s → execute_step implement/code (attempt 2)
 13:56:02  ✓ step.completed implement/code outcome:done
           └ run c9d4 · agent · 14m12s · outputs: report ▾ (truncated → run c9d4)
 14:02:07  ✓ step.completed review/check outcome:approved
           └ run d1e7 · agent · 6m05s
             ⚑ new  high    api.ts:412  timingSafeEqual on token comparison…
             ⚑ new  medium  store.ts:88  escalation overwrite race…
             ⚑ new  low     api.ts:121  error text inconsistent…
 14:02:07  ⛒ wait_human merge-gate/approve-pr
 ████████████████ awaiting your decision ████████████████
──────────────────────────────────────────────────────────────────────────────────────
:approve ▊            (a) approve · (x) request changes · (p)ause · (esc) board
```

- The **timeline IS the view** (`GET .../timeline` — `event` arrives as a
  parsed object): transitions interleaved with their runs (from `/runs`,
  joined by job+step+time) and findings (`stepId`) attached to the step
  line that produced them. Retries, reruns, escalations read as a log —
  the closest thing to watching the interpreter think.
- A one-line ASCII **structure strip** orients inside the DAG: edges and
  step order from `GET /v1/projects/workflow?dir=`, live status from the
  detail runtime; `stale` gets the "changed since start" marker.
- Step output excerpts respect the 500-char cut; `truncated` lines link
  out to the full output via `GET /v1/runs/:id` (`step.runId`).
- Gate = the bottom command line: `a` focuses it prefilled `approve `,
  optional note, `enter` submits. `x` → `changes ` (note mandatory).
  Mouse: the awaiting-decision banner is clickable → same command line.

## Human gate flow

Keyboard: `j/k` to the waiting row, `a` (1) → command line shows
`approve [note]` → `enter` (2). **2 keystrokes**; mouse path is 2 clicks
(row banner → confirm). `409` prints to the LIVE strip like a command
error and refetches. Fastest gate of the three, zero layout shift.

## Stack

- **Preact + @preact/signals + htm (no JSX).** ~10 kB total runtime;
  signals are a 1:1 fit for the SSE-invalidation model (each resource is a
  signal, the stream flips them); htm keeps the build to plain Vite
  without a compiler plugin story. A framework heavier than this would
  contradict the variant's own thesis.
- **Zero CSS framework** — hand-rolled stylesheet with custom properties;
  the console aesthetic is 200 lines of CSS, not a design system.
- **Hand-rolled hash router** (~30 lines) — two routes.
- **Data layer:** the brief's fetch + SSE reader verbatim; the LIVE feed
  is a ring buffer of invalidation events joined against cached state.

## Typography / color / density

- Monospace everywhere: JetBrains Mono (fallback Berkeley Mono) 13 px,
  line-height 1.45.
- Phosphor-on-black: base `#0c0f0c`, text `#c9e4c9`, dim `#5a6e5a`,
  accents — ok `#7ee787`, warn/waiting `#d29922`, error/escalated
  `#f85149`, info `#79c0ff`. No border-radius anywhere; box-drawing
  characters (`━ │ └ ▸`) as the only "components".
- Density: 24 px rows on the board, unlimited-scroll log in feature view;
  second only to B, and the live strip adds ambient density B lacks.

## Trade-offs

**Great at:** the most truthful representation of the system — the
transition log is what the daemon actually did, unmediated by a visual
metaphor; ambient health is built into the chrome, not bolted on; smallest
dependency footprint of the three; needs the least from the API — the
narrative lives in `timeline`+`runs`, everything else is garnish.
**Sacrifices:** the aesthetic is a taste — it delights operators and
alienates everyone else; no at-a-glance pipeline shape (the structure
strip is orientation, not overview); accessibility work (focus, contrast,
screen-reader on a log stream) is entirely hand-rolled; the live strip
duplicates information the rows already show.

## Cost

**M** — no visualization debt (the structure strip is text), but the
command line, keyboard layer and log-joining (timeline×runs×findings)
are real work; no component library means every interaction is built.
Comparable effort to B, traded from polish into mechanism.
