## Context

Today `deriveWorkflowScopes(items)` (apps/web/src/board/workflow-board.ts)
builds scopes purely from non-terminal features; `Board` publishes
`publishActiveScope({ project: scope?.projectDir ?? null, ... })`, so a
quiet daemon publishes `null`. The plugin rail then needs its own
sole-project fallback (`use-plugin-rail.ts`, added by the plugin-system
follow-up) — a symptom patch this change removes. All required data is
already client-visible: `/v1/health` lists registered projects with
state, `DataSource.getWorkflow(projectDir)` gives each project's
workflow projection (name or unregistered/invalid state).

## Goals / Non-Goals

**Goals:** no null active scope while projects exist; feature-less and
broken-workflow projects reachable; sole scope auto-selected; keep the
freeze-against-SSE-reordering behaviour for multi-scope selection.

**Non-Goals:** server changes; new persistence (URL `?scope=` remains
the only cross-reload memory); inventing scopes for workflows nobody
references.

## Decisions

- **D1: scopes = registry ⋈ workflow, features decorate.**
  `deriveWorkflowScopes` gains the health projects and per-project
  workflow name as inputs: every registered project yields a base scope
  keyed `project+workflowName` (workflow name from the projection;
  `"default"` sentinel label when unregistered/invalid, matching the
  existing `item.workflow ?? "default"` convention). Feature-derived
  scopes merge in: counts for matching keys, extra scopes for features
  on other workflow names. Sorting unchanged (activeCount, then label);
  zero-feature scopes naturally sort last within their label order.
  Rejected: fetching every project's workflow lazily on tab click —
  scopes must exist before selection, and project counts are small.
- **D2: selection rule unchanged, base set bigger.** The existing
  URL-requested → frozen-memory → busiest-default cascade stays; with
  the registry-derived base set it can no longer resolve to nothing
  while projects exist. `ScopeTabs` drops its `scopes.length <= 1 →
  null` short-circuit only in the sense that a single scope still
  renders no tabs (nothing to switch) — selection just always exists.
- **D3: rail fallback removed, tests repointed.** `use-plugin-rail.ts`
  loses `useHealth`/`soleProject`; the two fallback tests become board-
  level tests asserting the published scope on a quiet single-project
  daemon (the fallback behaviour moves from rail to board, the user-
  visible outcome is identical).
- **D4: workflow load per scope stays lazy.** The board already fetches
  the selected scope's workflow (`useWorkflow(scope.projectDir)`);
  deriving scope *names* needs the projection too, so the board ensures
  workflow resources for registered projects (small N) — reusing the
  existing store resource with its invalidation, no new endpoint.

## Risks / Trade-offs

- [N workflow fetches on board mount for N projects] → bounded by
  registered-project count (single digits in practice), cached in the
  store, invalidated by the existing SSE flow.
- [Scope key churn if a project's workflow is renamed] → same behaviour
  as today for feature scopes; the URL `?scope=` simply stops matching
  and the default cascade re-picks.

## Migration Plan

Pure web change, additive; revert = restore feature-derived scopes and
the rail fallback.

## Open Questions

None.
