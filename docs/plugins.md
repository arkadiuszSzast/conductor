# Plugins

A plugin extends the Control Room with an optional panel and, optionally, a
backend process the daemon supervises. Plugins are opt-in, discovered from
plain directories, and interact with Conductor **only** through the same
public HTTP API any third-party client uses.

A plugin is:

- a directory with a `plugin.yaml` manifest,
- an optional backend — any executable that binds a port and serves HTTP,
- an optional static UI (a `ui/` directory) rendered as a panel in the
  Control Room's right-side panel rail, inside a sandboxed iframe.

A plugin is **not**:

- an engine hook — the interpreter and reconciler are unaware plugins
  exist,
- a way to reach the daemon's SQLite database directly,
- a way to register custom workflow actions or CLI commands.

A plugin backend receives the daemon's base URL and an API token
(`CONDUCTOR_URL`/`CONDUCTOR_TOKEN`) and calls `/v1/...` exactly like the CLI
or the Control Room itself — see [HTTP API](http-api.md).

## Directory layout and scopes

The daemon discovers plugins from two scopes:

| Scope | Location |
|---|---|
| global | `<config-dir>/plugins/<id>/plugin.yaml` — `<config-dir>` is the daemon's platform config directory (`~/.config/conductor` by default; see [Install](install.md)) |
| project | `<project-root>/.conductor/plugins/<id>/plugin.yaml` for each project registered with the daemon |

A project plugin is visible only when that project is in scope. When a
project plugin and a global plugin share an `id`, **the project plugin
shadows the global one** for that project — other projects still see the
global plugin, and the shadowing is recorded as an informational
diagnostic. Two plugins with the same `id` discovered in the *same* scope
are a conflict: both are skipped, and a diagnostic names the offending
directories.

`daemon.yaml`'s `plugins.paths` adds extra absolute search roots scanned as
part of the *global* scope (see [Install](install.md#plugins)).

Plugin directories and `plugin.yaml` files must be regular files/
directories, never symlinks — a symlinked plugin is rejected with a
diagnostic, not silently followed. This is why the install walkthrough
below uses a copy, not `ln -s`.

Manifests are capped at 1 MiB; a broken plugin (unreadable, oversized,
malformed YAML, missing required fields, unsupported schema version, id/
directory mismatch) is skipped with a diagnostic — it never stops the
daemon from starting or keeps its valid siblings out of the listing.

## Manifest reference

Every field, based on the bundled OpenSpec plugin's `plugins/openspec/plugin.yaml`:

```yaml
plugin: openspec       # id — kebab-case, must match the directory name
version: 1             # manifest schema version (integer >= 1)
panel:
  title: OpenSpec       # required, non-empty
  icon: list-checks     # optional, string (icon token interpreted by the web UI)
backend:                # optional — omit for a static-only plugin
  run: [bun, serve.ts]  # non-empty argv, spawned with cwd = the plugin directory
capabilities: [process, filesystem, network]  # optional, informational only
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `plugin` | string | yes | kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`); must equal the plugin's directory name or the manifest is rejected. `session` is reserved (`/v1/plugins/session` is the cookie-exchange route) and rejected at scan time |
| `version` | integer | yes | must be `>= 1`; a version greater than the daemon's supported version (currently `1`) is skipped with a diagnostic |
| `panel.title` | string | yes | non-empty; shown as the rail tab label |
| `panel.icon` | string | no | opaque icon token; the web UI falls back to the title's first letter when absent |
| `backend.run` | string[] | only with `backend` | non-empty command + arguments; presence of `backend` at all is what makes a plugin "has a backend" for proxy/state purposes |
| `capabilities` | string[] | no | drawn from the shared action capability vocabulary: `filesystem`, `process`, `network`, `git`, `credentials`; unknown values are rejected. See [Trust model](#auth-and-trust-model) — this is declared intent, not enforcement |

Unknown top-level or nested fields are rejected (with a "did you mean"
suggestion when close to a known field), same strictness as
`conductor.yaml` and action manifests.

## Backend contract

For a plugin whose manifest declares `backend`, the daemon spawns the
argv with the plugin's directory as its working directory and these
environment variables:

| Variable | Always set? | Meaning |
|---|---|---|
| `CONDUCTOR_PLUGIN_PORT` | yes | TCP port, OS-assigned (bind port 0, read back — never configured), that the backend MUST bind on `127.0.0.1` |
| `CONDUCTOR_URL` | yes | the daemon's own base URL |
| `CONDUCTOR_TOKEN` | only when `auth.mode: bearer` | the daemon's bearer token — omitted entirely under `auth.mode: none` |
| `CONDUCTOR_PROJECT_DIR` | only for project-scoped plugins | the owning project's root directory |

The backend's runtime is unconstrained: any executable that binds the given
port on loopback qualifies (the bundled example is a `bun` script; nothing
requires that).

A plugin with **no** `backend` is static-only: no process is spawned, and
its listing state is reported `running` whenever it is enabled (there is no
process lifecycle to reflect). Its UI is served straight from its
directory's `ui/` subdirectory — and ONLY that subdirectory, never
`plugin.yaml` or any other file alongside it — through the same hardened
static-file rules the daemon uses for the SPA (path traversal rejected,
including encoded traversal sequences). The route's own root
(`/v1/plugins/<id>/ui/` or `/v1/plugins/<id>/ui`) falls back to
`ui/index.html`, same as the SPA's own index fallback.

### Lifecycle

- A crashed backend is restarted with exponential backoff (1s initial
  delay, doubling, capped at 60s, no jitter) up to 5 total attempts
  (including the first).
- Exhausting the restart budget parks the plugin in state `error` with a
  diagnostic (last exit code/signal plus a short stderr tail); the daemon
  keeps running and its own health endpoints are unaffected.
- On daemon shutdown every live plugin process is sent `SIGTERM`, given a
  5-second grace period, then `SIGKILL`ed if still alive.

## The proxy namespace

The daemon reverse-proxies `/v1/plugins/<id>/...` to the plugin's backend
(or serves it statically for a backend-less plugin), stripping the
`/v1/plugins/<id>` prefix so the backend sees root-relative paths — a
request to `/v1/plugins/openspec/changes` reaches the backend as
`GET /changes`. See [HTTP API — plugins](http-api.md#plugins) for the full
route/error-envelope reference; the header hygiene and auth rules that
matter to a plugin author:

- the daemon's `Authorization` header is **never** forwarded to the
  backend — a plugin backend that needs to call the API back uses its own
  `CONDUCTOR_TOKEN`, not anything from the inbound request,
- the client's `Cookie` header is **never** forwarded to the backend
  either — the plugin-session cookie authorizes every plugin's routes and
  the listing, not just this one, so leaking it to a backend would hand
  that backend a credential that works against every other plugin too,
- hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`,
  `Upgrade`, `TE`, `Trailer`) and any `Proxy-*` header are stripped in both
  directions,
- request bodies are streamed through unmodified,
- the request's query string (e.g. `?project=<id>`) is forwarded to the
  backend verbatim alongside the stripped path,
- a request path is normalized (trailing slashes stripped) before
  routing, so `GET /v1/plugins/<id>/changes/` and `GET
  /v1/plugins/<id>/changes` both reach the backend as `GET /changes`,
- a disabled or unknown plugin id, or one whose backend isn't running,
  never hangs — it answers a `not_found` or `unavailable` error envelope.

## Panel and bridge contract

Opening a plugin's tab renders an iframe at
`/v1/plugins/<id>/ui/` — same-origin with the Control Room SPA, so no CORS
configuration is needed. The iframe carries
`sandbox="allow-scripts allow-same-origin allow-forms"`: scripts and
same-origin requests are permitted, top-level navigation is not. When the
plugin's state is `error` or the iframe fails to load, the panel shows an
inline diagnostic and a retry button instead of a broken frame.

### Message protocol v1

Every message is wrapped in an envelope:

```json
{ "conductor": true, "v": 1, "type": "<type>", "payload": { ... } }
```

The `conductor: true` discriminator keeps this protocol from colliding
with unrelated `postMessage` traffic (browser extensions, devtools)
sharing the same window. Either side drops silently — never throws, never
surfaces an error to the plugin — any envelope missing the discriminator,
carrying an unsupported `v`, or whose `payload` doesn't match its `type`.

Panel → host:

| `type` | `payload` | Meaning |
|---|---|---|
| `ready` | `{ "v": 1 }` | sent once on panel startup; the host replies with `context` |
| `navigate` | `{ "to": { "feature"?: string } }` | ask the host to navigate the Control Room to a feature's view; the panel stays open |
| `refresh` | `{}` | ask the host to refetch the plugin listing |

Host → panel:

| `type` | `payload` | Meaning |
|---|---|---|
| `context` | `BridgeContextPayload` (below) | sent once, in reply to `ready` |
| `context-changed` | `BridgeContextPayload` (below) | pushed whenever the active project, selection, or theme changes while the panel is open |

```ts
interface BridgeContextPayload {
  project: string | null
  selection: { feature: string | null }
  theme: { mode: "dark" }
}
```

The host validates inbound `postMessage` events by **both** origin (must be
`window.location.origin`) and source (must be the specific iframe's
`contentWindow`) — a same-origin message from an unrelated frame is never
mistaken for the panel's.

### Panel network calls

A panel's own fetches should be **relative to its own route**, e.g.
`fetch("../changes")` from a script served at
`/v1/plugins/<id>/ui/app.js` resolves to `/v1/plugins/<id>/changes` — the
plugin's own backend, reached through the same proxy the iframe itself
loaded through, authenticated by the plugin-session cookie (see below).
Do not hardcode `/v1/plugins/<id>/...` — the bundled OpenSpec panel's
`app.js` uses this relative-fetch convention.

## Auth and trust model

`CONDUCTOR_TOKEN` handed to a plugin backend is the same daemon token any
external client would use — it is **not** scoped or limited to the
plugin's own routes. A malicious or buggy plugin backend with that token
can do anything an authenticated API client can do. **Install only
plugins you trust**, exactly as you would trust any process you run
locally with your credentials.

`capabilities` in the manifest are **declared intent**, informational
metadata for a human reviewing what a plugin claims to need — the daemon
does not enforce them, does not sandbox the backend process, and does not
restrict its filesystem or network access beyond what the OS itself
allows the spawned process. The iframe sandbox is the only enforced
boundary, and it only constrains the panel's UI code, not the backend
process — and even there, a same-origin iframe is not a hard security
boundary against a hostile plugin UI (it could still reach
`window.parent`). This is the honest v1 posture, not an oversight: it is
identical to the backend process's own trust level.

Because iframe navigations and panel-originated `fetch` calls cannot
attach an `Authorization` header, the daemon offers a **cookie exchange**
scoped narrowly to the plugin namespace:

- `POST /v1/plugins/session` (itself bearer-authenticated, or free under
  `auth.mode: none`) mints an opaque session value and returns it as a
  `Set-Cookie: conductor_plugin_session=<value>` with `Path=/v1/plugins`,
  `HttpOnly`, `SameSite=Strict`, `Max-Age=43200` (12 hours).
- The daemon accepts **either** the bearer header **or** this cookie for
  any `/v1/plugins/...` request — nowhere else. The cookie presented on,
  say, `/v1/features` does not authorize it.
- Sessions live in memory only; a daemon restart invalidates every issued
  cookie, and the SPA simply re-exchanges after login.

The token itself never crosses the bridge: `BridgeContextPayload` carries
only `project`/`selection`/`theme`, and a panel's data access goes through
its own proxied backend routes, which authenticate with `CONDUCTOR_TOKEN`
server-side.

Known residual risks, accepted under the trust model above:

- Symlinks **inside** a plugin's `ui/` directory are followed when serving
  static files (the registry rejects a symlinked plugin directory or
  manifest, but does not police files within `ui/`). A static-only plugin
  could ship a symlink pointing at host files.
- A backend's `Set-Cookie` response headers are relayed to the client. A
  hostile backend cannot forge an authorized plugin session (values are
  validated server-side), but it could clobber the browser's session
  cookie (the SPA re-exchanges) or plant cookies on the daemon origin.
- Request headers other than `Authorization` and `Cookie` are forwarded to
  backends as-is (denylist, not allowlist).

## Installing the bundled OpenSpec plugin

The repository ships a reference plugin at `plugins/openspec/` — it reads
a project's `openspec/` tree and offers a "start work" action, and it is
installed exactly the way a third-party plugin would be, with no
special-casing.

`conductor init` does **not** install it automatically. Copy it into the
target project's project-scoped plugin directory:

```sh
cp -r /path/to/conductor/plugins/openspec /path/to/my-project/.conductor/plugins/openspec
```

Do **not** symlink it — the registry rejects symlinked plugin directories
with a diagnostic (this is also why `plugin-e2e.test.ts` copies the
fixture rather than linking it).

Once the daemon (re)discovers the project (restart, or register the
project again), `GET /v1/plugins?project=<dir>` lists `openspec` with
`scope: "project"`. The daemon spawns `bun serve.ts` from the plugin
directory with `CONDUCTOR_PROJECT_DIR` set to the project root.

In the Control Room, an "OpenSpec" tab appears in the right-side panel
rail whenever that project is the active scope. Opening it shows:

- active changes with task progress (done/total, parsed from
  `tasks.md` checkboxes),
- archived changes,
- a "Start work" button per active change.

Clicking "Start work" calls the plugin's `/start-work` route, which reads
the change's `proposal.md` (its "Why" section becomes the feature
description) and creates a Conductor feature through the public
`POST /v1/features` API using the daemon token the supervisor gave it —
then the panel navigates the Control Room to the new feature via the
bridge's `navigate` message. A project with no `openspec/` root gets an
explanatory empty state, never an error.
