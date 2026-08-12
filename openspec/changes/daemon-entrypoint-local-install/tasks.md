# Tasks — daemon-entrypoint-local-install

## 1. Daemon config module (pure)

- [x] 1.1 [cli] Add `packages/cli/src/daemon-config.ts`: pure functions parsing/validating the daemon YAML config (reusing the `yaml` parser from `@conductor/core`) into a `DaemonConfig` + `ApiConfig` pair; explicit errors for missing/invalid fields, unknown auth mode, non-numeric port, bearer without token.
- [x] 1.2 [cli] Define the `--init-config` example config template with inline documentation of every field.
- [x] 1.3 [test] Unit-test config parsing: happy path, missing `--config`, malformed YAML, unknown auth mode, bearer-without-token, empty projects/databasePath, non-numeric port.

## 2. `conductor daemon` command

- [x] 2.1 [cli] Add `daemon` to the CLI: `--config <path>` (required) and `--init-config <path> [--force]`, documented in `USAGE`/`--help`; missing config → usage error (exit 2) with an example; `--init-config` writes the template and honours `--force`.
- [x] 2.2 [cli] Add a `startDaemon` port to `CliDeps` (injectable: assemble `Daemon` + `createApi` + `Bun.serve` + signal wiring); the daemon command wires config → `startDaemon` → graceful stop on SIGINT/SIGTERM, structured JSON logs on stdout in the `jsonLineLogger` shape.
- [x] 2.3 [server] When the bundled action registry default path is unavailable and `actions.bundledPath` was not configured, log an explicit, instructive warning (workflows with `action:` steps invalid; point `actions.bundledPath` at a checkout copy to restore).
- [x] 2.4 [test] CLI tests: `daemon` usage errors, `--init-config` write/overwrite, config→`DaemonConfig`+`ApiConfig` assembly, `auth.mode: none` warning, graceful-stop path through injected `startDaemon`.

## 3. Local install & binary

- [x] 3.1 [cli] Verify `bun link` in `packages/cli` yields a working global `conductor` (bin → `src/main.ts` under a link); fix if broken.
- [x] 3.2 [cli] Add root `build:binary` script (`bun build --compile` of the CLI into `dist/conductor`); verify `./dist/conductor --help` and `./dist/conductor daemon` run from a clean machine dir (no repo needed for the CLI itself).

## 4. Runner connection & docs

- [x] 4.1 [runner] Confirm `packages/runner-opencode` env config (`CONDUCTOR_URL`/`CONDUCTOR_TOKEN` + callback bind/auth) covers a fresh machine; fill any minimal gap if missing.
- [ ] 4.2 [docs] Write `docs/install.md`: requirements (Bun per `engines`), the three paths (dev `bun link`, binary `bun run build:binary` + copy, run with example config), runner hookup, first feature walkthrough (init → start → status → approve), and troubleshooting (port taken, wrong token, invalid workflow). Document bundled-actions and SPA-on-disk constraints.
- [ ] 4.3 [docs] Update the CLI `--help`/usage in `packages/cli/src/cli.ts` to include the `daemon` command.

## 5. Verification

- [ ] 5.1 [test] `bun test && bun run typecheck && bun run lint` all green.
- [ ] 5.2 [review] Grep new code for host-specific paths (`$HOME`, `homedir`, hardcoded paths) and opencode SDK imports outside `packages/runner-opencode`; run the manual smoke test (binary build, `--init-config`, temp project, daemon up + `/v1/readyz` 200, `status --url`, SIGINT graceful stop, exit 0) and paste results into the PR description.
