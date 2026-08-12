## Purpose

Repo-only installation of Conductor on a developer or test machine with
zero registry publication: a `bun link`-based dev loop and a compiled
single-file executable, with the on-disk dependencies (action manifests,
SPA build) they impose.

## ADDED Requirements

### Requirement: The CLI installs from the local repo without publication

All workspace packages SHALL remain private (`private: true`, no
`publishConfig`); installation SHALL happen only from the local
repository. `bun link` in `packages/cli` SHALL make a working global
`conductor` executable for the dev loop, and `bun run build:binary` from
the repository root SHALL produce a single compiled executable at
`dist/conductor` that runs the full CLI (including `daemon`) with no
Bun install required on the target machine.

#### Scenario: Dev loop via bun link
- **WHEN** a developer runs `bun link` inside `packages/cli`
- **THEN** a global `conductor` command becomes available and runs the
  CLI against a daemon (e.g. `conductor status`)

#### Scenario: Compiled binary runs the CLI
- **WHEN** `bun run build:binary` completes and `dist/conductor` exists
- **THEN** `./dist/conductor --help` prints the CLI usage including the
  `daemon` command, and `./dist/conductor daemon --config <path>` starts
  a daemon on a machine with no repo checkout

### Requirement: Bundled action manifests are explicit configuration in the binary

Inside a compiled binary the bundled action manifests
(`packages/server/actions`) are not on disk. When the daemon cannot load
them and the operator did not configure `actions.bundledPath`, the daemon
SHALL still start but SHALL log an explicit, instructive warning: the
bundled registry is unavailable, workflows whose steps use `action:`
become invalid, and pointing `actions.bundledPath` at a directory
containing the manifests restores them.

#### Scenario: Binary daemon degrades bundled actions explicitly
- **WHEN** the compiled binary's daemon starts with no
  `actions.bundledPath` configured
- **THEN** the daemon starts and serves the API, but logs a warning that
  bundled action manifests are unavailable and names the config field
  that restores them; any workflow using `action:` steps is reported
  invalid

#### Scenario: Configured bundled path restores actions in the binary
- **WHEN** the daemon config sets `actions.bundledPath` to a directory
  containing the action manifests
- **THEN** the registry loads from that directory and `action:` steps
  resolve normally

### Requirement: The web UI is served from an explicit on-disk directory

The daemon SHALL serve the SPA only when `ui.staticDir` in the config
points at a directory containing the built app (`apps/web/dist`). The
SPA is never embedded in the executable; building it is a documented,
separate step. Without `ui.staticDir`, the API SHALL behave exactly as
without the capability.

#### Scenario: Static UI served from a configured directory
- **WHEN** a config sets `ui.staticDir` to a directory containing a
  built SPA (`index.html` present)
- **THEN** the daemon serves the SPA at `/` while `/v1/*` routes keep
  API precedence

#### Scenario: No static directory means no UI
- **WHEN** a daemon starts without `ui.staticDir`
- **THEN** the API is unchanged and no static files are served
