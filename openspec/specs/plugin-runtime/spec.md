## Purpose

Defines how the daemon runs plugin backend processes and exposes them to
clients: supervised child processes serving HTTP, reverse-proxied under the
daemon's API so plugin UIs and endpoints are same-origin with the SPA.

## Requirements

### Requirement: Plugin backends are supervised child processes serving HTTP

For each enabled plugin whose manifest declares a `backend`, the daemon
SHALL spawn the declared argv as a child process with the plugin directory
as its working directory. The daemon SHALL pass the child, via
environment variables: the TCP port it must listen on
(`CONDUCTOR_PLUGIN_PORT`, chosen by the daemon on loopback), the daemon's
own base URL (`CONDUCTOR_URL`), an API token (`CONDUCTOR_TOKEN`), and for
project-scoped plugins the project root (`CONDUCTOR_PROJECT_DIR`). The
runtime of the backend is not constrained: any executable that binds the
given port qualifies. A plugin without a `backend` SHALL be treated as
static-only and served from its directory's `ui/` subdirectory.

#### Scenario: Backend receives its contract via environment

- **WHEN** the daemon starts an enabled plugin with a `backend`
- **THEN** the child process is started with `CONDUCTOR_PLUGIN_PORT`,
  `CONDUCTOR_URL`, and `CONDUCTOR_TOKEN` set, and it becomes reachable
  through the daemon once it binds the port

#### Scenario: Static-only plugin needs no process

- **WHEN** an enabled plugin has no `backend` but has a `ui/` directory
- **THEN** no child process is spawned and the plugin's UI route serves the
  static files

### Requirement: Plugin routes are mounted under the daemon API

The daemon SHALL reverse-proxy authenticated requests matching
`/v1/plugins/<id>/…` to the plugin's backend (or static directory),
stripping the mount prefix so the backend sees root-relative paths. The
daemon's auth SHALL be enforced at the edge before proxying; the plugin
backend itself is reachable only via loopback. Because iframe navigations
and panel-originated fetches cannot attach an `Authorization` header, the
plugin namespace SHALL additionally accept a session cookie: an
authenticated client exchanges its bearer token for an HttpOnly, SameSite
cookie scoped to the plugin namespace, and the daemon accepts either the
bearer header or that cookie for `/v1/plugins/…` requests (the cookie is
valid nowhere else). Requests for a plugin id that is unknown, disabled,
or whose backend is not running SHALL receive a `not_found` or
`unavailable` error in the standard error envelope, not a hung connection.

#### Scenario: Proxied request reaches the backend

- **WHEN** an authenticated client requests `/v1/plugins/openspec/changes`
- **THEN** the openspec backend receives `GET /changes` and its response is
  relayed to the client

#### Scenario: Unauthenticated proxy request is rejected

- **WHEN** a request to `/v1/plugins/openspec/ui/` carries no valid token
  and no valid plugin-session cookie, and the daemon requires auth
- **THEN** the daemon responds with the standard unauthorized error and the
  backend never sees the request

#### Scenario: Cookie unlocks the iframe under bearer auth

- **WHEN** an authenticated client exchanges its bearer token for a plugin
  session cookie and an iframe then loads `/v1/plugins/openspec/ui/`
  sending that cookie
- **THEN** the request is authorized and proxied; the same cookie presented
  on a non-plugin route such as `/v1/features` does not authorize it

#### Scenario: Backend down maps to an envelope error

- **WHEN** a plugin's backend has crashed and a client requests one of its
  routes
- **THEN** the daemon responds with an `unavailable` error envelope rather
  than timing out

### Requirement: Backend lifecycle is supervised with patience

The daemon SHALL restart a crashed plugin backend with exponential backoff
and a cap, and SHALL stop restarting after the attempt budget is exhausted,
marking the plugin state `error` with a diagnostic. On daemon shutdown all
plugin processes SHALL be terminated (graceful signal first, then kill
after a grace period). A restarting or exhausted plugin SHALL NOT affect
the daemon's own health endpoints.

#### Scenario: Crash triggers backoff restart

- **WHEN** a plugin backend exits unexpectedly
- **THEN** the daemon restarts it after a backoff delay, and repeated
  crashes lengthen the delay up to a cap

#### Scenario: Budget exhaustion parks the plugin

- **WHEN** a backend keeps crashing past the restart budget
- **THEN** the daemon stops restarting it, the listing shows state `error`
  with the failure diagnostic, and the daemon itself remains healthy

#### Scenario: Shutdown reaps plugin processes

- **WHEN** the daemon receives a shutdown signal
- **THEN** all plugin backends are signalled to terminate and are killed if
  still alive after the grace period

### Requirement: Plugins interact with Conductor only through the public API

A plugin backend SHALL be handed the same HTTP API any third-party client
uses (`CONDUCTOR_URL` + `CONDUCTOR_TOKEN`) and SHALL have no other
integration surface: no engine hooks, no direct database access, no
workflow-action registration. Conductor SHALL NOT load plugin code into
the daemon process.

#### Scenario: Plugin drives work through the API

- **WHEN** a plugin backend wants to start a feature
- **THEN** it calls the existing feature-creation endpoint with its token,
  exactly as an external client would
