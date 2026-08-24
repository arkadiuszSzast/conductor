## ADDED Requirements

### Requirement: The shell hosts the plugin panel rail

The Control Room shell SHALL reserve a right-side region for the plugin
panel rail (specified in the `plugin-panels` capability) alongside the
board and feature views, on both desktop and narrow viewports (where the
rail collapses into an overlay). The rail SHALL NOT obscure or displace
the human-gate flow: gate decisions remain reachable within two clicks
while a panel is open.

#### Scenario: Panel open beside the board

- **WHEN** a plugin panel is open on a desktop viewport
- **THEN** the board remains usable beside it and gate actions remain
  reachable within two clicks

#### Scenario: Narrow viewport uses an overlay

- **WHEN** a plugin panel is opened on a narrow viewport
- **THEN** the panel presents as an overlay/sheet and can be dismissed to
  return to the board
