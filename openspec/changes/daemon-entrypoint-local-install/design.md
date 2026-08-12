## Context

See `proposal.md` — why. The system today has a complete `Daemon` lifecycle
(`packages/server/src/daemon.ts`), a socketless API handler plus a
`startApiServer` that wraps `Bun.serve` (`packages/server/src/api.ts`), and
a CLI whose only process-side file is `packages/cli/src/main.ts` (the
`CliDeps` pattern: every effect injectable, tests run against the
socketless handler). The `Daemon` constructor already validates
`heartbeatIntervalMs` and resolves the database path; `ApiConfig` requires
explicit `bind` and `auth`, and supports optional `ui.staticDir`.
`conductor init` already scaffolds a project's `conductor.yaml` and refuses
to overwrite without `--force` — the `--init-config` convention mirrors it.

## Goals / Non-Goals

**Goals:**
- A `conductor daemon` process entrypoint, testable through `CliDeps`
  (only `main.ts` touches real `Bun.serve` / `process.on`).
- One YAML config file as the single source of truth for the daemon, with
  an explicit-no-defaults contract (usage error on missing config).
- Two repo-only install paths (`bun link`, compiled binary) with the two
  on-disk pitfalls (action manifests, SPA) solved or documented.
- Runner→daemon connection verified documentable on a clean machine.

**Non-Goals:**
- No per-field flag overrides for daemon settings (config file is the
  single surface; keeps the flag parser and validation story minimal).
- No embedding of action manifests or the SPA into the binary.
- No registry publication, no `publishConfig`, no change to `private`.
- No new runner protocol surface or daemon lifecycle changes.

## Decisions

**D1 — Config file format is YAML, parsed with the existing `yaml`
dependency from `@conductor/core`.** Consistent with `conductor.yaml`;
the `yaml` package is already a direct dependency of `@conductor/core`
and is re-exported there. The CLI adds no new dependency.

**D2 — `conductor daemon --config <path>` is the only run entrypoint;
`--init-config <path>` scaffolds.** Flag surface matches the existing CLI
conventions (`--config`, `--force`, exit 2 usage errors). Field-level
overrides (`--db`, `--port`, `--project`) are deliberately omitted: the
config file already covers everything, and a second override channel
would silently fork the "single source of truth" contract. Alternative
considered and rejected: accepting overrides for quick smoke tests —
documented instead by `--init-config` and the example config.

**D3 — Command logic is a clean function on `CliDeps`.** A new
`startDaemon` port is added to `CliDeps` (`(config, logger) =>
{ready: Promise<void>; stop(): Promise<void>}`) so the command wiring
(config load → validate → assemble `DaemonConfig`/`ApiConfig` → call
`startDaemon` → wire signals → exit) is fully testable without a socket.
The real implementation lives in `main.ts` and owns `Bun.serve` /
`process.on` exactly once. Config parsing/validation lives in a separate
module (`daemon-config.ts`) as pure functions over the YAML text.

**D4 — Bundled actions in the binary: explicit degradation, not
embedding.** `?raw`/`?inline` text imports do not survive
`bun build --compile` on the current Bun (verified: 1.3.14 resolves them
at runtime but `bun build` fails to resolve), and the `--embed` CLI flag
does not exist yet. Embedding would therefore require a generated module
or the `Bun.build` API — more machinery than the problem warrants. Instead:
when the default bundled path is unavailable AND `actions.bundledPath` was
not configured, the daemon logs a loud, instructive warning (workflows with
`action:` steps become invalid; point `actions.bundledPath` at a checkout
copy to restore). The registry loader already degrades safely (diagnostic →
`undefined`); this change only makes the default-path failure explicit.

**D5 — Logs go to stdout in the existing `jsonLineLogger` shape.** The
daemon command injects a logger that writes `{level, message, ...fields}`
JSON lines via the `stdout` port (the same format `jsonLineLogger`
produces, per the request). The daemon's internal default logger is
untouched, so existing tests keep their stderr semantics.

**D6 — `auth.mode: "none"` logs an explicit startup warning.** Written
into the spec (`daemon-entrypoint`); implemented in the command layer
after config load.

**D7 — Binary build is `bun build --compile` of the CLI entrypoint.**
`build:binary` targets `packages/cli/src/main.ts` (the shebang'd bin) and
outputs `dist/conductor`. Because the CLI is a thin HTTP client, the
binary needs nothing else; the daemon it talks to must be run from config
(D2) on the target machine. The compiled CLI does not need the repo at
runtime — only the daemon's own config (`actions.bundledPath`,
`ui.staticDir`) may point at repo artifacts.

## Risks / Trade-offs

- [Binary daemon cannot run `action:` workflows out of the box] → explicit
  warning + documented `actions.bundledPath`; a checkout copy of
  `packages/server/actions` is one `cp` away. Embedding is the recorded
  follow-up when Bun's compile-time text embedding matures.
- [SPA not embedded → two artifacts to deploy] → documented build order
  (`bun run build` then point `ui.staticDir` at `apps/web/dist`);
  embedding recorded as follow-up.
- [`import.meta.dirname` in the binary is `/$bunfs/root`] → confirmed by
  experiment; the default bundled path simply cannot resolve, which is
  exactly the case D4 turns into an explicit warning.
- [Signal handling differs between `bun run` and the compiled binary] →
  handled through injectable `onSignal`/`startDaemon` ports; smoke test
  runs against the real binary.

## Migration Plan

Additive: nothing existing changes. A daemon is simply now startable via
`conductor daemon --config`. No DB migration, no gloam-idle config impact.
Rollback: stop the daemon process; earlier versions are unaffected.

## Open Questions

None.
