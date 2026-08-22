## MODIFIED Requirements

### Requirement: Board groups features by workflow jobs

The default route SHALL provide an operational overview and SHALL organize active features into workflow-scoped boards whose columns are jobs from one workflow projection in dependency order. A feature SHALL appear at each currently running job, or at each ready job when none is running, so parallel execution is represented without assigning an arbitrary primary job. Feature status SHALL remain visible through a textual badge, glyph, color treatment, age, and available action; `waiting_human` and `escalated` features SHALL receive the strongest attention treatment within their job columns. Terminal features SHALL not crowd active job columns and SHALL remain available in a compact recent/history section. A feature whose frontier cannot be resolved SHALL remain visible in a diagnostic section.

On a narrow viewport, the board SHALL present one selected job stage at a time with explicit stage navigation rather than shrinking all workflow columns below a usable width. The board SHALL not require drag-and-drop because job advancement is engine-owned.

#### Scenario: Parallel feature appears at each active job

- **WHEN** a feature has two jobs with status `running`
- **THEN** the workflow board renders an instance of that feature in both corresponding job columns
- **AND** each instance indicates that the feature has parallel active work

#### Scenario: Human attention remains visible without a status column

- **WHEN** a feature is `waiting_human` at a workflow job
- **THEN** its job card displays a waiting-human label and an attention treatment before ordinary running cards in that job
- **AND** the primary review action is reachable from that card or its feature workspace

#### Scenario: Mobile board selects one workflow stage

- **WHEN** the board renders below the mobile breakpoint
- **THEN** it shows one selected job's feature list and a horizontally navigable job-stage selector
- **AND** it does not create document-level horizontal overflow

#### Scenario: Incompatible workflows are not mixed

- **WHEN** features belong to different project workflow projections
- **THEN** the UI renders separate workflow boards or requires an explicit workflow scope
- **AND** it does not merge unrelated jobs into one global set of columns

### Requirement: Feature workspace presents an interactive workflow graph

Opening a feature SHALL render a dedicated workflow workspace that joins workflow structure from `GET /v1/projects/workflow?dir=<projectDir>` with live feature runtime state. The graph SHALL support panning by dragging the canvas in any direction, zoom controls, and a fit-to-workflow action so large workflows are explorable without using the document scrollbar as the graph camera. Jobs SHALL remain the primary graph nodes and steps SHALL remain inspectable within them. The graph SHALL communicate state with labels and glyphs in addition to color, render rerun loops according to their lifecycle semantics, and expose a keyboard-operable workflow outline or equivalent navigation.

On wide viewports, the graph and inspector SHALL form a stable column layout. On narrow viewports, graph exploration SHALL be available in a full-screen mode and inspector content SHALL open as a mobile sheet or stacked detail surface. A stale, unregistered, or invalid workflow SHALL continue to render an explicit diagnostic state instead of an empty canvas.

#### Scenario: Operator pans a large graph

- **WHEN** the workflow graph is larger than its viewport and the operator drags empty canvas space
- **THEN** the graph stage moves with the pointer in both axes
- **AND** the surrounding document does not scroll as the substitute for graph movement

#### Scenario: Fit action restores graph context

- **WHEN** the operator has panned or zoomed away from the workflow
- **THEN** activating fit-to-workflow places all job nodes within the visible graph viewport at a readable scale

#### Scenario: Graph selection opens adjacent detail

- **WHEN** the operator selects a job or step on a wide viewport
- **THEN** its inspector appears in the adjacent detail column without moving below the graph
- **AND** the graph selection remains visible

#### Scenario: Mobile graph exploration is touch usable

- **WHEN** a feature workspace renders below the mobile breakpoint
- **THEN** the page shows a fitted graph overview with an explicit full-screen exploration action
- **AND** the full-screen graph supports touch panning without requiring hover

### Requirement: Step inspector integrates outputs, logs, findings, and history

The feature workspace SHALL provide a persistent contextual inspector for the selected job or step. Outputs and logs SHALL remain selectable tabs, and findings and timeline SHALL be available as neighboring workspace panels rather than unrelated long sections below the graph. Selecting a single-step job SHALL automatically inspect that sole step; selecting an active multi-step job SHALL inspect its current step; selecting an inactive multi-step job SHALL require an explicit step selection. Log pagination SHALL continue until all currently available pages are loaded and SHALL append live `run_log` invalidations without duplicates.

#### Scenario: Single-step job reveals its run immediately

- **WHEN** the operator selects a completed job containing exactly one step
- **THEN** the inspector selects that step and exposes its outputs and logs without another graph click

#### Scenario: Outputs remain adjacent to graph context

- **WHEN** the operator opens outputs for a selected step on a wide viewport
- **THEN** the output appears in the inspector column next to the graph
- **AND** opening it does not add a full-width panel below the graph

#### Scenario: Historical logs load all pages

- **WHEN** a completed run has more log lines than one response page
- **THEN** the inspector follows the returned cursor while pages remain truncated
- **AND** renders all lines once without waiting for a future SSE event

### Requirement: Human actions use integrated validated surfaces

Gate decisions, interactive questions, recovery, and destructive lifecycle actions SHALL use application-owned dialogs or sheets with feature, job, and step context. Recovery SHALL use a labeled required notes field instead of a browser-native prompt and SHALL preserve the entered note if the server reports stale or conflicting feature state. Request-changes notes SHALL remain required. The surfaces SHALL expose pending, inline validation, server-error, and success states; SHALL close with an explicit control and Escape; and SHALL restore focus to their trigger.

On mobile, action surfaces SHALL fit within the dynamic viewport, account for safe-area insets, keep their submission controls reachable when the software keyboard is present, and use full-width controls where necessary.

#### Scenario: Recovery note is validated in the application

- **WHEN** an escalated feature is opened and the operator activates Recover
- **THEN** the UI opens a recovery surface with a labeled notes field
- **AND** blocks submission until the note contains non-whitespace text
- **AND** does not invoke a browser-native prompt

#### Scenario: Stale recovery preserves operator input

- **WHEN** recovery returns a stale or conflict response
- **THEN** the UI refetches current feature state and explains that it changed
- **AND** keeps the operator's note for review and explicit resubmission

#### Scenario: Mobile keyboard does not hide submission

- **WHEN** an action form is open on a narrow viewport and its textarea has focus
- **THEN** the primary and cancel actions remain reachable within the form's scrollable viewport

### Requirement: Control Room is responsive, accessible, and statefully animated

The app SHALL remain usable from 320 CSS pixels through wide desktop displays without document-level horizontal overflow. Interactive controls SHALL provide visible keyboard focus and practical coarse-pointer targets; status SHALL never be communicated through color alone; dialogs and sheets SHALL manage focus; and live updates SHALL not unexpectedly discard focused context. Motion SHALL be limited to meaningful state transitions, selection, graph camera commands, and surface entry/exit, and SHALL be removed or reduced when `prefers-reduced-motion: reduce` is active.

#### Scenario: Compact mobile layout remains operable

- **WHEN** the Control Room renders at 320 CSS pixels
- **THEN** primary navigation, board stage selection, feature actions, graph exploration, outputs, and logs remain reachable
- **AND** only intentionally scrollable technical content such as logs may overflow horizontally

#### Scenario: Reduced motion disables spatial transitions

- **WHEN** the operating system requests reduced motion
- **THEN** drawers, graph fitting, card movement, and attention treatments do not use non-essential spatial animation

#### Scenario: Keyboard operator inspects a workflow

- **WHEN** the operator navigates without a pointer
- **THEN** jobs, steps, inspector tabs, and action controls are reachable with visible focus
- **AND** selecting a graph item exposes the same detail available to pointer users

### Requirement: Live updates are invalidation-driven

The app SHALL open exactly one SSE connection (`GET /v1/events`) after auth, using a fetch-based reader so the bearer header is set. Invalidations SHALL be coalesced over a ~150 ms window so a burst for one feature triggers one refetch pass. Refetch scope SHALL follow the kind: `feature` → affected overview and workflow board cards, `transition` → feature detail + timeline, `run` → feature detail + runs, `finding` → findings; events for features not currently on screen SHALL only refresh list-backed views. Command responses SHALL be applied directly and their echo invalidations ignored. There SHALL be no polling in normal operation. When the stream drops, the app SHALL show a "live updates paused" or reconnecting state and poll `GET /v1/health` every 5 seconds until the stream returns. Live movement between job columns SHALL preserve useful focus and SHALL be announced without making every event an assertive interruption.

#### Scenario: Burst of invalidations coalesces

- **WHEN** `transition` + `run` + `feature` invalidations for one feature arrive within the window
- **THEN** the app performs one refetch pass for that feature

#### Scenario: Own command response is not double-applied

- **WHEN** an approve command succeeds and a matching invalidation arrives shortly after
- **THEN** the app keeps the command response's payload and does not refetch

#### Scenario: Stream drop preserves the last view

- **WHEN** the SSE stream errors or closes while REST remains reachable
- **THEN** the app retains the last board and feature snapshots
- **AND** shows a reconnecting state while health polling continues every 5 seconds

## REMOVED Requirements

### Requirement: Board groups features into status columns

**Reason**: Status columns obscure workflow position and combine features from incompatible workflow structures. Status remains an explicit card-level signal and a compact overview concern.

**Migration**: Operators use workflow-scoped job columns for execution position and the overview/recent sections for cross-workflow triage.

### Requirement: Selecting a card reveals the workflow graph strip

**Reason**: A full-width inline strip destabilizes board geometry, produces nested scrolling, and cannot support large pannable graphs or a readable inspector layout.

**Migration**: Selecting a card opens its dedicated feature workspace with the relevant job selected; human actions remain directly reachable from attention cards.

### Requirement: Human gate decision completes within two clicks

**Reason**: A strict click count conflicts with validated, contextual, accessible action surfaces and mobile interaction. Fast gate access remains required, but submission must make notes, structured questions, stale state, and command effects clear.

**Migration**: Waiting-human cards expose a direct review action that opens the integrated gate sheet with the final decision controls.
