## Context

See proposal.md for motivation. Facts that shape the approach:

- The daemon has no framework router: `packages/server/src/api.ts` is one
  `route()` if/regex chain with `ApiDeps` dependency injection, where
  optional deps make their routes 404 — the existing pattern for optional
  capabilities.
- Three precedents already model "external things registered with the
  daemon": the action registry (declarative manifests scanned from
  configured dirs, diagnostics-not-crashes, symlink rejection, size caps),
  the action host's `process` kind (capability-wrapped child processes),
  and the runner registry (self-registering external HTTP endpoints).
- The SPA is a static build served by the daemon (possibly embedded in the
  compiled binary); there is no runtime module-loading scheme in the web
  app. Live updates are invalidation-driven: SSE event → coalesced REST
  refetch.
- `daemon.yaml` validation rejects unknown top-level fields
  (`TOP_LEVEL_FIELDS` in `packages/cli/src/daemon-config.ts`).
- Research on OpenChamber (the inspiration) showed its right-side tab rail
  is a closed, hardcoded surface registry and its "plugins" are config
  management for OpenCode's plugin loader — the UX is worth copying, the
  mechanism is not; we design our own.

## Goals / Non-Goals

**Goals:**

- A plugin contract stable across internal SPA rewrites: plugins never
  import host frontend code and never load code into the daemon process.
- Runtime-agnostic backends (any executable serving HTTP), consistent with
  the runner philosophy.
- Failure containment: a broken plugin degrades to a diagnostic, never a
  daemon crash or a broken Control Room.
- The bundled OpenSpec plugin proves the contract end to end with zero
  special-casing.

**Non-Goals:**

- Process sandboxing or permission enforcement (capabilities in the
  manifest are declared intent, documentation for the human installing the
  plugin — v1 trust model is "install only what you trust", stated
  honestly in docs).
- Scoped API tokens (plugins get the daemon token; token scoping is a
  future change that slots into `CONDUCTOR_TOKEN` without contract
  changes).
- Server-driven declarative panel UI, plugin marketplace, hot reload of
  manifests (restart daemon or a future explicit reload endpoint).

## Decisions

### D1: iframe UI, not remote ES modules, not server-driven JSON

The panel is an iframe pointed at the plugin's proxied UI route.

- *Rejected — remote ESM* (`import()` of plugin-built components): couples
  every plugin to the host's React version and internals forever; a
  community contract we could never break. Also grants plugin code full
  DOM/token access in the host origin's main frame.
- *Rejected for v1 — server-driven JSON UI*: sufficient for OpenSpec's
  list-and-button panel but frustrating for community plugins we cannot
  foresee; can be layered on later as an "easy mode" (an iframe host page
  we ship that renders declarative JSON), whereas the reverse migration is
  impossible.
- iframe cost (theming, bridge ceremony) is accepted; the bridge passes
  theme tokens, and same-origin serving avoids CORS entirely.

### D2: backend = HTTP child process behind a daemon reverse proxy

The supervisor spawns the manifest's argv, assigns a loopback port via
`CONDUCTOR_PLUGIN_PORT`, and the daemon proxies `/v1/plugins/<id>/*` to
it. Auth is enforced at the daemon edge; the child binds loopback only.

- *Rejected — stdio JSON protocol* (like process actions): forces every
  plugin author to implement our framing protocol; HTTP is the lingua
  franca and lets plugins be written in anything with a web server, and
  lets a plugin serve its UI and its API from one process trivially.
- *Rejected — plugins register themselves like runners*: runners are
  long-lived external services with their own lifecycle; plugins should be
  zero-ops for the user (drop a directory, daemon owns the process).
  Supervision (spawn/backoff/reap) stays in the daemon, reusing the
  patience model (exponential backoff, cap, attempt budget) from the
  retry-policy work.
- Proxy is a thin `fetch` relay in the server package (undici/Bun fetch to
  `127.0.0.1:<port>`), streaming bodies, forwarding method/headers minus
  hop-by-hop, mapping connection errors to the `unavailable` envelope.
  SSE/WebSocket upgrade passthrough is out of scope for v1 (plugins poll
  or long-poll; revisit when a plugin needs push).

### D3: registry mirrors the action registry, not a new pattern

`plugin-registry.ts` in `packages/server` scans
`<config-dir>/plugins/*/plugin.yaml`, configured extra paths, and each
registered project's `.conductor/plugins/*/plugin.yaml`. Same hygiene as
the action registry: 1 MiB manifest cap, symlink rejection, id-matches-
directory, diagnostics accumulate instead of throwing. Manifest parsing
lives in `@conductor/core` (pure parse+validate, like action manifests)
so the CLI can lint manifests later; scanning/spawning is server-side I/O.
Precedence: project shadows global by id within that project's scope;
duplicate ids within one scope disable both with a conflict diagnostic.

### D4: API surface is one listing plus a proxy mount, wired via ApiDeps

`ApiDeps` gains optional `plugins: PluginControl` (listing, per-plugin
proxy target resolution). Routes:

- `GET /v1/plugins?project=<id>` → listing with scope resolution applied.
- `ANY /v1/plugins/<id>/…` → proxy (UI paths under `/ui/` served from the
  plugin's static dir when no backend; everything else requires the
  backend). Placed in the `route()` chain before the 404, after auth.

Absent dep → 404, consistent with `runners`/`registerProject`. The plugin
listing changes rarely; a `plugins` invalidation event is emitted on state
changes (crash, restart, parked) over the existing SSE channel so the rail
can refetch — no new transport.

### D5: bridge is a tiny versioned protocol owned by the host

`apps/web/src/plugins/bridge.ts` defines `{ v: 1, type, payload }`
messages: host→panel `context` (project, selection, theme) and
`context-changed`; panel→host `ready` (with requested version),
`navigate`, `refresh`. Unknown version or shape → drop silently. The token
never crosses the bridge: the iframe is same-origin, and panel network
calls go to the plugin's own proxied routes, which the plugin backend
answers using its server-side token. This keeps the token out of
plugin-authored JS entirely. We publish the message shapes in
`docs/plugins.md` rather than an npm SDK package for v1 (a `postMessage`
protocol is small enough to document; an SDK can wrap it later without
breaking anyone).

Consequence to note: same-origin iframes are not a hard security boundary
against a hostile plugin UI (it could reach `window.parent`). The sandbox
attribute plus "install only what you trust" is the honest v1 posture —
identical trust level to the backend process itself.

Auth for panel requests: iframe navigations and panel fetches cannot carry
the bearer header, so the daemon offers a cookie exchange —
`POST /v1/plugins/session` (bearer-authenticated) sets an HttpOnly,
SameSite=Strict cookie whose path scopes it to `/v1/plugins/`; the
authorizer accepts bearer-or-cookie for the plugin namespace only. The SPA
performs the exchange once after login. Chosen over a query-string token
(leaks into history/logs, doesn't cover panel fetches) and over "document
the limitation" (bearer mode is the recommended deployment; panels must
work there).

### D6: scope resolution keyed by the board's active project

Project plugins attach to a registered project (the registry knows each
project's root). The web rail asks `/v1/plugins?project=<active>` whenever
the board scope changes. The OpenSpec plugin backend receives
`CONDUCTOR_PROJECT_DIR` and shells out to the `openspec` CLI (`list
--json`, `status --json`) in that directory — no reimplementation of
OpenSpec parsing.

### D7: bundled plugin lives in `plugins/openspec/`, installed by link

Top-level `plugins/` directory (not a workspace package — it must look
exactly like a user plugin): `plugin.yaml`, `serve.ts` (Bun HTTP server:
`/changes`, `/start-work`, static `/ui/*`), `ui/` (dependency-free static
HTML/JS using the bridge). `conductor init` does not auto-install it;
docs show `ln -s`/copy into `.conductor/plugins/`. Dogfooded on this repo
itself (Conductor driving Conductor's own OpenSpec changes — the north
star).

## Risks / Trade-offs

- [Plugin holds the full daemon token] → Accepted for v1, documented
  loudly; token scoping is an isolated future change (mint per-plugin
  tokens in the supervisor, same env var). Mitigated structurally by
  keeping the token server-side in the plugin backend, never in panel JS.
- [Proxy becomes an attack surface (path traversal into static dirs,
  header smuggling)] → Static serving reuses the hardened `serveStatic`
  path rules from `api.ts`; proxy strips hop-by-hop headers and never
  forwards the daemon's `Authorization` header to the plugin backend.
- [Zombie plugin processes if the daemon dies hard] → Children get
  `CONDUCTOR_PLUGIN_PORT` on loopback and a parent-death signal where the
  platform supports it; supervisor kills the process group on shutdown.
  Residual risk accepted (same as any supervisor).
- [Port exhaustion / conflicts] → Ports are OS-assigned (bind port 0,
  read back), never configured.
- [iframe UX seams (focus, scroll, theming drift)] → Bridge sends theme
  tokens at startup and on change; panel CSS conventions documented; a
  future shipped component kit can tighten this without contract changes.
- [Rail creep: plugins competing with the gate flow for attention] →
  web-ui delta pins the two-click gate guarantee; rail is absent when no
  plugins exist, collapsible always.
- [Windows support for process groups/parent-death] → Supervisor treats
  these as best-effort platform capabilities; correctness (reap on
  graceful shutdown) never depends on them.

## Migration Plan

Purely additive: no store schema changes, no workflow format changes.
Daemons with no `plugins/` directories and no config section behave
identically. Rollback = remove plugin directories / set
`plugins.enabled: false`. gloam-idle untouched.

## Open Questions

- Whether the panel iframe should also collapse to a bottom sheet on
  narrow viewports via the existing `ActionSheet` or a new overlay —
  decidable during web implementation; spec only requires an overlay
  presentation.
- Exact backoff constants for the supervisor (likely borrow the
  retry-policy defaults) — tuning, not contract.
