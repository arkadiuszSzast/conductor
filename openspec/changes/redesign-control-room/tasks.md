## 1. Models and Visual Foundation

- [x] 1.1 [web][test] Add pure workflow-scope, topological job-order, active-frontier, parallel-instance, recent-feature, and unresolved-feature derivation with unit coverage.
- [x] 1.2 [web] Replace the base token and global style layer with the responsive signal-deck palette, typography, spacing, focus, safe-area, and reduced-motion primitives.
- [x] 1.3 [web] Build the responsive application shell and navigation while preserving auth, health, SSE connection state, and toast behavior.

## 2. Workflow Board

- [x] 2.1 [web] Replace status kanban columns with workflow-scoped job columns and semantic feature-job cards, including attention ordering and parallel markers.
- [x] 2.2 [web] Add a compact cross-workflow Now/recent area and explicit unresolved diagnostics without hiding paused or terminal features.
- [x] 2.3 [web] Add the mobile job-stage selector and one-column feature list with no document-level horizontal overflow.
- [x] 2.4 [web][test] Preserve URL-safe feature navigation and test board derivation across incompatible workflows, fan-out, human gates, escalations, skipped jobs, and empty states.

## 3. Graph Workspace

- [x] 3.1 [web][test] Add a pure graph camera model for drag-pan, zoom bounds, reset, and fit calculations with unit coverage.
- [x] 3.2 [web] Replace the scroll-only graph with a transformed stage that supports pointer capture, two-axis pan, zoom controls, fit, selected/current treatments, and semantic job/step controls.
- [x] 3.3 [web] Redesign the feature page as a graph-first desktop workspace with a persistent inspector column and responsive mobile graph exploration.
- [x] 3.4 [web] Consolidate outputs, logs, findings, and timeline into contextual workspace panels while preserving sole-step auto-selection and live run selection.
- [x] 3.5 [web][test] Complete historical log cursor pagination and verify no duplicate lines across initial pages and live invalidations.

## 4. Human Action Surfaces

- [x] 4.1 [web] Add an accessible responsive dialog/sheet primitive with focus management, Escape handling, sticky actions, dynamic viewport sizing, and safe-area padding.
- [x] 4.2 [web][test] Replace native recovery prompting with a validated recovery sheet that retains notes across stale/conflict responses and prevents duplicate submissions.
- [x] 4.3 [web] Restyle and compose gate decisions and structured questions into the same action system while preserving request-change validation and conflict handling.
- [x] 4.4 [web] Add an explicit destructive abandon confirmation and harmonize pause/resume/recover command feedback.

## 5. Responsive and Accessibility Pass

- [x] 5.1 [web] Implement compact top-bar, board, graph, inspector, forms, health panel, and toast layouts for 320px, 390px, tablet, and wide desktop viewports.
- [x] 5.2 [review] Verify keyboard-only graph and action workflows, visible focus, status labels beyond color, focus restoration, coarse-pointer targets, safe areas, and reduced motion.
- [x] 5.3 [test] Add browser or deterministic viewport smoke coverage for board, feature workspace, graph camera, gate, recovery, logs, and document overflow.

## 6. Verification and Dogfooding

- [x] 6.1 [test] Run web unit tests, strict typecheck, lint, production build, and the full repository test suite; fix all regressions attributable to the change.
- [x] 6.2 [review] Review the final diff for accidental changes to the existing server recovery work, API protocol, workflow engine, and dirty-worktree edits.
- [x] 6.3 [docs] Update the Control Room design notes to document workflow boards, graph interactions, mobile behavior, and action surfaces.
- [x] 6.4 [web][test] Build the embedded binary, restart the dogfood daemon, and smoke-test the registered `feature-delivery` workflow on desktop and mobile dimensions.
