## Why

The system is functionally complete — daemon lifecycle, HTTP API v1, CLI,
runner adapter, SPA — but there is no way to run it outside tests. Nothing
instantiates the `Daemon` class in a real process, nothing binds the API on
a port, and the `conductor` CLI is a pure client with no server to talk to.
Adopting Conductor on a real project (the open task
`standalone-daemon-extraction` task 5) requires a process entrypoint, a
configuration file, and an install path that works on a developer/test
machine **entirely from the local repo** — no registry publication.

## What Changes

- New `conductor daemon` subcommand: a process entrypoint that reads a
  daemon configuration file, instantiates `Daemon` + `createApi`, binds the
  HTTP server, and owns graceful shutdown (SIGINT/SIGTERM → drain →
  `daemon.stop()`). Configuration comes from one YAML file mapped onto
  `DaemonConfig` + `ApiConfig`; missing config is a usage error (exit 2) —
  no default paths, no `$HOME` inference (AGENTS.md hard rule). A
  `--init-config <path>` mode scaffolds an example config.
- Local install, two paths, both repo-only:
  - `bun link` in `packages/cli` → a global `conductor` for the dev loop
    (verified to work from the linked bin).
  - `bun run build:binary` → a single compiled executable
    (`bun build --compile` of the CLI into `dist/conductor`) to copy to
    other machines. `private: true` stays; no `publishConfig`, no
    publication.
- Two binary pitfalls solved/documented:
  - **Bundled actions** (`packages/server/actions/*.yaml`) are read from
    disk relative to the module and do not exist inside the binary. Chosen
    approach: when the default bundled path is unavailable and the operator
    did not set `actions.bundledPath`, the daemon logs an explicit,
    instructive warning (workflows using `action:` steps become invalid; a
    config pointing at a checkout copy restores them). No manifest
    embedding — `?raw`-style text imports do not survive
    `bun build --compile` on the current Bun, so embedding is a worse
    trade-off than an explicit config surface.
  - **SPA** (`apps/web/dist`) is never embedded: `ui.staticDir` in the
    config points at a directory on disk (built separately with
    `bun run build`). SPA embedding is recorded as a follow-up.
- Runner connection on a fresh machine is already fully env-configured
  (`CONDUCTOR_URL`/`CONDUCTOR_TOKEN` + callback bind/auth); it is
  documented in `docs/install.md` with a working first-feature walkthrough.
- `docs/install.md`: requirements, the three paths (dev link, binary,
  run-it), runner hookup, first feature, troubleshooting.

## Capabilities

### New Capabilities
- `daemon-entrypoint`: the `conductor daemon` process — config file
  contract, flag overrides, explicit-no-defaults rules, signal-driven
  graceful shutdown, `--init-config`.
- `local-install`: repo-only install paths — `bun link` dev loop and the
  compiled single-file binary — with the bundled-actions and SPA
  constraints they impose.

### Modified Capabilities
_None — no requirement-level change to `feedback-loops`, `repository-foundation`
or `web-ui`; the daemon/API/runner capabilities live in the still-active
`standalone-daemon-extraction` change and are extended here by new
requirements in the new capabilities above._

## Impact

- `packages/cli` — new `daemon` subcommand in the parser/`runCli` with a
  pure, `CliDeps`-injectable command handler (config load/validate/assemble
  is a clean function; only `main.ts` touches `Bun.serve`/`process.on`);
  new ports in `CliDeps` (start server, signal registration, config
  read/write) for testability.
- `packages/server` — possibly a small explicit diagnostic when the bundled
  action registry is missing and `actions.bundledPath` was not configured;
  no lifecycle changes.
- Root `package.json` — `build:binary` script.
- `packages/runner-opencode` — no code change expected (env config already
  complete); covered by docs.
- `docs/install.md` new; CLI `--help` usage updated.
- No DB migrations, no `@conductor/core` changes, no engine semantics.
- No effect on gloam-idle configs (this is additive: a daemon can now run).
