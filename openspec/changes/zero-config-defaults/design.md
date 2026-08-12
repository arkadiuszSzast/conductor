## Context

See `proposal.md`. Today: `daemon-config.ts` (pure parse/assemble),
`commandDaemon` in `cli.ts` (usage error without `--config`),
`resolveConnection` in `config.ts` (flags → env → JSON client config, no
fallback), `WorkflowRegistry.register` already validates and registers a
project at runtime (the daemon calls it at startup), API routes live in
`api.ts` with an `EngineControl`-style deps surface. `conductor init` is
pure over `CliDeps` (exists/mkdir/writeFile).

## Goals / Non-Goals

**Goals:**
- Zero-flag `conductor daemon` and zero-env CLI on the same machine.
- `conductor init` = scaffold + durable registration (config) + live
  registration (API) in one idempotent command.
- Keep every explicit path working with unchanged precedence.

**Non-Goals:**
- No `conductor project add/remove` command surface in this change (init
  covers the adoption flow; explicit management can come later).
- No auto-generated bearer tokens (decision: default `auth.mode: none` on
  a loopback bind with the existing warning).
- No daemon-side config file writing — the CLI owns the file; the API
  route only affects the running process.
- No Windows support beyond what `~` expansion already gives.

## Decisions

**D1 — Platform paths via XDG with `~` fallback.** New pure helper
`platformPaths(env)` → `{configPath, dataDir}` from `XDG_CONFIG_HOME` /
`XDG_DATA_HOME` falling back to `$HOME/.config` / `$HOME/.local/share`.
Requires `HOME` (or XDG overrides) — a machine with neither gets a clear
error. `CliDeps` already carries `env`; no new port needed.

**D2 — Generation happens in the daemon command, not a separate step.**
`conductor daemon` without `--config`: if the platform config file is
missing, write it (via existing `writeFile`/`mkdir` ports) from a
`DEFAULT_DAEMON_CONFIG` template (loopback 4400, XDG data-dir DB,
`auth.mode: none`, `projects: []`), log `daemon config generated`, then
proceed exactly as if `--config` had named it. `--init-config` stays for
writing an example elsewhere.

**D3 — `projects: []` becomes legal.** `assembleDaemonConfig` drops the
non-empty requirement (validation of element type stays). The daemon
already handles zero registered projects.

**D4 — `POST /v1/projects` reuses registry registration.** Request
`{dir}`; 200 with the project's status on success (idempotent re-register
included), 422 with diagnostics when the workflow is invalid/missing.
ApiDeps gains `registerProject?: (dir) => RegisterResult` wired to
`daemon.registry.register`; absent → 404 (same pattern as `runners`).

**D5 — `conductor init` grows two idempotent effects.** After scaffolding:
(1) load-or-create the platform daemon config, add the project dir to
`projects` if absent, write back (YAML round-trip via a small
targeted update — regenerate the file from the parsed object with
`yaml`'s stringify; comments in a generated default file are acceptable
to lose, and we note this in docs); (2) resolve a connection
(new fallback chain) and `POST /v1/projects`; unreachable daemon → hint
on stdout, exit 0. A new `--no-register` flag opts out of both effects
for scaffold-only use.

**D6 — Connection fallback goes into `resolveConnection`.** New last step
in the chain: read the platform daemon config, derive
`http://<bind.host>:<bind.port>` + token. It reuses `loadDaemonConfig`
(moved import) with `readFile`/`exists` from deps. Precedence unchanged:
flags → env → client JSON config → daemon config fallback → usage error.

## Risks / Trade-offs

- [Config file loses comments when init rewrites it] → acceptable: the
  file is machine-generated; documented. Operators who hand-craft configs
  use `--config` explicitly and init never touches those.
- [Two writers of the config (human + init)] → init only appends to
  `projects` on the platform-path file; parse errors surface loudly and
  abort before writing.
- [`auth.mode: none` default] → bind default is loopback-only; warning
  stays; docs call out switching to bearer for anything non-local.
- [XDG on macOS] → falls back to `~/.config`/`~/.local/share`, which is
  conventional for CLI tools there too.

## Migration Plan

Additive for users of explicit configs. The `daemon-entrypoint` spec is
re-baselined by this change's MODIFIED requirements (greenfield, no
deployed installs). Docs update collapses the quick start.

## Open Questions

None.
