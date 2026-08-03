# Contributing to Conductor

Thanks for helping build the CI for agents. This project is public from day
one and holds itself to a high bar — no shortcuts, platform-grade quality.

## Getting started

1. Install [Bun](https://bun.sh) ≥ 1.0 and Node ≥ 24.
2. `bun install`
3. `bun run typecheck && bun test`

## How work flows

Planning and the backlog are managed with [OpenSpec](https://openspec.dev):

- Every workstream is a change in `openspec/changes/<name>/` with
  `proposal.md`, `specs/`, `design.md` and `tasks.md`.
- Propose a change before starting non-trivial work
  (`/opsx-propose` in this repo, or `openspec change` on the CLI).
- When a change is implemented and its tasks are checked off, archive it with
  `/opsx-archive` — archiving folds the change's specs into the living
  `openspec/specs/`.

Read `openspec/config.yaml` for the full context, confirmed decisions and the
task-prefix rules (`[core]`, `[server]`, `[runner]`, `[cli]`, `[db]`, `[web]`,
`[test]`, `[docs]`, `[review]`, `[fix]`).

## What to keep in mind

- **Extraction over rewrite.** The engine/store/dashboard of
  `opencode-conductor` are the seed; prefer generalising existing code over
  reimplementing it, and keep its tests and battle-scarred behaviours alive.
- **Dogfooding is the north star.** gloam-idle runs on this from extraction
  day. When in doubt, the filter is: does gloam need this this week?
- **The GHA mental model is the UX benchmark.** If someone who knows GitHub
  Actions can't read a workflow file cold, the format is wrong.
- **No host-specific paths.** No hardcoded model gateway, no assumptions about
  one user's home directory.

## Pull requests

- Small fixes can be submitted directly. Larger changes should start as an
  OpenSpec change proposal so intent is aligned before implementation.
- CI runs typecheck, tests, lint and build on every PR — make sure it is green.
- AI-generated code is welcome as long as it is tested and verified; mention
  the coding agent and model used in the PR description.
