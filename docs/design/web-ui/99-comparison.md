# Comparison & recommendation

| Axis | A — Control Room | B — Flight Sheet | C — Console |
|---|---|---|---|
| Primary metaphor | GHA run page (kanban + DAG) | htop / ops spreadsheet | daemon console / CI log |
| Board | status columns, cards | one dense table, status sections | text rows + live SSE strip |
| Feature view centers on | DAG graph (SVG) | job/step list + decision bar | transition timeline |
| Gate UI | modal (from card or header) | inline popover / pinned bar | command line (`:approve`) |
| Gate clicks from board | 2 (Review → Approve) | 2 (✓ → Approve), keyboard 2 keys | 2 keys (a → enter) |
| Stack | React 19 + wouter, CSS Modules | Svelte 5 + Tailwind v4 | Preact + signals + htm, no CSS lib |
| Data layer | hand-rolled (all three: fetch + SSE invalidation, no query lib) | ← | ← |
| Density (features/1080p) | ~14–18 | 30+ | ~24 + live feed |
| Use of `/v1/projects/workflow` | hero input (edges, kinds, order) | order + kind chips | structure strip |
| Use of full detail runtime | node expansion + side panel | step rows (status/attempts/reruns) | light (log is run/timeline-based) |
| Keyboard-first | no | yes | yes (only way) |
| Health display | top-bar dot + popover | header cluster + drawer | persistent status bar (ambient) |
| Accessibility risk | low | low | **high** (hand-rolled everything) |
| Cost | **L** | **M** | **M** |
| Main sacrifice | density; per-project structure can mislead pre-edit features | no structural overview | taste-limited audience, a11y debt |

All three cover the four scope points (board, feature view, ≤2-click gate,
health) and share the brief's refresh model (SSE→refetch, no polling),
auth approach, error mapping and deployment story (daemon-served SPA, no
CORS). **Post-#23 all three are fully buildable** — the API blocks
nothing, so the choice is purely about what the operator optimizes for.

## Recommendation: **B — Flight Sheet**

The operator's primary surface is the board — the 5-second "where am I
needed" scan — and the dense table is the fastest triage per
implementation hour (M vs L), with A's SVG canvas being the only real
visualization debt in any variant. With the API gaps closed, A is a
legitimate pick if per-feature structural comprehension matters more than
board density — but note that B's feature view can later grow a graph
toggle fed by `/v1/projects/workflow` without touching its board, so
choosing B does not foreclose A's best idea. Adopt C's live-event strip
into B's health drawer for ambient daemon feel, and phase 1 is complete.
