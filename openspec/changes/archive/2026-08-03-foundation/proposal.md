## Why

Conductor starts as an open-source, platform-grade project rather than a local
prototype. Before extracting production code it needs a reproducible monorepo,
quality gate, contribution/security contract and a durable spec-driven backlog.

## What Changes

- Initialize private GitHub repository `arkadiuszSzast/conductor` (public when
  ready) under MIT.
- Establish Bun/TypeScript workspaces and the confirmed package boundaries.
- Install OpenSpec 1.7.0 integration for opencode and encode product context,
  decisions, guardrails and task taxonomy.
- Add CI for install, typecheck, tests, lint and build.
- Seed the phase-1 backlog as complete OpenSpec changes.
