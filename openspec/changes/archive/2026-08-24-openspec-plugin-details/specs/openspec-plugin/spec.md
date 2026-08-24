## ADDED Requirements

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
