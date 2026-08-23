## Purpose

The bundled OpenSpec plugin: a project-scoped panel that surfaces a
project's OpenSpec changes and task progress in the Control Room and can
start Conductor work for a change — both a useful tool and the reference
implementation of the plugin contract.

## ADDED Requirements

### Requirement: The OpenSpec panel lists the project's changes

The OpenSpec plugin SHALL read the owning project's OpenSpec data (via the
`openspec` CLI against the project directory) and present: active changes
with their task progress (done/total, from `tasks.md` checkboxes), and
archived changes. A project without an `openspec/` root SHALL yield an
explanatory empty state, not an error. The listing SHALL be refreshable
from the panel.

#### Scenario: Active changes with progress

- **WHEN** the panel loads for a project whose `openspec/changes/` holds
  changes with partially completed tasks
- **THEN** each change appears with its name and task progress, and
  archived changes are listed separately

#### Scenario: Project without OpenSpec

- **WHEN** the panel loads for a project directory lacking an `openspec/`
  root
- **THEN** the panel shows an empty state explaining OpenSpec is not
  initialised, and no error is raised

### Requirement: Work can be started from the panel

The panel SHALL offer a start-work action for a change. Invoking it SHALL
create a Conductor feature through the daemon's existing public
feature-creation API (title derived from the change name and description
derived from the proposal), then navigate the Control Room to the created
feature via the host bridge. Failures SHALL surface the API error
envelope's message in the panel.

#### Scenario: Start work creates a feature and navigates

- **WHEN** the user triggers start-work for change `retry-policy`
- **THEN** a feature is created via the public API with the change's
  context, and the Control Room navigates to the new feature

#### Scenario: API failure is shown inline

- **WHEN** the feature-creation call fails
- **THEN** the panel shows the error message from the response envelope and
  no navigation occurs

### Requirement: The plugin ships in-repo and uses only the public contract

The OpenSpec plugin SHALL live in the Conductor repository as a standard
plugin directory (manifest, backend, static UI) installable by copying or
linking into a project's `.conductor/plugins/`. It SHALL use only the
documented plugin contract: environment variables from the supervisor, the
proxied route namespace, the public HTTP API, and the panel bridge —
serving as the reference implementation.

#### Scenario: Installed like any third-party plugin

- **WHEN** the shipped plugin directory is linked into a project's
  `.conductor/plugins/openspec/`
- **THEN** the daemon discovers and runs it with no special-casing relative
  to a user-authored plugin
