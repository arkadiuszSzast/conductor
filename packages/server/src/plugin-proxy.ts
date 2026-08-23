/**
 * Plugin listing + reverse proxy — the API-facing half of the plugin
 * runtime (plugin-runtime spec, design D2/D4). `createPluginControl`
 * wires a `PluginRegistry` (what plugins exist) and a `PluginSupervisor`
 * (what state they are in / where their backend listens) into the
 * `PluginControl` shape `ApiDeps.plugins` expects; `proxyPluginRequest`
 * performs the actual relay for a resolved target.
 *
 * ID resolution across scopes (a project plugin and a global plugin MAY
 * share an id): with `?project=<id>` supplied, resolution is SCOPED —
 * that project's own plugin wins if it exists, else the global plugin
 * (mirroring `PluginRegistry.listPlugins`'s shadowing). Without a
 * `project` query param, resolution is GLOBAL-FIRST — the first global
 * plugin with that id, else the first project plugin with that id in
 * registration order. This is deterministic and simple, not a full
 * "search every project" scan: a proxy request without a project hint
 * is assumed to target a global (or the only) plugin; a project-scoped
 * plugin should always be addressed with `?project=`.
 */

import { join } from "node:path"
import type { DiscoveredPlugin, PluginDiagnostic, PluginListing, PluginRegistry, PluginScope, PluginState, PluginStateKey, PluginStateLookup } from "./plugin-registry.ts"
import { serveStaticFile } from "./static-files.ts"

/** The read surface `createPluginControl` needs from a supervisor —
 *  `PluginSupervisor` satisfies this structurally; tests can fake it
 *  without constructing a real one. */
export interface PluginSupervisorView {
  readonly stateOf: PluginStateLookup
  portOf(key: PluginStateKey): number | null
  /** The runtime diagnostic (crash/exhaustion detail) for a plugin
   *  currently in `error` state; `null`/absent otherwise. Optional so
   *  fakes that never produce an `error` state need not implement it. */
  diagnosticOf?(key: PluginStateKey): PluginDiagnostic | null
  onStateChange(callback: (key: PluginStateKey) => void): () => void
}

export interface PluginListingPayload {
  readonly enabled: boolean
  readonly plugins: readonly PluginListing[]
  /** Load-level diagnostics (broken manifests, conflicts) not tied to one registered plugin. */
  readonly diagnostics: readonly PluginDiagnostic[]
}

export interface PluginTarget {
  readonly id: string
  readonly scope: PluginScope
  readonly dir: string
  readonly hasBackend: boolean
  readonly state: PluginState
  readonly port: number | null
}

export type PluginResolveResult =
  | { readonly ok: true; readonly target: PluginTarget }
  | { readonly ok: false }

/** The API-facing plugin surface `ApiDeps.plugins` consumes. Absent → the listing and proxy routes 404. */
export interface PluginControl {
  listing(project?: string): PluginListingPayload
  resolve(id: string, project?: string): PluginResolveResult
  /** Subscribe to any plugin state change. Returns an unsubscribe function. */
  subscribe(callback: () => void): () => void
}

function targetOf(plugin: DiscoveredPlugin, supervisor: PluginSupervisorView, disabledIds: ReadonlySet<string>): PluginTarget {
  const key: PluginStateKey = { scope: plugin.scope, id: plugin.id, ...(plugin.projectId !== undefined ? { projectId: plugin.projectId } : {}) }
  const state: PluginState = disabledIds.has(plugin.id) ? "disabled" : supervisor.stateOf(key) ?? "stopped"
  return {
    id: plugin.id,
    scope: plugin.scope,
    dir: plugin.dir,
    hasBackend: plugin.manifest.backend !== undefined,
    state,
    port: supervisor.portOf(key),
  }
}

/** Merges the supervisor's runtime diagnostic (crash/exhaustion detail,
 *  set only while a plugin is in `error` state) into a listing entry's
 *  own manifest-level diagnostics (shadowing, conflicts) — otherwise a
 *  parked/errored plugin lists with no explanation of its failure. */
function withRuntimeDiagnostic(entry: PluginListing, supervisor: PluginSupervisorView): PluginListing {
  const key: PluginStateKey = { scope: entry.scope, id: entry.id, ...(entry.project !== undefined ? { projectId: entry.project } : {}) }
  const runtime = supervisor.diagnosticOf?.(key) ?? null
  if (runtime === null) return entry
  return { ...entry, diagnostics: [...entry.diagnostics, runtime] }
}

export function createPluginControl(registry: PluginRegistry, supervisor: PluginSupervisorView): PluginControl {
  return {
    listing(project) {
      return {
        enabled: true,
        plugins: registry.listPlugins(project, supervisor.stateOf).map(entry => withRuntimeDiagnostic(entry, supervisor)),
        diagnostics: registry.loadDiagnostics(),
      }
    },

    resolve(id, project) {
      const all = registry.list()
      const disabledIds = registry.disabledIds()
      let plugin: DiscoveredPlugin | undefined
      if (project !== undefined) {
        plugin = all.find(candidate => candidate.scope === "project" && candidate.projectId === project && candidate.id === id)
          ?? all.find(candidate => candidate.scope === "global" && candidate.id === id)
      } else {
        plugin = all.find(candidate => candidate.scope === "global" && candidate.id === id)
          ?? all.find(candidate => candidate.scope === "project" && candidate.id === id)
      }
      if (plugin === undefined) return { ok: false }
      return { ok: true, target: targetOf(plugin, supervisor, disabledIds) }
    },

    subscribe(callback) {
      return supervisor.onStateChange(() => callback())
    },
  }
}

export type PluginProxyResult =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable"; readonly message: string }

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
])

function filteredHeaders(source: Headers, options: { readonly stripAuthorization: boolean; readonly stripCookie?: boolean }): Headers {
  const headers = new Headers()
  for (const [key, value] of source) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower.startsWith("proxy-")) continue
    if (options.stripAuthorization && lower === "authorization") continue
    if (options.stripCookie === true && lower === "cookie") continue
    headers.append(key, value)
  }
  return headers
}

/**
 * Serves a static-only plugin's `ui/` route. `restPath` always starts
 * with `/ui` here (checked by the caller) — the containment root is
 * `<dir>/ui` itself, NOT the plugin directory: the plugin directory also
 * holds `plugin.yaml` and (for a plugin with a backend elsewhere on
 * disk) source files that must never be reachable through this route,
 * so `<dir>/ui` is where traversal containment is anchored, and only the
 * portion of the path AFTER the `/ui` prefix is resolved against it.
 * `restPath === "/ui"` (no trailing slash — the SPA's own trailing-slash
 * stripping in `api.ts`'s `handle()` produces exactly this for a client
 * request to the plugin's UI root) and `"/ui/"` both mean "the ui
 * directory's own root" and fall back to `index.html`, mirroring the SPA
 * static mount's own index fallback (`api.ts`'s `serveStatic`) — without
 * it, a plugin's root panel route 404s instead of loading its shell.
 */
function serveStaticUi(uiRoot: string, restPath: string, requestId: string): Response | null {
  const relative = restPath === "/ui" ? "/" : restPath.slice("/ui".length)
  const served = serveStaticFile(uiRoot, relative, requestId)
  if (served !== null) return served
  if (relative === "/" || relative === "") return serveStaticFile(uiRoot, "/index.html", requestId)
  return null
}

/**
 * Proxies (or statically serves) a resolved plugin target for the
 * request's remaining path (`restPath`, always starting with `/`, empty
 * string meaning the plugin's root). `disabled`/unknown ids are the
 * caller's job (`resolve()` returning `ok: false`, or `target.state ===
 * "disabled"`) — this function only handles a target that IS addressable.
 */
export async function proxyPluginRequest(
  target: PluginTarget,
  restPath: string,
  request: Request,
  requestId: string,
): Promise<PluginProxyResult> {
  if (target.state === "disabled") return { kind: "not_found" }

  if (!target.hasBackend) {
    if (!restPath.startsWith("/ui/") && restPath !== "/ui") return { kind: "not_found" }
    const served = serveStaticUi(join(target.dir, "ui"), restPath, requestId)
    return served !== null ? { kind: "response", response: served } : { kind: "not_found" }
  }

  if (target.port === null) {
    return { kind: "unavailable", message: `plugin "${target.id}" backend is not running (state: ${target.state})` }
  }

  // The query string is passed through unmodified: the proxy route in
  // `api.ts` reads its OWN `?project=` for target resolution (it never
  // strips it from `request.url` before this call), so a plugin backend
  // that also wants to see `project` (or any other query param a panel
  // fetch attaches) gets it verbatim — harmless, since the daemon's own
  // resolution already happened before this point, and it is the only
  // way a query param an operator relies on (e.g. `openspec`'s panel
  // preserving its own page's query string on `../changes`) reaches the
  // backend at all.
  const search = new URL(request.url).search
  const upstreamUrl = `http://127.0.0.1:${target.port}${restPath === "" ? "/" : restPath}${search}`
  const headers = filteredHeaders(request.headers, { stripAuthorization: true, stripCookie: true })
  const hasBody = request.method !== "GET" && request.method !== "HEAD"
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body } : {}),
    })
    const responseHeaders = filteredHeaders(upstreamResponse.headers, { stripAuthorization: false })
    responseHeaders.set("x-request-id", requestId)
    return {
      kind: "response",
      response: new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders }),
    }
  } catch (error) {
    return { kind: "unavailable", message: `plugin "${target.id}" backend is unreachable: ${errorMessage(error)}` }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
