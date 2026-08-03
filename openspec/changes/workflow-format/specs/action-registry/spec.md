## ADDED Requirements

### Requirement: Deterministic capabilities are local versioned actions
A workflow SHALL invoke deterministic functionality through `uses:
<action>@<major-version>`. In v1, actions resolve only from an explicitly
configured local registry. An action manifest SHALL declare identity, version,
typed inputs, typed outputs, required capabilities and execution entry point.

#### Scenario: Versioned action resolves
- **WHEN** a workflow uses `git/worktree@v1` and the local registry contains a
  compatible v1 manifest
- **THEN** validation binds the immutable action definition and execution
  records its resolved identity/version

#### Scenario: Missing action fails validation
- **WHEN** a workflow references an unavailable action/version
- **THEN** validation fails before the workflow starts and names the configured
  registry paths searched

### Requirement: Actions are isolated from engine internals
An action SHALL receive a documented context and typed inputs, emit declared
outputs/status, and SHALL NOT receive direct access to the interpreter or
SQLite store. Filesystem, process, network, git and credential access SHALL be
explicit capabilities governed by daemon policy.

#### Scenario: Undeclared capability is denied
- **WHEN** an action without network capability attempts network access through
  the action host
- **THEN** execution is denied and the run records a classified policy failure

#### Scenario: Polling action reports pending
- **WHEN** `github/await-checks@v1` observes unconcluded checks
- **THEN** it returns a durable pending result with next observation policy,
  without burning an attempt or accumulating active run rows

### Requirement: Built-in seed mechanics become shipped actions
The seed mechanics for worktree create/remove, git push, PR create/check/merge,
thread resolution and findings sync/check SHALL ship as local v1 actions with
behavioural parity and tests. The engine SHALL contain no action-name switch.

#### Scenario: Existing worktree idempotency is preserved
- **WHEN** `git/worktree@v1` retries after a worktree was created but before
  success was recorded
- **THEN** it identifies the existing checkout of the same branch and succeeds
  idempotently
