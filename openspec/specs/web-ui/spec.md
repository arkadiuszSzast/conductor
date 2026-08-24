# web-ui Specification

## Purpose
The Conductor web UI ("Control Room") — a browser surface for the daemon's
HTTP API v1 that lets an operator answer "where am I needed?" and "what is
happening right now?" from a kanban board and a per-feature workflow graph,
with live invalidation-driven state.

## Requirements

### Requirement: Bearer-token auth gate

The app SHALL present a pre-bootstrap auth screen whenever the daemon
requires a bearer token. The entered token SHALL be stored in browser
localStorage (persisting across restarts, with a "forget" affordance to
clear it) and SHALL be attached as `Authorization: Bearer <token>` to every
API request, including the SSE invalidation stream. When the daemon reports
`auth.mode: "none"`, the app SHALL skip the auth screen entirely. A `401`
response at any time SHALL return the app to the auth screen.

#### Scenario: Daemon requires a token

- **WHEN** the app loads and `GET /v1/health` returns `401 unauthorized`
- **THEN** the app shows the auth screen and does not render the board
- **AND** after a valid token is entered the app proceeds to the board
- **AND** the token survives a page reload

#### Scenario: No auth configured

- **WHEN** the app loads and `GET /v1/health` succeeds without a token
- **THEN** the board renders directly with no auth screen

#### Scenario: Token rejected mid-session

- **WHEN** any authenticated request returns `401 unauthorized`
- **THEN** the app clears the stored token and returns to the auth screen

### Requirement: Board groups features into status columns

The default route SHALL render the feature list (`GET /v1/features`) as
kanban columns. `waiting_human` and `escalated` features SHALL share the
leftmost "NEEDS YOU" zone (escalated rendered visually distinct), followed
by `running`, `paused`, and a collapsed terminal zone for `done` and
`abandoned`. Each card SHALL show, from the list payload alone: status glyph
and age from `updatedAt`, the feature title, the project basename, the
workflow name, the gate/current step, per-job progress (`n/n`), the findings
badge (`findingCounts`), and the escalation reason verbatim when escalated.

#### Scenario: A waiting feature lands in the NEEDS YOU zone

- **WHEN** a feature has status `waiting_human`
- **THEN** the board renders its card in the NEEDS YOU zone before any
  `running` or `paused` card

#### Scenario: Card shows freshness without live clocks

- **WHEN** a feature card renders
- **THEN** it shows an age computed from `updatedAt`
- **AND** the age re-renders on a local 30-second ticker, never from polling

### Requirement: Selecting a card reveals the workflow graph strip

Selecting a card SHALL pin a full-width graph strip beneath the board that
renders the workflow DAG for that feature: structure from
`GET /v1/projects/workflow?dir=<projectDir>` (needs edges, declaration step
order, step kinds) joined with live per-step state from the feature detail
(status, attempts, reruns). Job nodes SHALL be layered by `needs` depth.
The current position SHALL read from color alone (amber treatment on the
active/waiting node and its current step row), succeeded edges solid green,
edges into the current node solid, pending downstream edges dashed and
dimmed, `skipped` steps shown with the ⤼ glyph. A second click or Esc SHALL
collapse the strip. When `workflowRef.stale` (or the endpoint's `stale`) is
true, the strip SHALL show a "workflow changed since this feature started"
banner. A `404` (unregistered) or `409` (never-valid) from the workflow
endpoint SHALL render a diagnostics card instead of a graph.

#### Scenario: Graph strip joins structure with live state

- **WHEN** a selected feature's job is on step `review` of a linear
  design → implement → review pipeline
- **THEN** the strip renders three job nodes left to right
- **AND** the completed design/implement nodes are green and the review node
  is rendered with the amber current treatment

#### Scenario: Stale workflow is signalled, not hidden

- **WHEN** the workflow endpoint returns `stale: true` for the feature's
  project
- **THEN** the strip shows a stale banner alongside the graph

#### Scenario: Unregistered project renders diagnostics

- **WHEN** the workflow endpoint returns `404` for the feature's project
- **THEN** the strip shows a "no workflow registered" card instead of a graph

### Requirement: Rerun loops appear only while in flight

A rerun back-edge SHALL be drawn only while a rerun-target job is the
currently active one; once the round completes, the edge SHALL disappear and
the job keeps a quiet "⟲ round N" chip derived from `JobRuntime.reruns`.
The feedback snapshot (`feedback` on the detail payload) SHALL be treated
per its lifecycle semantics: its presence means "at least one rerun has
ever happened", never "a loop is active now" — active-loop rendering
combines the snapshot with live job state.

#### Scenario: Loop edge visible during the round

- **WHEN** a routing step rejected and reset an upstream job, and that job
  is now the active one
- **THEN** the graph draws the dashed amber back-edge with the feedback
  message as its label

#### Scenario: Edge gone, chip remains after completion

- **WHEN** the rerun target job has completed the round
- **THEN** the back-edge is not drawn
- **AND** the job shows the "⟲ round N" chip from its rerun counter

### Requirement: Step inspector reads outputs and tails run logs

Clicking a graph node or step SHALL open a step inspector (drawer on the
board, side panel on the feature view) with two tabs. The Outputs tab SHALL
always show the step's outputs from the detail payload; an output marked
`truncated: true` SHALL offer the full value via `GET /v1/runs/:id` using
the step's `runId`. The Logs tab SHALL tail the run's log through
`GET /v1/runs/:id/logs` with cursor pagination (`after=<nextSeq>`), one
cursor per open inspector run, driven to refetch by `run_log` SSE
invalidations while the run is live. Log sources (`process`, `action`,
`agent`, `step`) SHALL be labeled distinctly.

#### Scenario: Truncated output resolves to the full run

- **WHEN** an inspector shows a step output marked `truncated: true`
- **THEN** opening the full value fetches `GET /v1/runs/<runId>` and renders
  the untruncated text

#### Scenario: Log tail advances by cursor

- **WHEN** an inspector is tailing a live run and `run_log` invalidations
  arrive
- **THEN** the inspector refetches with `after=<nextSeq>` from the last page
  and appends the new lines without duplicating existing ones

### Requirement: Human gate decision completes within two clicks

From the board, a `waiting_human` feature SHALL be approvable in two clicks:
click the card (1) and click Approve on the graph strip's decision row (2).
Request changes SHALL open an inline note field whose non-empty note is
required before the request is sent (mirroring the API's 400). On the
feature view a gate modal SHALL carry the same actions with the report
excerpt and findings visible. A `409 conflict` response SHALL surface the
server's message in a toast and refetch the feature.

#### Scenario: Approve from the board

- **WHEN** the operator clicks a `waiting_human` card and then clicks Approve
  on the strip's decision row
- **THEN** the app sends the approve command
- **AND** applies the fresh payload from the response without refetching
- **AND** the card moves off the NEEDS YOU zone

#### Scenario: Request changes requires a note

- **WHEN** the operator clicks Request changes without entering a note
- **THEN** the app blocks the request with an inline error
- **AND** sends nothing

#### Scenario: Gate decision races

- **WHEN** an approve command returns `409 conflict`
- **THEN** the app shows a toast with the server's message and refetches the
  feature

### Requirement: Health is an ambient top-bar indicator

A persistent dot in the top bar SHALL reflect `GET /v1/health`: green when
the daemon is `alive` and `ready`, non-green otherwise, with a popover
showing phase, heartbeat (`lastCompletedAt`, `lastError`, `cycles`),
per-project workflow state (`valid`/`stale`/`invalid`/`unregistered`) with
diagnostics, and runner availability.

#### Scenario: Health popover lists project states

- **WHEN** the operator opens the health popover
- **THEN** it lists each project's state and diagnostics
- **AND** the runner availability

### Requirement: Live updates are invalidation-driven

The app SHALL open exactly one SSE connection (`GET /v1/events`) after auth,
using a fetch-based reader so the bearer header is set. Invalidations SHALL
be coalesced over a ~150 ms window so a burst for one feature triggers one
refetch pass. Refetch scope SHALL follow the kind: `feature` → the board
list, `transition` → feature detail + timeline, `run` → feature detail +
runs, `finding` → findings; events for features not currently on screen
SHALL only refresh the board list. Command responses SHALL be applied
directly and their echo invalidations ignored. There SHALL be no polling in
normal operation. When the stream drops, the app SHALL show a
"reconnecting" chip and poll `GET /v1/health` every 5 seconds until the
stream returns.

#### Scenario: Burst of invalidations coalesces

- **WHEN** `transition` + `run` + `feature` invalidations for one feature
  arrive within the window
- **THEN** the app performs one refetch pass for that feature

#### Scenario: Own command response is not double-applied

- **WHEN** an approve command succeeds and a matching invalidation arrives
  shortly after
- **THEN** the app keeps the command response's payload and does not refetch

#### Scenario: Stream drop shows reconnect state

- **WHEN** the SSE stream errors or closes
- **THEN** the app shows the reconnecting chip and polls health every 5
  seconds until the stream reconnects

### Requirement: Errors map to the envelope

Every API error (`{error: {code, message, requestId}}`) SHALL map to UI
behavior: `400` → inline form error, `404` → "feature gone" toast + board
refetch, `409` → toast with the server message + refetch, `500` → toast with
the `requestId` for log correlation. Workflow-endpoint `404`/`409` SHALL NOT
be treated as errors — they render as workflow states with diagnostics.

#### Scenario: Server error correlates by request id

- **WHEN** an API call returns `500`
- **THEN** the app shows a toast including the `requestId`

### Requirement: A workflow scope is always selected while any project is registered

The board SHALL derive its workflow scopes from the daemon's registered
projects joined with each project's workflow projection; the feature
list SHALL only contribute counts and additional scopes for features
whose workflow differs from the project's configured one. Whenever at
least one project is registered, exactly one scope SHALL be selected: a
sole scope is selected automatically with no interaction, and with
several scopes the previous freeze/default rules apply. The UI's active
scope SHALL be empty only when the daemon has no registered projects.

#### Scenario: Quiet daemon still has a selected scope

- **WHEN** the daemon has one registered project and no features at all
- **THEN** the board shows that project's scope as selected with an
  empty board (no features), and scope-dependent surfaces (plugin rail,
  start work) receive that project as the active scope

#### Scenario: Feature-less project is reachable

- **WHEN** the daemon has two registered projects and only one has
  features
- **THEN** both projects present scope tabs and the operator can switch
  to the feature-less project's scope

#### Scenario: Broken workflow still yields a scope

- **WHEN** a registered project's workflow is unregistered or invalid
- **THEN** the project still presents a scope tab and selecting it shows
  the existing workflow diagnostics rendering rather than the scope
  being absent

#### Scenario: No projects, no scope

- **WHEN** the daemon has no registered projects
- **THEN** no scope is selected and the board presents its empty state

### Requirement: The shell hosts the plugin panel rail

The Control Room shell SHALL reserve a right-side region for the plugin
panel rail (specified in the `plugin-panels` capability) alongside the
board and feature views, on both desktop and narrow viewports (where the
rail collapses into an overlay). The rail SHALL NOT obscure or displace
the human-gate flow: gate decisions remain reachable within two clicks
while a panel is open. The rail SHALL follow the board's always-selected
scope for project-plugin visibility; it SHALL NOT implement its own
project fallback.

#### Scenario: Panel open beside the board

- **WHEN** a plugin panel is open on a desktop viewport
- **THEN** the board remains usable beside it and gate actions remain
  reachable within two clicks

#### Scenario: Narrow viewport uses an overlay

- **WHEN** a plugin panel is opened on a narrow viewport
- **THEN** the panel presents as an overlay/sheet and can be dismissed to
  return to the board

#### Scenario: Project plugin visible on a quiet daemon

- **WHEN** the daemon has one registered project with a project plugin
  and no features exist
- **THEN** the rail shows the plugin's tab because the board's selected
  scope names that project
