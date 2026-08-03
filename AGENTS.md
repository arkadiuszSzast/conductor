# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this repo is

Conductor — a self-hosted, runtime-agnostic "CI for agents". It drives AI
coding agents through configurable workflows (workflow-as-data, GHA-style),
with a durable SQLite state machine, a reconciler, human gates, a findings
lifecycle, and a task board. The seed is `opencode-conductor`; this repo is
the extraction into a standalone service.

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

- **Extraction over rewrite.** `opencode-conductor` is the seed. Generalise
  its engine/store/dashboard; keep its tests and battle-scarred behaviours.
- **Interpreter pure, engine owns I/O.** Routing decisions live in a pure
  function; all side effects live in the engine/reconciler. Preserve this
  split.
- **SQLite is the source of truth.** Sessions are disposable executors. DB
  migrations are additive — in-flight conductor features must survive.
- **No host-specific paths, no hardcoded model gateway.** gloam-idle is one
  configuration, not the shape.
- **Dogfooding north star.** The system should be able to drive its own
  changes once the daemon runs.
- Do not add comments unless they explain a non-obvious decision; match the
  existing style of the file you touch.
