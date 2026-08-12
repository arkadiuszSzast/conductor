## Why

The first-run experience requires hand-editing a YAML file before anything
works: `conductor daemon` refuses to start without `--config`, projects are
registered by editing the daemon config and restarting, and every CLI
command demands `CONDUCTOR_URL`. For a self-hosted tool the explicitness is
right as an *option*, but as the *only* path it makes "install → working
app" a multi-step chore. Platform conventions (XDG base directories) give
well-defined per-user locations that are not host-specific, so defaults can
exist without violating the "no host-specific paths" principle.

## What Changes

- **`conductor daemon` works with zero flags.** Without `--config` it uses
  the platform config path (`$XDG_CONFIG_HOME/conductor/daemon.yaml`,
  falling back to `~/.config/conductor/daemon.yaml`). When the file does
  not exist it is generated with working defaults — database at
  `$XDG_DATA_HOME/conductor/conductor.db` (fallback
  `~/.local/share/conductor/conductor.db`), `createDatabaseDirectory:
  true`, bind `127.0.0.1:4400`, `auth.mode: none` (loopback-only bind plus
  the existing explicit warning), empty project list — and the daemon
  starts. `--config <path>` keeps today's behaviour (explicit file, error
  when missing). **BREAKING** for the `daemon-entrypoint` spec: "no
  default config path" is replaced by "platform-convention default with
  explicit override".
- **`conductor init` registers the project.** After scaffolding
  `conductor.yaml` it adds the project directory to the daemon config's
  `projects` list (creating the default config when absent, same defaults
  as above). When a daemon is reachable it also registers the project live
  over a new API route so no restart is needed. Registration is
  idempotent.
- **New API route: project registration.** `POST /v1/projects` registers a
  project directory at runtime (same validation as startup registration);
  the daemon config stays the durable record (the CLI writes it), the
  route makes the running daemon pick it up without restart.
- **CLI connection falls back to the daemon config.** When `--url`,
  `CONDUCTOR_URL` and `--config`/`CONDUCTOR_CONFIG` are all absent, the
  CLI reads the platform daemon config and derives the URL from `bind`
  (plus the bearer token when configured). Explicit sources keep
  precedence. A missing daemon config keeps today's usage error.

## Capabilities

### Modified Capabilities
- `daemon-entrypoint`: default config path + auto-generation replace the
  hard "no default configuration path" rule; project registration gains a
  runtime API route; the CLI connection contract gains a config-derived
  fallback.

### New Capabilities
_None — everything lands in the existing `daemon-entrypoint` capability._

## Impact

- `packages/cli` — platform-path resolution (XDG with `~` fallback),
  default-config generation, `init` project registration (config write +
  live API call), connection fallback in `resolveConnection`.
- `packages/server` — `POST /v1/projects` route wired to the existing
  `WorkflowRegistry.register`; no engine changes.
- `docs/install.md`, README quick start — collapse to the shorter flow.
- No DB migrations. Existing explicit-config workflows keep working
  unchanged (`--config`, env vars, flags all keep precedence).
