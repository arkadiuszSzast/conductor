## Why

Conductor's value grows with the tools people bolt onto it, but not every
tool belongs in core. The first concrete case is an OpenSpec panel: a
project that plans work with OpenSpec wants to see its changes, task
progress, and start work from the Control Room — while a project that does
not use OpenSpec should never see any of it. Baking that into core makes
the app opinionated about one planning tool; a plugin system makes such
tools opt-in and, more importantly, lets the community build panels we
cannot foresee. Doing it now, while the web UI shell is still young, is far
cheaper than retrofitting extension points later.

## What Changes

- New **plugin system** in the daemon and web UI. A plugin is a directory
  with a `plugin.yaml` manifest, an optional backend process (any
  executable that serves HTTP), and a UI panel rendered in the Control
  Room's new right-side panel rail inside a sandboxed iframe.
- **Discovery in two scopes**: global (`~/.config/conductor/plugins/<id>/`)
  and per-project (`<project>/.conductor/plugins/<id>/`). Project plugins
  only surface when that project is in scope; a project plugin shadows a
  global plugin with the same id (diagnostics, not crashes — same
  philosophy as the action registry).
- **Daemon**: plugin registry (manifest scan + validation), plugin process
  supervision (spawn, health, restart with backoff, reap on shutdown), and
  a reverse proxy mounting each plugin's backend under
  `/v1/plugins/<id>/…` so plugin UIs are same-origin with the SPA.
- **Web UI**: a right-side panel rail with tabs (the Control Room shell
  gains a collapsible side column). Each enabled plugin contributes one
  tab; the panel body is an iframe served from the plugin's proxied UI
  route. A small versioned `postMessage` bridge hands the plugin its
  context (active project/workflow, theme) and exposes host actions
  (navigate, refresh).
- **Plugins call the public API, nothing else.** No engine hooks, no custom
  workflow actions, no direct SQLite access. The engine remains unaware
  plugins exist. A plugin backend receives the daemon origin and a token
  and uses the same `/v1` API as any third-party client (the API-as-equals
  commitment doing its job).
- New **`openspec` bundled example plugin** shipped in-repo (as the first
  consumer and dogfood): a project-scoped plugin whose backend reads the
  project's `openspec/` directory via the `openspec` CLI and whose panel
  lists active/archived changes with task progress and offers "start work"
  for a change by calling the existing feature-creation API.
- Daemon config gains a `plugins` section (enable/disable, extra search
  paths) — an additive extension of `daemon.yaml`'s strict whitelist.

Not in scope (v1): plugin marketplace/installation tooling, sandboxing
beyond the iframe boundary, scoped/limited API tokens for plugins,
server-driven (declarative) plugin UI, plugin-contributed workflow actions
or CLI commands.

## Capabilities

### New Capabilities

- `plugin-registry`: manifest format, discovery across global and project
  scopes, precedence/shadowing, validation diagnostics, enable/disable via
  daemon config.
- `plugin-runtime`: backend process lifecycle (spawn, readiness, restart
  with backoff, shutdown reaping) and the reverse proxy that mounts plugin
  backends under `/v1/plugins/<id>/…` with auth at the edge.
- `plugin-panels`: the web UI panel rail, plugin tab visibility rules by
  scope, the iframe host, and the versioned postMessage bridge contract.
- `openspec-plugin`: the bundled OpenSpec panel — change listing, task
  progress, start-work action — as both a useful tool and the reference
  plugin implementation.

### Modified Capabilities

- `daemon-entrypoint`: daemon config accepts a new `plugins` section and
  the HTTP surface gains the `/v1/plugins` listing and per-plugin proxy
  mounts.
- `web-ui`: the Control Room shell gains a right-side panel rail whose
  tabs are populated from the daemon's plugin listing.

## Impact

- `packages/server`: new plugin registry + supervisor + proxy modules; new
  routes in `api.ts`; `ApiDeps` grows an optional `plugins` capability
  (absent → routes 404, consistent with existing optional deps).
- `packages/cli`: `daemon-config.ts` whitelist gains `plugins`; daemon
  wiring in `main.ts` starts/stops the plugin supervisor.
- `apps/web`: shell layout change (panel rail), iframe host component,
  bridge library.
- New top-level `plugins/openspec/` directory for the bundled example
  plugin (backend + static UI).
- No engine, interpreter, or store schema changes; no migration impact on
  existing conductor databases. gloam-idle configs are unaffected unless
  they opt into plugins.
- Carry-overs from the seed: none directly — the supervisor reuses the
  nudge/reap philosophy already carried into the daemon (backoff, reap on
  shutdown) rather than importing seed code.
