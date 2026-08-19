# Control Room redesign — implementation notes

Reference: `openspec/changes/redesign-control-room/{proposal,design}.md` for
the accepted rationale and decisions. This note documents what shipped so
future changes to the board, graph, or action surfaces have a map.

## Workflow boards, not status columns

`src/board/workflow-board.ts` derives everything the board renders, purely
from the feature list plus one workflow projection:

- **Scopes** (`deriveWorkflowScopes`) group features by `projectDir` +
  `workflow`, busiest-first. Only the *selected* scope's workflow structure
  is fetched (`GET /v1/projects/workflow?dir=`), so opening the board never
  N+1s across every project a daemon knows about.
- **Frontier** (`resolveFrontierJobIds`) picks the job(s) that represent a
  feature's current position: every `running` job, else every `ready` job,
  else — only for `escalated` features with nothing running/ready — every
  `failed` job, so an escalation still lands somewhere concrete. A feature
  with no resolvable frontier goes to an explicit "unresolved" tray instead
  of silently disappearing.
- **Columns** (`jobColumnOrder`) reuse the graph's `assignLayers` so board
  columns and graph layers agree on dependency order.
- Paused and terminal features never occupy a job column; `deriveOverview`
  covers them (plus `waiting_human`/`escalated`) in the "Now" strip above
  the board, independent of which scope is selected.

`src/board/*` components (`ScopeTabs`, `JobColumn`, `JobFrontierCard`,
`OverviewStrip`, `StageSelector`) are thin renderers over that model. Below
~768px, `board.tsx` swaps the column grid for `StageSelector` + one job's
card list — the same derived `WorkflowBoardModel`, different presentation.

Board cards link to `/feature/:id?job=<jobId>&open=gate|recover` so a
`waiting_human`/`escalated` card's quick action opens the feature workspace
with the right job pre-selected and the right sheet already open.

## Graph: pannable camera + HTML/SVG hybrid

`src/graph/camera.ts` is the pure viewport math (`{x, y, scale}`, pan, zoom
around a focal point, fit-to-content, reset) — no DOM. Existing structure
(`merge.ts`) and geometry (`layout.ts`) are unchanged; `mergeGraph` and
`layoutJobs` still own the domain logic.

`src/graph/graph-viewport.tsx` wraps the SVG in a CSS-transformed stage:
pointer capture drives two-axis drag-pan, wheel/trackpad also pans (never
zooms, so nothing surprises an operator scrolling the page), and an
explicit toolbar provides zoom in/out/fit/reset. Below the mobile
breakpoint an "explore fullscreen" toggle covers the viewport so touch
panning isn't fighting a cramped inline canvas. Job and step nodes stay SVG
(the domain layout is SVG-coordinate based) but are individually
`tabIndex`-able `<g role="button">` elements with Enter/Space activation
and `aria-label`s, so keyboard/AT users reach the same detail pointer users
do without a parallel navigation model.

## Feature workspace: graph + persistent inspector

`src/feature/feature-view.tsx` is graph-first on wide viewports: a flexible
graph column beside a `var(--inspector-w)` inspector column. The inspector
(`step-inspector.tsx`) is the single place that resolves run/log/output
state (`use-step-run.ts`) and now also hosts findings and timeline as tabs,
so nothing is a full-width panel below the graph. Below the mobile
breakpoint the inspector becomes a bottom sheet, opened by selecting a
graph node.

Log pagination (`inspector-logic.ts: loadAllLogPages`) follows the
`nextSeq`/`truncated` cursor until a page reports no more truncation (or
stops advancing, as a defensive cap), so a completed run's full history
loads on first inspection instead of trickling in only via live
invalidations.

## Action surfaces

`src/ui/action-sheet.tsx` is the shared dialog/sheet primitive: focus trap,
Escape-to-close, focus restoration on close, sticky actions, and a
mobile-bottom-sheet layout via one media query (no separate mobile
component). `GateModal`, `RecoverySheet`, and `ConfirmSheet` (abandon) all
build on it.

`RecoverySheet` (`src/feature/recovery-sheet.tsx`) replaces
`window.prompt`: a required, validated notes `<textarea>`, pending state,
and on a stale/conflict response it refetches feature detail, surfaces an
inline notice, and **keeps the operator's note** for review/resubmission
rather than discarding it. The idempotency key is generated once per sheet
instance so a resubmission after a conflict reuses the same key.

## Visual system

`src/styles/tokens.css` defines the "signal deck" palette (cyan =
execution, amber = human attention, coral = escalation/failure, mint =
success, slate = pending/paused — no purple), a condensed/technical type
stack with fully-local fallbacks, spacing/radius/motion/safe-area
primitives, and a `prefers-reduced-motion` override that zeroes durations
globally. `global.css` adds the layered grid background, focus-visible
rules, and coarse-pointer target sizing. Motion is scoped to state
transitions (card entry, sheet/toast entry, attention pulses) — no
perpetual background animation — and every animated rule has a
reduced-motion counterpart.

## Code-review hardening pass

A follow-up pass addressed a code review of the initial implementation:

- **Stale workflow projections are rejected, not silently mislabeled.**
  `GET /v1/projects/workflow?dir=` serves exactly one projection per
  project — the currently registered workflow — so a scope naming an old
  workflow (a rename, or features started under a workflow that has since
  changed) can no longer render that project's columns under the wrong
  label. `scopeMatchesWorkflow` gates board derivation in `board.tsx`; a
  mismatch shows an explicit diagnostic instead of a board.
- **Default scope selection is stabilized against SSE reordering.**
  `deriveWorkflowScopes` sorts by `activeCount`, which shifts on every
  feature-list refetch. `pickStableDefaultScopeKey` freezes onto whichever
  scope is already selected as long as it still exists, only re-picking
  the busiest scope on first load or once the frozen scope disappears
  entirely.
- **Board movement is announced and focus is recovered.** `board-activity.ts`
  (`diffBoardMovements`/`describeBoardMovements`) diffs consecutive board
  snapshots for the same scope; `board.tsx` renders the summary in a
  `aria-live="polite"` region and, when the previously-focused card moved
  rather than left the board, restores focus to its new instance.
- **Terminal history stays fully reachable.** `OverviewModel.recentAll`
  carries the complete done/abandoned collection; `recent` is a capped
  preview (`RECENT_PREVIEW_LIMIT`). `OverviewStrip` adds a "show all"
  toggle so nothing older than the 8th entry becomes permanently
  inaccessible.
- **Async selection state no longer races itself.** `lib/latest-guard.ts`
  (`LatestGuard`) is a small "latest call wins" ticketing helper. The
  step inspector's full-output fetch is now keyed by `runId` and uses it
  to discard stale responses and separate loading/error/ready states
  (retry stays possible); `useRunLog` uses the same guard so switching
  runs resets to `EMPTY_LOG_CURSOR` synchronously and a superseded run's
  late-arriving pages can never merge into the new run's cursor.
- **The mobile inspector sheet reuses `ActionSheet`.** The previous
  hand-rolled `role="dialog"` div is gone; `StepInspector` gained a
  `hideHeader` prop so `ActionSheet` supplies title/close/focus-trap/
  Escape/backdrop semantics instead of a second, inconsistent
  implementation.
- **Graph fullscreen exit is always reachable**, and clears itself if a
  breakpoint change makes `allowFullscreen` false mid-session, rather than
  stranding the operator in an overlay with no way out. Inline (non-
  fullscreen) mobile graphs use `touch-action: pan-y` so normal page
  scrolling passes through; only the dedicated fullscreen surface captures
  full 2D touch panning (`touch-action: none`). Desktop pointer-captured
  drag-pan is unaffected either way.
- **Gate decisions in a sheet are non-dismissible while pending and close
  on success.** `useGateActions` centralizes all gate/answer command logic
  behind `onPendingChange`/`onSuccess` callbacks; `GateModal` uses it to
  disable `ActionSheet`'s Escape/backdrop close during a request and to
  close with a success toast once the server accepts a decision. The
  decision buttons (`GateActionButtons`) render in `ActionSheet`'s sticky
  footer instead of scrolling with the body; `GateActions` remains for
  callers that want one inline block (still built on the same hook).
- **`open=gate|recover` is consumed, `job=` is preserved.** Closing or
  succeeding a deep-linked gate/recovery sheet strips only the `open`
  query param (`replace: true`, no history entry) so reopening the feature
  view later never re-triggers the sheet, while the `job=` selection
  — a durable graph selection, not a one-shot trigger — is left alone.

## Second hardening pass: concurrent gates, the answer contract, workflow compatibility

A second review found three deployment-blocking issues in the surfaces
above:

- **Concurrent gate/question attention is no longer collapsed.**
  `engine.ts`'s `approve`/`requestChanges` resolve every `waiting_human`
  step in one call (`resolveGates` iterates `waitingHumanSteps`), and a
  fan-out workflow can have several parallel jobs waiting, or several
  interactive runs each sitting on their own question, at once.
  `gate-surfaces.ts` (`deriveGateSurfaces`) enumerates every waiting gate
  step (from `FeatureDetail.jobs`) and every asking run (from
  `activeRuns`, not just the singular preferred `activeRun`) instead of
  picking one. `useGateActions` exposes the full `surfaces`/`items` list
  plus a `selected`/`selectItem` navigator that freezes on the current
  selection until it disappears (mirroring `pickStableDefaultScopeKey`'s
  rule). `SurfaceNavigator` (`gate-actions.tsx`) renders tab chips only
  once `items.length > 1` — a single gate keeps the original zero-chrome
  layout — and the gate body discloses "resolves all N waiting gates:
  ..." whenever more than one gate is listed, since approve/request-
  changes always targets every one of them, never just the one on
  screen. An answer always targets the selected run's id alone.
  `GateModal` only closes once `onSuccess`'s `remaining` count reaches
  zero, so resolving one of several surfaces leaves the sheet open on
  whatever is left.
- **The interactive-answer response is no longer misread as feature
  detail.** `POST /v1/runs/:id/answer` returns `{result, run}` — never a
  `{feature, activeRun}` shape — but the client and store previously
  typed and treated it as a `CommandResponse` and fed it through
  `applyDetail`. `AnswerRunResponse` (`api/types.ts`) is the correct type;
  `ApiClient.answerRun` returns it; `DataSource.answerRun` (distinct from
  `command`) never calls `applyDetail` with it and instead forces a real
  `refetchFeatureDetail`/`refetchRuns`/`refreshFeatures` pass, while still
  arming the echo-suppression window so the answer's own SSE burst
  doesn't trigger a second, redundant refetch. `useAnswerRun` is the hook
  binding; `useGateActions.submitAnswer` uses it instead of `useCommand`.
- **A feature's runtime is never merged against an incompatible current
  workflow.** `GET /v1/projects/workflow?dir=` serves one projection per
  project — the currently registered workflow — not one per historical
  name a feature's `jobs`/`steps` may have been recorded under.
  `workflowCompatible` (`graph/merge.ts`) compares `feature.workflow ??
  "default"` against the current projection's name; on a mismatch
  `feature-view.tsx` renders an explicit diagnostic naming both workflows
  and passes `null` to `WorkflowGraph`, `StepInspector`, and
  `resolveInspectorStepId` instead of the incompatible projection. The
  existing same-name-but-`stale` warning (a workflow edited, not renamed)
  is unchanged and still renders once the compatibility check passes.

## What did not change

The REST/SSE data layer (`api/client.ts`, `api/store.ts`, `api/hooks.ts`),
gate/recovery command semantics, findings/timeline endpoints, and the
daemon's HTTP API are untouched. `mergeGraph`, `layoutJobs`, and
`resolveInspectorStepId` (sole-step auto-selection) keep their existing
contracts and tests.
