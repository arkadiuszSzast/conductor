## Purpose

The `conductor daemon` process entrypoint: run the daemon from a
configuration file with explicit (never defaulted) settings, an HTTP
control surface, and signal-driven graceful shutdown — the bridge between
the `Daemon` lifecycle and a real process.

## ADDED Requirements

### Requirement: The daemon runs as a process from a configuration file

`conductor daemon --config <path>` SHALL read a YAML configuration file,
instantiate the daemon and its HTTP API, bind the listener on the
configured host/port, and keep the process alive until a termination
signal or a fatal startup error. The configuration file is the single
source of truth for the daemon's settings; there SHALL be no default
configuration path, no settings inferred from the current directory, a
home directory, or the package location, and no per-field flag overrides.

#### Scenario: Daemon starts from a valid config
- **WHEN** an operator runs `conductor daemon --config <path>` with a
  config that declares a database path, at least one project directory, a
  bind host/port and an auth mode
- **THEN** the daemon migrates the database, registers the projects,
  binds the API listener, and reports ready (`/v1/readyz` → 200), with
  structured JSON log lines on stdout

#### Scenario: Missing config is a usage error
- **WHEN** an operator runs `conductor daemon` without `--config` (and
  without `--init-config`)
- **THEN** the command exits with code 2 and prints an error explaining
  that a configuration file is required, showing the expected shape

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
with a readable error when wrong.

#### Scenario: Full configuration is honoured
- **WHEN** a config declares a database path, projects, a bind, a bearer
  token, a heartbeat interval, an actions local path and a UI directory
- **THEN** the daemon uses exactly those values (health reports the
  configured database and heartbeat, the API requires the bearer token,
  static files are served from the UI directory)

### Requirement: Authentication is explicit with a visible choice

The daemon config SHALL require an explicit `auth` mode. `auth.mode:
"none"` SHALL log an explicit warning that the API is unauthenticated
(only liveness/readiness probes are ever open). `auth.mode: "bearer"`
SHALL require a non-empty `token`; without one the config SHALL be
rejected.

#### Scenario: Explicit no-auth logs a warning
- **WHEN** a config sets `auth.mode: "none"`
- **THEN** the daemon starts but emits a structured warning that the API
  has no authentication, and the operator can see it in the logs

#### Scenario: Bearer auth without a token is rejected
- **WHEN** a config sets `auth.mode: "bearer"` with a missing or empty
  token
- **THEN** startup fails with a validation error naming the token field

### Requirement: The daemon shuts down gracefully on signals

On SIGINT or SIGTERM the daemon process SHALL stop accepting new work,
finish persistence already in progress, close the HTTP listener and
SQLite cleanly, and exit 0. A second signal SHALL be ignored or treated
as a hard exit; active runs SHALL remain recoverable on restart.

#### Scenario: SIGINT produces a clean stop
- **WHEN** a running daemon receives SIGINT
- **THEN** it drains in-flight work, closes the listener and the database,
  logs a stopped entry, and exits with code 0

### Requirement: The daemon scaffolds an example configuration

`conductor daemon --init-config <path>` SHALL write an example daemon
configuration (documented inline) and exit 0 without starting the daemon.
It SHALL refuse to overwrite an existing file unless `--force` is given,
matching the `conductor init` convention.

#### Scenario: Init-config writes an example
- **WHEN** an operator runs `conductor daemon --init-config <path>`
- **THEN** an example YAML config is written to `<path>` explaining each
  field, and the command exits 0

#### Scenario: Init-config honours --force
- **WHEN** an operator runs `conductor daemon --init-config <path>` where
  `<path>` already exists, without `--force`
- **THEN** the command exits non-zero with an error saying the file
  exists; with `--force` it overwrites and exits 0
