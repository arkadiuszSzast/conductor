## Purpose

Defines the Control Room's right-side panel rail and the iframe host
through which plugin UIs render: which tabs appear when, how the panel is
embedded, and the versioned message bridge between host and plugin.

## Requirements

### Requirement: The Control Room has a right-side panel rail fed by the plugin listing

The web UI SHALL render a collapsible right-side panel rail. The rail
SHALL show one tab per plugin visible in the current scope, using the
panel title and icon from the plugin listing. Visibility follows scope:
global plugins are always candidates; project plugins appear only when the
UI's active scope is their owning project. When no plugins are visible the
rail SHALL be absent entirely (no empty chrome). The selected tab and the
rail's open/collapsed state SHALL persist across reloads.

#### Scenario: Project plugin tab appears only in its project

- **WHEN** the active board scope is project P and P has the `openspec`
  project plugin
- **THEN** the rail shows an OpenSpec tab; switching scope to a project
  without the plugin removes the tab

#### Scenario: No plugins, no rail

- **WHEN** the plugin listing for the current scope is empty or the
  subsystem is disabled
- **THEN** no rail chrome is rendered and the board occupies the full width

#### Scenario: Rail state survives reload

- **WHEN** the user opens the OpenSpec tab and reloads the page
- **THEN** the rail is open on the same tab

### Requirement: Plugin panels render in a sandboxed same-origin iframe

Opening a plugin tab SHALL render the plugin's UI in an iframe whose source
is the plugin's proxied UI route (`/v1/plugins/<id>/ui/`), same-origin with
the SPA. The iframe SHALL carry a sandbox attribute permitting scripts and
same-origin requests but not top-level navigation. Panel load failures
(plugin `error` state, HTTP failure) SHALL render an inline error state in
the panel with the plugin's diagnostic, not a broken frame.

#### Scenario: Panel loads the plugin UI

- **WHEN** the user opens an enabled plugin's tab
- **THEN** an iframe loads the plugin's UI route and the plugin's interface
  renders inside the panel

#### Scenario: Broken plugin shows a diagnostic panel

- **WHEN** the plugin's state is `error`
- **THEN** the panel shows the failure diagnostic and a retry affordance
  instead of an iframe

### Requirement: Host and panel communicate over a versioned postMessage bridge

The host SHALL implement a `postMessage` bridge with an explicit protocol
version negotiated at panel startup. Through the bridge the host SHALL
provide the panel with context: active project, active workflow/feature
selection, and theme; and SHALL push context-change events while the panel
is open. The panel MAY request host actions: navigate to a Control Room
route (feature, run) and refresh the plugin listing. Messages with an
unknown version or malformed shape SHALL be ignored by both sides. The
bridge SHALL NOT transport the API token; panel-originated data access
goes through the plugin's own proxied backend routes.

#### Scenario: Panel receives context on startup

- **WHEN** a panel initialises and completes the version handshake
- **THEN** it receives the current project, selection, and theme

#### Scenario: Scope change is pushed to the open panel

- **WHEN** the user switches the active project while a global plugin's
  panel is open
- **THEN** the panel receives a context-change message with the new project

#### Scenario: Panel navigates the host

- **WHEN** the panel sends a navigate request for a feature id
- **THEN** the Control Room navigates to that feature's view and the panel
  stays open

#### Scenario: Token never crosses the bridge

- **WHEN** a panel requests context
- **THEN** no message from the host contains the bearer token
