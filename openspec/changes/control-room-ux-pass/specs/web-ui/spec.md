## MODIFIED Requirements

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

The daemon SHALL send an SSE comment frame on every open stream at least
every 20 seconds. The app SHALL treat a stream that delivered no bytes for
50 seconds as dead and reconnect. Every reconnect after the first connection
SHALL refetch the board list, health, loaded workflow projections, plugin
listings and every loaded resource of the on-screen feature, because
invalidations sent while disconnected are lost. When the app returns to the
foreground (page visible, restored from cache, or back online), a dead or
silent stream SHALL be replaced immediately without backoff, and a healthy
stream SHALL trigger the same resync at most once per 10 seconds.

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

#### Scenario: Reconnect resyncs missed state

- **WHEN** the stream reconnects after a drop while a feature is open
- **THEN** the app refetches the board list and that feature's detail and
  loaded runs, findings and timeline

#### Scenario: Returning to a backgrounded PWA

- **WHEN** the installed app returns to the foreground after its stream was
  silently dropped
- **THEN** the app reconnects immediately and shows current state without a
  manual reload

### Requirement: Step inspector reads outputs and tails run logs

Clicking a graph node or step SHALL open a step inspector (side panel on wide
viewports, bottom sheet on narrow ones) with Logs and Outputs tabs, Logs
selected first, and the selected run's status. The Outputs tab SHALL show the
step's outputs from the detail payload; an output marked `truncated: true`
SHALL offer the full value via `GET /v1/runs/:id` using the step's `runId`.
The Logs tab SHALL tail the run's log through `GET /v1/runs/:id/logs` with
cursor pagination (`after=<nextSeq>`), driven to refetch by `run_log` SSE
invalidations while the run is live, and SHALL keep the newest line in view
unless the operator scrolled up. Log sources SHALL be labeled distinctly. An
empty log of a live run SHALL say why by step kind (an agent's first output
is pending; a command's output is captured when it finishes). Findings and
the timeline SHALL NOT be inspector tabs; they SHALL be shown in a
feature-level History panel on the feature page. A `?job=` deep link on a
narrow viewport SHALL open the inspector sheet for that job.

#### Scenario: Truncated output resolves to the full run

- **WHEN** an inspector shows a step output marked `truncated: true`
- **THEN** opening the full value fetches `GET /v1/runs/<runId>` and renders
  the untruncated text

#### Scenario: Log tail advances by cursor

- **WHEN** an inspector is tailing a live run and `run_log` invalidations
  arrive
- **THEN** the inspector refetches with `after=<nextSeq>` from the last page
  and appends the new lines without duplicating existing ones

#### Scenario: Timeline is feature-wide

- **WHEN** the operator opens a feature
- **THEN** its timeline and findings are available from the History panel
  regardless of which step is selected

## ADDED Requirements

### Requirement: Board lanes follow pipeline stages

The default route SHALL render the active features of the selected workflow
scope by pipeline stage. A stage SHALL be the set of jobs at the same
dependency layer (longest path through `needs`), labelled by the job id or,
for several jobs, their shared id stem and count (`review ×8`). A rail SHALL
show every stage in order with the count of features in it; lanes SHALL be
rendered only for stages that hold at least one feature. A feature SHALL
appear once in each stage its frontier (running jobs, else ready jobs, else
failed jobs of an escalated feature) touches, and its card SHALL list each of
its active jobs in that stage with the job's current step. Cards SHALL also
show status glyph and age from `updatedAt`, the title, job progress
(`n/n`), the findings badge, and the escalation reason verbatim when
escalated. `waiting_human` and `escalated` cards SHALL sort first within a
lane. On first render of a scope the board SHALL bring into view the first
stage holding a feature that needs a human, else the first occupied stage.
Done, abandoned and paused features SHALL appear in the overview strip, not
in lanes.

The board SHALL be a single vertical scroll region. The recent-history
preview SHALL show at most 8 entries on wide viewports and 2 below 768 CSS
pixels; "show all" SHALL reveal every terminal feature inside a bounded,
independently scrolling list.

#### Scenario: Parallel jobs share a stage

- **WHEN** a feature runs `review_code_core` and `review_gpt`, both at the
  same dependency layer
- **THEN** the board shows one card in the `review ×N` lane listing both jobs
  with their current steps

#### Scenario: Empty stages do not take a column

- **WHEN** only the `impl` stage holds a feature
- **THEN** exactly one lane renders and every other stage appears only in the
  rail

#### Scenario: Board focuses the stage that needs attention

- **WHEN** the board opens with a running feature in stage 1 and a
  `waiting_human` feature in stage 3
- **THEN** stage 3 is scrolled into view

#### Scenario: Card shows freshness without live clocks

- **WHEN** a feature card renders
- **THEN** it shows an age computed from `updatedAt`
- **AND** the age re-renders on a local 30-second ticker, never from polling

#### Scenario: Full recent history stays reachable

- **WHEN** 76 terminal features exist and the operator chooses "show all"
- **THEN** all 76 are reachable by scrolling the expanded list without
  pushing the lanes out of reach

## REMOVED Requirements

### Requirement: Board groups features into status columns

**Reason**: Superseded by "Board lanes follow pipeline stages" — the board is organised by workflow position; status grouping already lives in the cross-workflow overview strip.

**Migration**: None; UI-only.
