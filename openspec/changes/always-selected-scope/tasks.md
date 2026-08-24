## 1. Scope model

- [x] 1.1 [web] Extend `deriveWorkflowScopes` to take registered
  projects + per-project workflow names and emit base scopes for every
  registered project (zero counts), merging feature-derived counts and
  extra feature-only workflow scopes; keep key/sort conventions
- [x] 1.2 [web] Board: source health projects, ensure workflow
  resources for registered projects, feed the extended derivation;
  publish the selected scope (never null while projects exist)
- [x] 1.3 [test] workflow-board tests: quiet daemon yields a selected
  base scope, feature-less project appears beside a busy one, broken
  workflow yields a scope with the "default" label, no projects yields
  no scopes, counts merge correctly onto base scopes

## 2. Rail cleanup

- [x] 2.1 [web] Remove the sole-project fallback from
  `use-plugin-rail.ts` (rail follows the published scope only)
- [x] 2.2 [test] Repoint the two fallback mounted tests to board-level
  behaviour: quiet single-project daemon publishes the scope and the
  project plugin tab appears; multi-project daemon with no features
  still selects a scope (busiest/default) rather than none

## 3. Verification

- [x] 3.1 [test] Full suite green (`bun run typecheck`, `bun run lint`,
  `bun test`, web mounted tests); manually verify on the dogfood daemon
  that a quiet project shows its scope and the OpenSpec panel
