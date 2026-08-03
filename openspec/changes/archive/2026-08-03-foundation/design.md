# Design — foundation

## Decisions

- Bun/TypeScript monorepo using native Bun workspaces; no monorepo orchestrator
  until package graph/build cost justifies one.
- Root TypeScript strict mode with `noUncheckedIndexedAccess` and explicit
  package boundaries.
- GitHub Actions uses Bun latest + Node 24 and a frozen lockfile; root scripts
  are the local/CI contract.
- OpenSpec `spec-driven` schema; opencode skills committed so contributors and
  agents use the same proposal/apply/archive workflow.
- Private GitHub repository initially, intentionally publishable later without
  removing host-specific secrets because none are committed.

## Alternatives considered

- pnpm/Turborepo: capable but unnecessary at current scale and increases the
  bootstrap surface; Bun already provides runtime, package manager and tests.
- External issue tracker as canonical backlog: deferred; OpenSpec keeps intent,
  behavior, design and tasks beside code and is directly consumable by agents.

## Verification

A clean install followed by typecheck, test, lint, build and `openspec validate
--all` is the foundation gate. Git status/diff and a targeted secret scan are
reviewed before the initial commit/push.
