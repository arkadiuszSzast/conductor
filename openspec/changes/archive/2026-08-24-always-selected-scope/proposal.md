## Why

The board's workflow scope (the project+workflow pairing everything else
keys off) is derived from the **feature list**: a scope tab exists only
when a project has at least one non-terminal feature. On a quiet daemon
the active scope is therefore `null` — the operator sees "no active
features" and nothing else. This was found dogfooding the plugin system
on a phone: the project-scoped OpenSpec panel was invisible with no way
to reach it, precisely in the moment it is most useful (before starting
work). The `plugin-system` follow-up patched the symptom inside the
plugin rail (fall back to the sole registered project), but the null
scope remains and bites anything scope-dependent: you cannot even switch
the board to a registered project that has no features yet.

## What Changes

- **Scope derives from the project registry, not the feature list.** The
  board builds its scope set from the daemon's registered projects
  (health) joined with each project's workflow projection; features only
  *decorate* scopes with counts. A registered project with zero features
  still yields a scope tab (empty board), and a scope is **always
  selected** when at least one registers — a single project is selected
  by default with no interaction.
- **The null active scope disappears from the UI model.** The active
  scope may be "none" only when the daemon has no registered projects at
  all. `publishActiveScope` and everything downstream (plugin rail,
  start-work context, bridge context) always see the selected project.
- **The plugin rail's sole-project fallback is removed** — superseded by
  the board always publishing a scope. (Rail behaviour with multiple
  projects is unchanged: it follows the selected scope.)
- Scope tabs render also for feature-less projects, labelled with the
  project and its configured workflow name; projects whose workflow is
  unregistered/invalid still surface as a scope with the existing
  diagnostics rendering instead of being unreachable.

Not in scope: server/API changes (all data already exists on
`/v1/health` and `/v1/projects/workflow`), multi-workflow-per-project
scope invention (scopes for workflows other than the configured one
still come only from features referencing them), persistence of the
selected scope across reloads beyond what the URL already provides.

## Capabilities

### Modified Capabilities

- `web-ui`: the board's scope model — registry-derived scopes, default
  selection, empty-board rendering for feature-less scopes, and the
  plugin rail following the always-present scope (supersedes the
  sole-project fallback introduced by `plugin-system`).

## Impact

- `apps/web/src/board/workflow-board.ts` (scope derivation), `board.tsx`
  (selection/publishing), `apps/web/src/plugins/use-plugin-rail.ts`
  (remove fallback), related tests.
- No server, CLI, core, or store changes; no migration.
- `openspec/specs/web-ui/spec.md` gains the always-selected-scope
  requirement on archive.
