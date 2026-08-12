# Installing and running Conductor

Conductor installs **only from this repository** — nothing is published to
any registry before a stable release. Two install paths cover the dev loop
and moving a build to another machine; both end at the same place: a
`conductor daemon --config <file>` process and clients talking to its HTTP
API.

## Requirements

- **Bun >= 1.0** (see `engines` in the root `package.json`). Bun is a hard
  runtime requirement — the server uses `bun:sqlite`, so Node/npx cannot
  run the daemon. The compiled binary (path B) embeds the Bun runtime, so
  the *target* machine needs no Bun install.
- Git, and a project you want Conductor to drive.

## Path A — dev loop (`bun link`)

From a repo checkout:

```sh
bun install
cd packages/cli
bun link            # registers @conductor/cli
bun link @conductor/cli   # or rely on the global bin: ~/.bun/bin/conductor
```

`bun link` exposes the `conductor` bin (it points at `src/main.ts`, which
runs directly under Bun — no build step). Verify:

```sh
conductor --help
```

## Path B — single-file binary (`bun build --compile`)

```sh
bun install
bun run build:binary     # → dist/conductor (embedded Bun runtime)
```

Copy `dist/conductor` to any Linux machine of the same architecture and
run it directly — no Bun, no repo needed for the CLI itself.

Two things do **not** travel inside the binary:

- **Bundled action manifests** (`packages/server/actions/*.yaml`). A
  binary-run daemon starts without them and logs a warning; workflows
  using `action:` steps are reported invalid until you point
  `actions.bundledPath` in the daemon config at a directory containing the
  manifests (e.g. a copy of `packages/server/actions` from a checkout).
- ~~The web UI~~ — no longer a pitfall: `bun run build:binary` builds the
  SPA and **embeds it in the executable**; the daemon serves it
  automatically (disable with `conductor daemon --no-ui`).

## Running the daemon

Zero-config start:

```sh
conductor daemon
```

Without `--config` the daemon uses the platform config at
`$XDG_CONFIG_HOME/conductor/daemon.yaml` (falling back to
`~/.config/conductor/daemon.yaml`). On first run the file is generated
with working defaults — database under `$XDG_DATA_HOME/conductor`
(fallback `~/.local/share/conductor`), bind `127.0.0.1:4400`,
`auth.mode: none` (loopback-only; an explicit warning is logged — switch
to `bearer` for anything non-local), empty project list — and the daemon
starts from it. Edit the file and restart to change anything.

The **web UI** ships inside the artifact and serves automatically at the
daemon's address (`/v1/*` keeps API precedence): the compiled binary
carries an embedded SPA; a checkout-run daemon serves `apps/web/dist`,
building it once on first start when missing. `--no-ui` disables it.

Explicit config (operators who want full control):

```sh
conductor daemon --init-config ./conductor-daemon.yaml   # write an annotated example
$EDITOR ./conductor-daemon.yaml
conductor daemon --config ./conductor-daemon.yaml        # missing explicit file = error, never generated
```

Minimal config:

```yaml
databasePath: /var/lib/conductor/conductor.db
createDatabaseDirectory: true
projects:
  - /path/to/my-project        # must contain conductor.yaml
bind:
  host: 127.0.0.1
  port: 4400
auth:
  mode: bearer
  token: "change-me"           # or mode: none — logged as an explicit warning
heartbeatIntervalMs: 5000
# actions:
#   bundledPath: /path/to/conductor/packages/server/actions   # needed for the compiled binary
```

`CONDUCTOR_BIND_HOST` / `CONDUCTOR_BIND_PORT` override the config's
`bind` without editing the file (Docker/systemd/LAN exposure). Exposing a
non-loopback host with `auth.mode: none` triggers an extra loud warning —
switch to `bearer` first.

Logs are JSON lines on stdout. Readiness: `GET /v1/readyz` → 200 once
migrations ran, projects registered and the heartbeat is armed. The
daemon stops gracefully on SIGINT/SIGTERM (drains in-flight work, closes
the listener and SQLite, exits 0); a second signal forces exit.

## Connecting the opencode runner

The runner adapter (`@conductor/runner-opencode`) is an opencode plugin.
It is configured entirely through environment variables — set them in the
environment opencode runs in:

| Variable | Meaning |
|---|---|
| `CONDUCTOR_URL` | daemon API base URL, e.g. `http://127.0.0.1:4400` (required) |
| `CONDUCTOR_TOKEN` | bearer token, matching the daemon's `auth` (omit for `mode: none`) |
| `CONDUCTOR_RUNNER_HOST` | callback listen host, e.g. `127.0.0.1` (required) |
| `CONDUCTOR_RUNNER_PORT` | callback listen port (omit/0 = ephemeral) |
| `CONDUCTOR_RUNNER_TOKEN` | bearer token the daemon must present on callbacks — or |
| `CONDUCTOR_RUNNER_AUTH` | `none`, the explicit opt-out (exactly one of the two) |

Load the plugin from the repo checkout in the project's opencode config
(`.opencode/`): reference `packages/runner-opencode/src/plugin.ts`. On
start the plugin registers its callback endpoint with the daemon
(`POST /v1/runners`); `GET /v1/health` then reports the runner available.

## First feature

```sh
cd /path/to/my-project
conductor init      # scaffolds conductor.yaml AND registers the project:
                    # it is added to the LOCAL daemon config (generated if absent) and,
                    # when a daemon is running, registered live — no restart.
                    # With an explicit connection (--url/CONDUCTOR_URL/--config) the
                    # daemon of record may be remote: init registers live only and
                    # never touches the local platform config.
                    # --no-register: scaffold only.

# Only needed for a REMOTE daemon or auth overrides — a local daemon's
# generated config supplies the CLI's address and token automatically:
export CONDUCTOR_URL=http://127.0.0.1:4400
export CONDUCTOR_TOKEN=change-me

conductor start "Ship the thing"     # --project defaults to the current directory
conductor status --active            # watch progress
conductor status <feature-id>        # detail: status, current step, run
conductor approve <feature-id> --notes "ship it"   # when waiting_human
conductor logs <feature-id>          # transition timeline
```

## Troubleshooting

- **Port already in use** — `conductor daemon` fails at startup with a
  bind error. Change `bind.port` in the config (or `CONDUCTOR_BIND_PORT`),
  or find the occupant: `lsof -i :4400`.
- **UI/API not reachable from another machine** — the default bind is
  loopback. Set `bind.host: 0.0.0.0` (or `CONDUCTOR_BIND_HOST=0.0.0.0`)
  AND switch auth to `bearer`; open the port in the firewall.
- **`conductor init` rewrote my daemon config comments** — the platform
  config file is machine-generated and regenerated on project
  registration; hand-crafted configs should live elsewhere and be used
  via `conductor daemon --config <path>` (init never touches those).
- **`error[unauthorized]` / exit code 3** — the client's token does not
  match the daemon's `auth.token`. Set `--token`/`CONDUCTOR_TOKEN` to the
  daemon's configured value. `auth.mode: none` daemons need no token.
- **`daemon unreachable` / exit code 7** — wrong `--url`, daemon not
  running, or it bound a different host/port. Check the daemon's
  `api listening` log line.
- **Workflow invalid at registration** — the daemon logs
  `workflow invalid: …` per diagnostic and `/v1/health` reports the
  project's state. Fix `conductor.yaml`; the registry reloads on the next
  registration (restart the daemon or fix before start).
- **`action:` steps invalid under the compiled binary** — the bundled
  manifests are not inside the binary; set `actions.bundledPath` (see
  Path B above).
- **Runner reported unavailable** — no runner registered yet. Check the
  opencode plugin env (`CONDUCTOR_URL`, callback auth pair) and that
  opencode is running in a directory registered under `projects`.
