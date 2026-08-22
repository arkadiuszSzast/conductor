## Why

The current Control Room exposes the right runtime data but presents it as a dense desktop-only status kanban with nested detail panels, a scroll-only graph, and browser-native lifecycle prompts. Operators need a polished, workflow-oriented interface that remains fast to scan, makes human intervention unmistakable, supports large graphs, and works as a first-class mobile application.

## What Changes

- **BREAKING** Replace the default status-column kanban with workflow-scoped boards whose columns are workflow jobs and whose cards represent each feature's active job frontier; status remains visible through semantic badges, tone, and attention markers rather than board position.
- Add a compact cross-workflow overview so urgent human gates, escalations, paused work, and recent completions remain easy to triage without mixing incompatible workflow job columns.
- Replace inline board graph expansion with a dedicated feature workspace: a pannable and zoomable graph canvas beside a persistent inspector for outputs, logs, findings, and timeline.
- Add mobile-specific navigation and layouts: one selected job stage at a time on the board, a fitted graph overview with full-screen exploration, and full-screen action/inspector sheets.
- Replace raw recovery prompts and loosely composed gate controls with application-owned, validated action surfaces that preserve notes and explain stale/conflicting state.
- Establish a deliberate visual system with strong typography, layered operational surfaces, semantic status tokens, accessible focus states, and restrained state-driven animation with reduced-motion support.
- Preserve the existing browser API, SSE invalidation model, gate semantics, workflow merge/layout rules, findings lifecycle, and durable daemon state rather than introducing parallel state or protocol layers.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `web-ui`: Change the Control Room information architecture, board grouping, graph interaction, inspector placement, responsive behavior, and human action forms while preserving live API-backed behavior.

## Impact

- Primary implementation impact is `apps/web`: routing, shell, board models/components, graph renderer and camera state, feature workspace, gate/recovery surfaces, CSS tokens, and web tests.
- The daemon HTTP API, SQLite schema, scheduler, runner protocol, interpreter, and engine behavior do not change; there is no database migration and no change to gloam-idle or other project `conductor.yaml` files.
- The board and graph behaviors carried over from opencode-conductor remain because they provide proven operational value, but their visual composition and navigation are replaced to suit the standalone product.
- Existing feature, workflow, run, log, finding, timeline, gate, and lifecycle endpoints remain authoritative. No hosted-service, agent-framework, or CI-replacement scope is introduced.
- No mandatory runtime dependency is planned for the graph; existing pure merge/layout logic remains the starting point, with native pointer and keyboard interactions layered over it.
