## 1. Manifest model (core)

- [x] 1.1 [core] Define `PluginManifest` types and `parsePluginManifest` /
  `validatePluginManifest` in `@conductor/core` (id, version, panel,
  optional backend argv, capabilities) with strict-YAML bounds mirroring
  action manifests
- [x] 1.2 [test] Core tests: valid manifest, id/directory mismatch handled
  at validate level, unsupported version, oversized/malformed input,
  missing required fields

## 2. Plugin registry (server)

- [x] 2.1 [server] `plugin-registry.ts`: scan global config-dir path,
  configured extra paths, and each registered project's
  `.conductor/plugins/`; symlink rejection, diagnostics accumulation,
  project-shadows-global precedence, same-scope duplicate conflict
- [x] 2.2 [server] Scope resolution API: listing filtered by project
  (global minus shadowed, plus project-owned), plugin states
  (`running|stopped|disabled|error`) and diagnostics
- [x] 2.3 [test] Registry tests: discovery in both scopes, shadowing,
  duplicate conflict, broken manifest diagnostics, disabled subsystem
  skips scanning

## 3. Supervisor and proxy (server)

- [x] 3.1 [server] `plugin-supervisor.ts`: spawn backend argv with cwd =
  plugin dir and env (`CONDUCTOR_PLUGIN_PORT` via bind-port-0 readback,
  `CONDUCTOR_URL`, `CONDUCTOR_TOKEN`, `CONDUCTOR_PROJECT_DIR` for project
  scope); restart with exponential backoff + cap + attempt budget; park as
  `error` on exhaustion; reap process group on shutdown with grace period
- [x] 3.2 [server] Reverse proxy: `ANY /v1/plugins/<id>/*` → loopback
  backend with prefix stripping, hop-by-hop header filtering, no
  `Authorization` forwarding, streamed bodies, connection failure →
  `unavailable` envelope; static `ui/` serving for backend-less plugins
  reusing the hardened static-file rules
- [x] 3.3 [server] Wire `PluginControl` into `ApiDeps` (absent → 404),
  add `GET /v1/plugins?project=` route, emit `plugins` SSE invalidation
  on state changes
- [x] 3.4 [test] Supervisor tests (fake process runner/clock): backoff
  sequence, budget exhaustion, shutdown reaping, health unaffected
- [x] 3.5 [test] Proxy/API tests: auth enforced at edge, prefix
  stripping, unknown/disabled/down plugin envelopes, static-only plugin,
  listing filter by project

## 4. Config and daemon wiring

- [x] 4.1 [cli] Extend `daemon-config.ts`: `plugins` section
  (`enabled`, `disabled[]`, `paths[]` absolute-only) added to the
  top-level whitelist with validation errors naming fields; omitted
  section defaults to enabled/no-extras
- [x] 4.2 [cli] Wire registry + supervisor into daemon startup/shutdown in
  `main.ts`; pass daemon origin and token into supervisor env contract
- [x] 4.3 [test] Config validation tests (relative path rejected,
  non-boolean enabled, defaults) and daemon lifecycle test (plugins
  started after ready, reaped on stop)

## 5. Panel rail and bridge (web)

- [x] 5.1 [web] Shell layout: collapsible right-side panel rail fed by
  `/v1/plugins?project=<active scope>`; no rail chrome when empty;
  tab + open/collapsed state persisted; narrow viewport presents as
  overlay/sheet
- [x] 5.2 [web] Iframe host: sandboxed same-origin iframe on
  `/v1/plugins/<id>/ui/`, inline error state with diagnostic + retry when
  plugin state is `error` or load fails
- [x] 5.3 [web] `bridge.ts`: versioned postMessage protocol — handshake
  (`ready` + version), host→panel `context`/`context-changed`
  (project, selection, theme), panel→host `navigate`/`refresh`; drop
  unknown versions/shapes; never transports the token
- [x] 5.4 [web] Refetch plugin listing on `plugins` SSE invalidation and
  on board scope change
- [x] 5.5 [test] Web tests: rail visibility per scope, persistence across
  reload, bridge handshake + context push + navigate, error panel state,
  gate flow still two clicks with a panel open

## 6. Bundled OpenSpec plugin

- [x] 6.1 [server] `plugins/openspec/`: `plugin.yaml` (project-scoped
  usage documented) + `serve.ts` Bun HTTP backend — `/changes` (shells
  out to `openspec list/status --json` in `CONDUCTOR_PROJECT_DIR`),
  `/start-work` (calls public feature-creation API with
  `CONDUCTOR_TOKEN`), static `/ui/*`; explanatory empty payload when no
  `openspec/` root
- [x] 6.2 [web] `plugins/openspec/ui/`: dependency-free panel — active
  changes with task progress, archived list, refresh, start-work button
  wired to backend then `navigate` via bridge; inline API error display
- [x] 6.3 [test] Plugin backend tests: change listing against a fixture
  openspec tree, missing-openspec empty state, start-work happy path and
  API-failure passthrough
- [x] 6.4 [test] End-to-end: link the bundled plugin into a test
  project's `.conductor/plugins/`, daemon discovers/spawns it, listing
  and proxy respond with no special-casing

## 7. Docs and review

- [x] 7.1 [docs] `docs/plugins.md`: manifest format, directory layout and
  scopes, env contract, proxy namespace, bridge message shapes, trust
  model ("install only what you trust", token exposure), OpenSpec plugin
  install walkthrough
- [x] 7.2 [docs] Update `docs/http-api.md` (`/v1/plugins` listing + proxy
  namespace + SSE event) and `docs/install.md` (plugins section of
  daemon.yaml)
- [x] 7.3 [review] Post-implementation review pass: contract surface
  matches specs, no engine/store coupling leaked in, proxy hardening
  checklist (headers, traversal, envelopes)
