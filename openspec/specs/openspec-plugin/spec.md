## Purpose

The bundled OpenSpec plugin: a project-scoped panel that surfaces a
project's OpenSpec changes and task progress in the Control Room and can
start Conductor work for a change — both a useful tool and the reference
implementation of the plugin contract.

## Requirements

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

### Requirement: A change's details are readable from the panel

The plugin backend SHALL expose a detail endpoint for a single change
(active or archived) returning: the change name, the proposal's "Why"
and "What Changes" sections, the delta specs grouped by capability
(capability name plus each requirement heading with its body text), and
the task list as ordered entries with text and done flag. Artifacts the
change does not have SHALL be absent from the response, not errors. An
unknown change name SHALL yield a `404`; a change name that is not a
plain directory name SHALL be rejected without touching the filesystem.

#### Scenario: Full change detail

- **WHEN** the panel requests details for an active change with a
  proposal, delta specs, and tasks
- **THEN** the response carries the Why and What Changes texts, each
  capability's requirements with their bodies, and every task with its
  done state

#### Scenario: Sparse change detail

- **WHEN** the requested change has only a proposal (no specs, no
  tasks yet)
- **THEN** the response carries the proposal sections and omits the
  specs and tasks fields, with no error

#### Scenario: Unknown change

- **WHEN** the requested name matches no change directory (active or
  archived)
- **THEN** the backend answers 404

### Requirement: Clicking a change opens a detail modal with progressive disclosure

Clicking a change tile (anywhere except its start-work action) SHALL
open a modal overlay showing the change name, its task progress, and
the proposal's Why text visible immediately. What Changes,
Requirements (grouped by capability), and Tasks SHALL be present as
sections collapsed by default, expandable individually. The modal
SHALL offer the same start-work action as the tile for active changes
(hidden for archived ones) and SHALL close via close button, backdrop
click, and Escape. Markdown in displayed texts SHALL be rendered with a
minimal safe renderer (no raw HTML injection).

#### Scenario: Open, read, expand

- **WHEN** the user clicks an active change's tile
- **THEN** a modal opens with the Why text visible, and expanding
  Requirements reveals each capability's requirement headings and
  bodies

#### Scenario: Start work from the modal

- **WHEN** the user triggers Start work inside the modal
- **THEN** the same feature-creation flow runs as from the tile (and
  the Control Room navigates to the created feature)

#### Scenario: Archived change opens without start-work

- **WHEN** the user clicks an archived change
- **THEN** the modal opens with its details and no start-work action

#### Scenario: Dismissal

- **WHEN** the user presses Escape or clicks the backdrop or close
  button
- **THEN** the modal closes and the listing remains as it was
