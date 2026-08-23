## Purpose

Defines how Conductor discovers, validates, and scopes user-created plugins
from global and per-project directories, so optional tools can extend the
Control Room without becoming part of core.

## ADDED Requirements

### Requirement: Plugins are declared by a manifest in a conventional directory

A plugin SHALL be a directory containing a `plugin.yaml` manifest. The
daemon SHALL discover plugins from two scopes: global
(`<config-dir>/plugins/<id>/plugin.yaml`, where `<config-dir>` is the
daemon's platform config directory) and project
(`<project-root>/.conductor/plugins/<id>/plugin.yaml` for each registered
project). The manifest SHALL declare at minimum: `plugin` (the id,
kebab-case, matching the directory name), `version` (manifest schema
version, integer), and `panel` (`title`, optional `icon`). It MAY declare
`backend` (`run`: argv array for the backend process) and `capabilities`
(declared intent, informational in v1).

#### Scenario: Valid global plugin is discovered

- **WHEN** the daemon starts and `<config-dir>/plugins/openspec/plugin.yaml`
  is a valid manifest with id `openspec`
- **THEN** the plugin appears in the daemon's plugin listing with scope
  `global`

#### Scenario: Valid project plugin is discovered

- **WHEN** a registered project contains
  `.conductor/plugins/openspec/plugin.yaml` with a valid manifest
- **THEN** the plugin appears in the listing with scope `project` and is
  associated with that project only

#### Scenario: Manifest id must match its directory

- **WHEN** a manifest at `plugins/foo/plugin.yaml` declares `plugin: bar`
- **THEN** the plugin is not registered and a diagnostic naming the path
  and the mismatch is recorded

### Requirement: Invalid manifests produce diagnostics, not crashes

The daemon SHALL NOT fail startup because of a broken plugin. A manifest
that is unreadable, oversized, syntactically invalid, missing required
fields, or of an unsupported schema version SHALL be skipped and recorded
as a diagnostic retrievable through the plugin listing. Symlinked plugin
directories or manifests SHALL be rejected with a diagnostic.

#### Scenario: Broken manifest does not stop the daemon

- **WHEN** one plugin directory contains malformed YAML and another
  contains a valid manifest
- **THEN** the daemon starts, the valid plugin is registered, and the
  broken one is reported as a diagnostic with its path and reason

#### Scenario: Unsupported schema version is skipped

- **WHEN** a manifest declares a `version` greater than the daemon supports
- **THEN** the plugin is skipped with a diagnostic stating the supported
  version range

### Requirement: Project scope shadows global scope by id

When a project plugin and a global plugin share an id, the project plugin
SHALL take precedence within that project's scope, and the shadowing SHALL
be surfaced as a diagnostic (informational). Two plugins with the same id
in the same scope SHALL both be reported as a conflict diagnostic and
neither registered for that scope.

#### Scenario: Project plugin wins over global

- **WHEN** both `<config-dir>/plugins/openspec/` and a project's
  `.conductor/plugins/openspec/` contain valid manifests
- **THEN** requests scoped to that project resolve to the project plugin,
  other projects resolve to the global plugin, and the listing marks the
  shadowing

### Requirement: Plugins can be disabled through daemon configuration

The daemon configuration SHALL accept a `plugins` section allowing:
disabling the whole subsystem (`enabled: false`), disabling individual
plugins by id (`disabled: [<id>...]`), and additional global search paths
(`paths: [<absolute path>...]`). When the subsystem is disabled the daemon
SHALL neither scan for plugins nor start plugin processes, and the plugin
listing SHALL report the subsystem as disabled. Relative paths in `paths`
SHALL be rejected at config validation time.

#### Scenario: Disabled plugin is listed but inert

- **WHEN** `plugins.disabled` contains `openspec` and a valid `openspec`
  plugin exists
- **THEN** the plugin appears in the listing as `disabled`, its backend is
  not started, and its routes are not mounted

#### Scenario: Subsystem off means no scanning

- **WHEN** `plugins.enabled` is `false`
- **THEN** no plugin directories are read and no plugin routes exist

### Requirement: The plugin listing is available over the HTTP API

The daemon SHALL expose an authenticated listing endpoint returning, for
each discovered plugin: id, scope (`global` or `project`), owning project
(for project scope), panel metadata (title, icon), state (`running`,
`stopped`, `disabled`, `error`), and diagnostics. The listing SHALL accept
a project filter so a UI can request only the plugins visible for a given
project (global plugins plus that project's plugins, with shadowing
applied).

#### Scenario: Listing filtered by project

- **WHEN** a client requests the plugin listing filtered to project P
- **THEN** the response contains all global plugins not shadowed for P plus
  P's project plugins, and no plugins belonging to other projects
