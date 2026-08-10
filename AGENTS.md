# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this repo is

Conductor — a self-hosted, runtime-agnostic "CI for agents". It drives AI
coding agents through configurable workflows (workflow-as-data, GHA-style),
with a durable SQLite state machine, a reconciler, human gates, a findings
lifecycle, and a task board. This is a **greenfield** project with no
existing users or deployments: `opencode-conductor` served as an early
reference for battle-tested behaviours (confirmation-of-effect, nudge/reap,
findings lifecycle), but its formats and code carry no compatibility
obligations — any part may be replaced outright when the target design is
better served.

## Commands

```sh
bun install          # install dependencies (Bun workspaces)
bun run typecheck    # tsc --noEmit across the workspace
bun test             # run all tests
bun run lint         # lint (once configured)
bun run build        # build workspace packages
```

Run from the repository root. Individual packages may define their own scripts
under `packages/*/package.json`.

## Repository layout

```
packages/
  core/              pure engine: interpreter, workflow model, validation, templates
  server/            daemon: HTTP API, reconciler, triggers, scheduler hooks
  runner-opencode/   opencode runner adapter
  cli/               the `conductor` CLI
apps/
  web/               task board + exploration view (later phase)
openspec/            specs and change proposals (the backlog)
docs/                architecture notes, runner protocol, workflow format reference
```

## How work is planned and tracked

- The backlog is managed with **OpenSpec**: every workstream is a change in
  `openspec/changes/<name>/` (`proposal.md`, `specs/`, `design.md`,
  `tasks.md`), archived into `openspec/specs/` when done.
- Start a change with `/opsx-propose "<idea>"`; implement it task by task in
  `tasks.md`; archive with `/opsx-archive`.
- Read `openspec/config.yaml` — it holds the product context, confirmed
  decisions, and the task-prefix rules.
- Task lines use category prefixes: `[core]`, `[server]`, `[runner]`, `[cli]`,
  `[db]`, `[web]`, `[test]`, `[docs]`, `[review]`, `[fix]` (combine as
  needed). Use the prefix that matches the package/concern a task touches.

## Hard rules

- **One workflow format.** `conductor.yaml` (the graph IR in
  `@conductor/core`, specified by the `workflow-format` change) is the only
  workflow format. The seed's `.opencode/conductor.json` pipeline format is
  dead — never reintroduce it, never build converters or compatibility
  layers for it.
- **Greenfield, no legacy obligations.** There are no users, no deployed
  databases, no in-flight features to preserve. Prefer deleting and
  replacing over adapting. Keep behaviours (confirmation-of-effect,
  nudge/reap, findings lifecycle) because they are good, not because they
  are old.
- **Interpreter pure, engine owns I/O.** Routing decisions live in a pure
  function; all side effects live in the engine/reconciler. Preserve this
  split.
- **SQLite is the source of truth.** Sessions are disposable executors.
- **No host-specific paths, no hardcoded model gateway.** gloam-idle is one
  configuration, not the shape.
- **Dogfooding north star.** The system should be able to drive its own
  changes once the daemon runs.
- Do not add comments unless they explain a non-obvious decision; match the
  existing style of the file you touch.
