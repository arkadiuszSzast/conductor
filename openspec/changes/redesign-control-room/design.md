## Context

See `proposal.md` for motivation and `specs/web-ui/spec.md` for observable behavior. The current browser has two routes, a status-column board with inline graph expansion, and a feature route with a scrollable SVG graph, fixed inspector column, findings, timeline, and native recovery prompt. Its REST/SSE data layer, typed wire projections, pure graph merge/layout functions, gate validation, and run-log cursor logic are sound and remain the architectural base.

The list API includes project directory, workflow name, feature status, and per-job status, but workflow structure must be loaded per project. Different projects can define incompatible job sets, so job columns cannot be a global union. The worktree already contains unrelated card, idempotency, recovery, and inspector improvements; implementation must preserve them.

## Goals / Non-Goals

**Goals:**

- Establish a coherent route and component architecture for overview, workflow board, feature exploration, and human actions.
- Represent graph execution honestly, including parallel active jobs and unresolved frontiers.
- Provide a native pointer/touch graph camera while retaining pure domain layout logic and semantic controls.
- Make desktop and mobile layouts deliberate rather than compressed versions of each other.
- Create a distinctive dark operational visual system with semantic color, strong typography, layered surfaces, and restrained animation.
- Keep REST authoritative and SSE as invalidation only.

**Non-Goals:**

- No workflow editing, graph node dragging, manual job advancement, or drag-and-drop kanban.
- No backend schema, scheduler, runner, or durability changes. The existing interpreter/store status projection may be hardened where concurrent persisted gates/questions would otherwise be hidden from the UI.
- No graph, state-management, or component library unless the native prototype demonstrates a measured deficiency.
- No light theme in this change; tokens keep a future theme seam.
- No virtualization or minimap until real workflow and board sizes justify them.

## Decisions

### Split triage from workflow execution

The default shell has a compact **Now** overview for cross-project attention and one workflow board per project/workflow. The board renders topologically ordered job columns. Terminal features move to recent/history instead of occupying active columns.

For the first implementation, scope can be derived from the loaded feature list and workflow resources without a server change. The canonical route state is query/path state where practical, with a safe first-workflow default. A feature with multiple running jobs appears in each corresponding column with a parallel marker. If none runs, ready jobs form the frontier; failed escalated jobs are used next; unresolved features remain in an explicit tray.

Alternative: retain status columns. Rejected because it cannot answer where work sits in a workflow. Alternative: union all job names globally. Rejected because names and dependencies are workflow-local. Alternative: force one card per feature. Rejected because it hides fan-out.

### Retire inline graph expansion

Board cards navigate to a dedicated feature workspace, optionally with a selected job. Human-attention cards keep a direct review/recovery affordance so urgent actions do not require hunting. The board remains stable and optimized for scanning; deep output, logs, findings, and timeline belong in the workspace.

Alternative: continue growing `GraphStrip`. Rejected because it creates unstable column height, nested scroll regions, and an unusable mobile composition.

### Use a native transformed graph stage

The graph viewport owns camera state `{x, y, scale}`. A pointer-captured drag on empty canvas updates translation in both axes; wheel/trackpad pans; explicit controls zoom, reset, and fit. Camera updates are local view state and never touch the server. Existing `mergeGraph` and `layoutJobs` remain pure. Edges render in an SVG layer while semantic job and step buttons render as HTML elements inside the same transformed stage. The first implementation may retain SVG nodes if it can provide equivalent keyboard buttons, but the target is HTML controls for accessibility.

Fit computes a bounded scale and centered translation from graph and viewport dimensions. Pointer movement is coalesced through `requestAnimationFrame` only if profiling shows synchronous state updates dropping frames. Mobile graph exploration enters a full-screen viewport to avoid hijacking normal page scrolling.

Alternative: add React Flow or another canvas library. Deferred because this is an observational graph with domain-specific layout, not an editor, and the repository has no need for the dependency's broader editing model.

### Use a graph/inspector workspace instead of stacked details

Wide screens use a flexible graph column and an inspector width of roughly `clamp(22rem, 32vw, 30rem)`. Outputs, logs, findings, and timeline become tabs/panels in that inspector. The selected job/step remains visible in graph state and, where routing permits, in the URL. Tablet uses an overlay drawer; mobile uses a bottom/full-screen sheet. This makes one canonical `StepInspector` responsible for run selection and logs.

### Use application-owned action sheets

Gate and recovery actions share an accessible overlay shell with title, context, scrollable body, and sticky actions. Recovery exposes required notes while supplying `expectedVersion` and `idempotencyKey` internally. On stale/conflict responses, the form keeps notes, refetches detail, and requires explicit resubmission. Abandon uses a destructive confirmation; pause and resume remain direct pending actions.

Alternative: native prompts/confirms. Rejected because they cannot present context, validation, pending state, stale-state recovery, responsive layout, or consistent accessibility.

### Adopt semantic design tokens and purposeful motion

The visual direction is a dark "signal deck": deep navy canvas, elevated graphite panels, cool cyan for execution, amber for human intervention, coral for escalation/failure, mint for success, and muted slate for pending/paused. Typography uses a distinctive condensed/technical sans stack with monospace for machine data; locally available fallbacks avoid a network dependency. Background grids and restrained glow create depth without a generic purple-on-black dashboard.

Motion communicates state changes: initial section reveal, one-shot destination highlight, inspector/sheet entry, and explicit graph fit. Perpetual card movement and decorative background animation are excluded. Reduced-motion removes spatial movement.

### Preserve protocol and side-effect boundaries

The browser continues to read REST projections through `DataSource`; SSE only invalidates cached resources. Pure selectors derive workflow scopes, topological job order, and frontier card instances. Components own ephemeral selection, camera, and form state. Commands remain side effects through the existing API client and command wrapper.

There are no scheduler or concurrency implications: parallel card duplication only visualizes already durable job runtime state. SQLite remains the source of truth; no migration is required. The interpreter remains pure and the engine remains the sole owner of workflow side effects.

Feature-level `waiting_human` is an aggregate projection, not an independently writable branch status. The store reconciles it transactionally from persisted `waiting_human` steps and active runs with `pending_question`; terminal, paused, and escalated states retain precedence. This prevents a sibling transition or one answered question from hiding other durable attention surfaces. The interpreter still emits `waiting_human` when root/resumed human steps are entered, and the web derives gate/question surfaces from persisted detail even if a stale scalar snapshot briefly disagrees.

## Risks / Trade-offs

- [Workflow resources require per-project loading] -> Group features by project first, cache existing workflow requests, show skeleton/diagnostic scope states, and avoid N+1 feature-detail requests.
- [Parallel features appear more than once] -> Mark every duplicate with the active parallel count and use one feature ID plus job ID as card identity.
- [Custom pan/zoom can harm page scrolling or accessibility] -> Restrict drag initiation to graph canvas, provide explicit controls and outline navigation, test pointer capture, touch, keyboard, and reduced motion.
- [Route expansion can overgrow the first implementation] -> Deliver stable `/` and `/feature/:id` behavior first, then add deep links without blocking visual restructuring.
- [Large redesign in a dirty worktree] -> Make additive components and focused edits, inspect diffs before each replacement, and never reset pre-existing server or UI changes.
- [Mobile sheets and software keyboards are browser-sensitive] -> Use dynamic viewport units, safe-area padding, sticky actions inside one scroll container, and viewport smoke tests at 320/390/768 widths.
- [New visual polish can reduce information density] -> Keep machine metadata compact, semantic, and monospaced; validate the design with the current dogfood workflow rather than marketing-only fixtures.

## Migration Plan

1. Add pure workflow-board derivation tests and semantic tokens without changing daemon contracts.
2. Introduce the new shell and workflow board while retaining feature navigation.
3. Replace the graph renderer with a pannable viewport and integrate the inspector column.
4. Replace recovery and gate overlays, then consolidate findings/timeline into the workspace.
5. Add responsive and accessibility passes, build the embedded SPA, and dogfood against the registered `feature-delivery` workflow.
6. Rollback is a web-only binary rollback: no data or project configuration migration needs reversal.

## Open Questions

- The minimap remains optional until the largest dogfood workflow shows that fit/reset controls are insufficient.
- Stable project IDs may later replace encoded project directories in route state, but that API contract is outside this change.
