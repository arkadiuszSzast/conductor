## MODIFIED Requirements

### Requirement: The configuration file maps to the daemon surface

The daemon config SHALL express: the SQLite `databasePath`, the project
directories to register, the API `bind` host and port, the `auth` mode
(`none` or bearer token), an optional `ui.staticDir`, the
`heartbeatIntervalMs`, optional engine tuning, optional local action
registry paths, and an optional `plugins` section (subsystem
enable/disable, per-plugin disable list, additional global plugin search
paths). Every field SHALL be validated at startup and reported with a
readable error when wrong.

#### Scenario: Full configuration is honoured
- **WHEN** a config declares a database path, projects, a bind, a bearer
  token, a heartbeat interval, an actions local path and a UI directory
- **THEN** the daemon uses exactly those values (health reports the
  configured database and heartbeat, the API requires the bearer token,
  static files are served from the UI directory)

#### Scenario: Plugins section is validated like the rest
- **WHEN** a config declares a `plugins` section with a relative search
  path or a non-boolean `enabled`
- **THEN** startup fails with a validation error naming the offending
  field

#### Scenario: Omitted plugins section defaults to enabled with no extras
- **WHEN** a config omits the `plugins` section entirely
- **THEN** the daemon starts with the plugin subsystem enabled, no
  additional search paths, and no plugins disabled
