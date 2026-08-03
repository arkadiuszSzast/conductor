## ADDED Requirements

### Requirement: opencode is an adapter, not the host
The opencode integration SHALL implement the configured runner contract and
SHALL NOT own the workflow interpreter, store, reconciler or dashboard. Its
plugin surface SHALL register only the tools and session transport needed to
communicate with the standalone daemon.

#### Scenario: Plugin instance starts
- **WHEN** opencode loads the Conductor plugin for a project
- **THEN** the adapter registers the project and its session capability with
  the daemon and exposes Conductor tools, without opening its own workflow DB
  or starting a reconciler

#### Scenario: Multiple opencode projects share the daemon
- **WHEN** multiple opencode project instances register concurrently
- **THEN** each runner request carries its project directory and sessions are
  created in the correct project/worktree, independent of registration order

### Requirement: Agent outcomes report through the daemon
An agent step SHALL conclude only when the daemon accepts an explicit report
containing the issued run ID and either an outcome or mapped verdict. Runner
session idle state SHALL NOT be interpreted as successful completion.

#### Scenario: Agent session becomes idle without reporting
- **WHEN** an agent session becomes idle before posting a report
- **THEN** the run remains active and the reconciler applies idle-nudge/reap
  policy; it does not advance the workflow

#### Scenario: Late duplicate report
- **WHEN** an already-concluded run reports again
- **THEN** the daemon rejects the duplicate idempotently and leaves workflow
  state unchanged

### Requirement: Runtime-agnostic CLI reporting exists
The `conductor report` command SHALL post an outcome/verdict to the daemon API
using the run ID supplied to the agent. This mechanism SHALL require no
opencode-specific API and SHALL be usable by future runners and shell-driven
agents.

#### Scenario: Non-opencode agent reports completion
- **WHEN** an agent launched by another runtime invokes `conductor report
  <run-id> --outcome succeeded --notes <path-or-text>`
- **THEN** the daemon records the report and advances the same workflow model
  used by opencode agents
