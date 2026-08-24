## ADDED Requirements

### Requirement: A workflow scope is always selected while any project is registered

The board SHALL derive its workflow scopes from the daemon's registered
projects joined with each project's workflow projection; the feature
list SHALL only contribute counts and additional scopes for features
whose workflow differs from the project's configured one. Whenever at
least one project is registered, exactly one scope SHALL be selected: a
sole scope is selected automatically with no interaction, and with
several scopes the previous freeze/default rules apply. The UI's active
scope SHALL be empty only when the daemon has no registered projects.

#### Scenario: Quiet daemon still has a selected scope

- **WHEN** the daemon has one registered project and no features at all
- **THEN** the board shows that project's scope as selected with an
  empty board (no features), and scope-dependent surfaces (plugin rail,
  start work) receive that project as the active scope

#### Scenario: Feature-less project is reachable

- **WHEN** the daemon has two registered projects and only one has
  features
- **THEN** both projects present scope tabs and the operator can switch
  to the feature-less project's scope

#### Scenario: Broken workflow still yields a scope

- **WHEN** a registered project's workflow is unregistered or invalid
- **THEN** the project still presents a scope tab and selecting it shows
  the existing workflow diagnostics rendering rather than the scope
  being absent

#### Scenario: No projects, no scope

- **WHEN** the daemon has no registered projects
- **THEN** no scope is selected and the board presents its empty state

## MODIFIED Requirements

### Requirement: The shell hosts the plugin panel rail

The Control Room shell SHALL reserve a right-side region for the plugin
panel rail (specified in the `plugin-panels` capability) alongside the
board and feature views, on both desktop and narrow viewports (where the
rail collapses into an overlay). The rail SHALL NOT obscure or displace
the human-gate flow: gate decisions remain reachable within two clicks
while a panel is open. The rail SHALL follow the board's always-selected
scope for project-plugin visibility; it SHALL NOT implement its own
project fallback.

#### Scenario: Panel open beside the board

- **WHEN** a plugin panel is open on a desktop viewport
- **THEN** the board remains usable beside it and gate actions remain
  reachable within two clicks

#### Scenario: Narrow viewport uses an overlay

- **WHEN** a plugin panel is opened on a narrow viewport
- **THEN** the panel presents as an overlay/sheet and can be dismissed to
  return to the board

#### Scenario: Project plugin visible on a quiet daemon

- **WHEN** the daemon has one registered project with a project plugin
  and no features exist
- **THEN** the rail shows the plugin's tab because the board's selected
  scope names that project
