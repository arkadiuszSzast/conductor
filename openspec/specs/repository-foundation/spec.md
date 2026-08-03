# repository-foundation Specification

## Purpose
TBD - created by archiving change foundation. Update Purpose after archive.
## Requirements
### Requirement: The repository is reproducible and quality-gated
A clean checkout SHALL install with the committed Bun lockfile and SHALL expose
root commands for typecheck, tests, lint and build. The same commands SHALL run
on every pull request and push to main.

#### Scenario: Clean CI checkout
- **WHEN** CI checks out the repository and runs `bun install --frozen-lockfile`
- **THEN** dependency resolution succeeds without modifying the lockfile and
  all four quality commands pass

### Requirement: Package boundaries are visible from the start
The monorepo SHALL reserve distinct workspaces for pure core, daemon/server,
opencode runner adapter and CLI, plus future app/docs locations. Dependency
direction SHALL be core ← server ← adapters/CLI; core SHALL not import I/O
packages.

#### Scenario: Workspace smoke test
- **WHEN** the root test suite imports each initial package
- **THEN** Bun resolves all workspaces and each package identifies its intended
  boundary

### Requirement: Planning is repository-native
The repository SHALL use OpenSpec as the source of truth for change proposals,
behavior specs, design and implementation task tracking. Product context,
confirmed decisions and category-prefixed task rules SHALL be available to
every planning operation.

#### Scenario: A contributor lists the backlog
- **WHEN** a contributor runs `openspec list`
- **THEN** active workstreams are listed from version-controlled change
  artifacts without relying on chat history or an external private board

### Requirement: Open-source project contracts exist
The repository SHALL carry MIT license, project/roadmap overview, contribution
process, security reporting policy and AI-agent working rules before production
code is extracted.

#### Scenario: New contributor arrives cold
- **WHEN** a contributor reads README and CONTRIBUTING
- **THEN** they can identify the product, status, package layout, commands,
  OpenSpec flow, quality expectations and security reporting path

