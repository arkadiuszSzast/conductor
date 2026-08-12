## MODIFIED Requirements

### Requirement: The daemon runs as a process from a configuration file

`conductor daemon` SHALL read a YAML configuration file, instantiate the
daemon and its HTTP API, bind the listener on the configured host/port, and
keep the process alive until a termination signal or a fatal startup error.
The configuration file is the single source of truth for the daemon's
settings.

With `--config <path>` the named file is used and a missing or invalid file
is an error. Without `--config` the daemon SHALL use the platform config
path — `$XDG_CONFIG_HOME/conductor/daemon.yaml`, falling back to
`~/.config/conductor/daemon.yaml` — and when that file does not exist it
SHALL generate it with working defaults (database at
`$XDG_DATA_HOME/conductor/conductor.db` falling back to
`~/.local/share/conductor/conductor.db`, `createDatabaseDirectory: true`,
bind `127.0.0.1:4400`, `auth.mode: none`, no projects) and start from it,
logging the generated path. Defaults SHALL derive only from platform
conventions (XDG environment variables, the home directory) — never from
the package location or the current directory.

#### Scenario: Daemon starts from a valid config
- **WHEN** an operator runs `conductor daemon --config <path>` with a
  config that declares a database path, a bind host/port and an auth mode
- **THEN** the daemon migrates the database, registers any configured
  projects, binds the API listener, and reports ready (`/v1/readyz` → 200),
  with structured JSON log lines on stdout

#### Scenario: Zero-flag start generates the default config
- **WHEN** an operator runs `conductor daemon` with no flags and no file at
  the platform config path
- **THEN** the daemon writes a default config there (loopback bind, XDG
  data-dir database, `auth.mode: none`, empty projects), logs the generated
  path, and starts from it

#### Scenario: Zero-flag start reuses an existing default config
- **WHEN** an operator runs `conductor daemon` with no flags and the
  platform config file already exists
- **THEN** the daemon starts from that file without modifying it

#### Scenario: Explicit config missing is still an error
- **WHEN** an operator runs `conductor daemon --config <path>` and the file
  does not exist
- **THEN** the command exits with a usage error naming the path — an
  explicit path is never auto-generated

#### Scenario: Invalid config is a startup failure
- **WHEN** a config file is malformed or fails validation (unknown auth
  mode, non-numeric port, missing required fields)
- **THEN** the daemon does not start and the command exits non-zero with
  the specific validation error

### Requirement: The configuration file maps to the daemon surface

The daemon config SHALL express: the SQLite `databasePath`, the project
directories to register, the API `bind` host and port, the `auth` mode
(`none` or bearer token), an optional `ui.staticDir`, the
`heartbeatIntervalMs`, optional engine tuning and optional local action
registry paths. Every field SHALL be validated at startup and reported
with a readable error when wrong. The `projects` list MAY be empty — a
daemon with no projects starts and serves its API so projects can be
registered later.

#### Scenario: Full configuration is honoured
- **WHEN** a config declares a database path, projects, a bind, a bearer
  token, a heartbeat interval, an actions local path and a UI directory
- **THEN** the daemon uses exactly those values (health reports the
  configured database and heartbeat, the API requires the bearer token,
  static files are served from the UI directory)

#### Scenario: Empty projects list is valid
- **WHEN** a config declares no projects
- **THEN** the daemon starts, serves its API and reports ready, with no
  projects registered

## ADDED Requirements

### Requirement: Projects register at runtime through the API

The daemon SHALL expose `POST /v1/projects` accepting a project directory;
the daemon validates and registers it exactly as it does at startup
(diagnostics on failure, availability on success) without a restart.
Registering an already-registered directory SHALL be idempotent and
succeed. The route SHALL be authenticated like every other command route.

#### Scenario: Live registration
- **WHEN** a client POSTs a directory containing a valid `conductor.yaml`
  to `/v1/projects`
- **THEN** the project becomes available for `conductor start` immediately
  and appears in `/v1/health` project reporting

#### Scenario: Invalid project is rejected with diagnostics
- **WHEN** a client POSTs a directory whose workflow is missing or invalid
- **THEN** the response carries the validation diagnostics and the daemon's
  registered set is unchanged

### Requirement: `conductor init` registers the project with the daemon

After scaffolding `conductor.yaml`, `conductor init` SHALL add the project
directory to the daemon config's `projects` list — creating the default
config (platform path, default values) when it does not exist — and, when
a daemon is reachable at the resolved connection, register the project live
through the API. Both operations SHALL be idempotent; an unreachable daemon
is reported as a hint (start/restart the daemon), not a failure.

#### Scenario: Init adds the project to the daemon config
- **WHEN** a user runs `conductor init` in a project directory
- **THEN** `conductor.yaml` is scaffolded and the directory appears exactly
  once in the daemon config's `projects` list, even across repeated runs

#### Scenario: Init registers live when the daemon runs
- **WHEN** a user runs `conductor init` while a daemon is reachable
- **THEN** the project is registered over the API and is immediately
  startable, with no daemon restart

#### Scenario: Init without a running daemon still succeeds
- **WHEN** a user runs `conductor init` with no daemon running
- **THEN** the scaffold and config update succeed and the output tells the
  user to start the daemon

### Requirement: The CLI connection falls back to the daemon config

When no explicit connection is given (`--url`, `CONDUCTOR_URL`,
`--config`/`CONDUCTOR_CONFIG` all absent), the CLI SHALL read the platform
daemon config and derive the connection from it: URL from `bind`
(`http://<host>:<port>`) and the bearer token when `auth.mode` is
`bearer`. Explicit sources SHALL keep precedence in today's order. When
the daemon config does not exist either, the existing usage error stands.

#### Scenario: Local zero-config connection
- **WHEN** a user runs `conductor status` with no connection flags or env
  on a machine where the platform daemon config exists
- **THEN** the CLI connects to the daemon at the config's bind address,
  using its bearer token when configured

#### Scenario: Explicit connection wins
- **WHEN** `CONDUCTOR_URL` is set or `--url` is passed
- **THEN** the daemon config is not consulted for the connection

#### Scenario: No config anywhere is still a usage error
- **WHEN** no connection source and no platform daemon config exist
- **THEN** the command fails with the usage error explaining every way to
  provide the address
