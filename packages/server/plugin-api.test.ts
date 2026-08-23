/**
 * Plugin listing + proxy routes wired into the API (`ApiDeps.plugins`):
 * auth enforced before proxying, prefix stripping, header hygiene
 * (Authorization never forwarded, hop-by-hop stripped), unknown/
 * disabled/down-backend error envelopes, static-only `ui/` serving with
 * traversal rejection, project-filtered listing, and the absent-dep 404.
 * A real ephemeral `Bun.serve` stands in for a plugin backend so the
 * proxy is exercised over an actual loopback socket, matching
 * `api-integration.test.ts`'s style for anything crossing a real
 * transport. Also covers the plugin-session cookie exchange (design D5,
 * plugin-runtime spec "Cookie unlocks the iframe under bearer auth").
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon, type DaemonLogEntry } from "./src/daemon.ts"
import { createApi, type ApiConfig, type ConductorApi } from "./src/api.ts"
import { createPluginControl } from "./src/plugin-proxy.ts"
import type { PluginSupervisorView } from "./src/plugin-proxy.ts"
import { PluginRegistry } from "./src/plugin-registry.ts"
import type { PluginDiagnostic, PluginState, PluginStateKey } from "./src/plugin-registry.ts"
import type { SessionClient } from "./src/ports.ts"

class FakeSessions implements SessionClient {
  async createSession(): Promise<{ id: string }> {
    return { id: "ses-1" }
  }
  async prompt(): Promise<void> {}
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(): Promise<"busy" | "idle" | "retry" | "missing"> {
    return "busy"
  }
  async note(): Promise<void> {}
}

class CollectingLogger {
  entries: DaemonLogEntry[] = []
  log(entry: DaemonLogEntry): void {
    this.entries.push(entry)
  }
}

/** A controllable stand-in for `PluginSupervisor` — state/port per key
 *  set directly by the test, `onStateChange` fires on demand so the SSE
 *  wiring test can trigger it without a real supervisor. */
class FakeSupervisor implements PluginSupervisorView {
  private readonly states = new Map<string, PluginState>()
  private readonly ports = new Map<string, number>()
  private readonly diagnostics = new Map<string, PluginDiagnostic>()
  private readonly listeners = new Set<(key: PluginStateKey) => void>()

  private k(key: PluginStateKey): string {
    return `${key.scope}:${key.projectId ?? ""}:${key.id}`
  }

  setState(key: PluginStateKey, state: PluginState): void {
    this.states.set(this.k(key), state)
  }

  setPort(key: PluginStateKey, port: number): void {
    this.ports.set(this.k(key), port)
  }

  setDiagnostic(key: PluginStateKey, diagnostic: PluginDiagnostic): void {
    this.diagnostics.set(this.k(key), diagnostic)
  }

  fireChange(key: PluginStateKey): void {
    for (const listener of this.listeners) listener(key)
  }

  readonly stateOf = (key: PluginStateKey): PluginState | undefined => this.states.get(this.k(key))

  portOf(key: PluginStateKey): number | null {
    return this.ports.get(this.k(key)) ?? null
  }

  diagnosticOf(key: PluginStateKey): PluginDiagnostic | null {
    return this.diagnostics.get(this.k(key)) ?? null
  }

  onStateChange(callback: (key: PluginStateKey) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
}

const temporaryDirectories: string[] = []
const daemonsToStop: Daemon[] = []
const apisToClose: ConductorApi[] = []
const backendsToStop: Array<{ stop(): Promise<unknown> }> = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(async () => {
  for (const api of apisToClose.splice(0)) api.close()
  for (const daemon of daemonsToStop.splice(0)) await daemon.stop()
  for (const backend of backendsToStop.splice(0)) await backend.stop()
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const agentWorkflow = `
name: agent-only
on: [manual]
roles:
  implementer: { agent: build }
jobs:
  main:
    steps:
      - id: implement
        agent:
          role: implementer
          prompt: "Implement it."
`

function writeProject(): string {
  const project = tempDir("conductor-plugin-api-project-")
  writeFileSync(join(project, "conductor.yaml"), agentWorkflow)
  return project
}

function manifestSource(id: string, opts: { backend?: boolean; title?: string } = {}): string {
  const backend = opts.backend
    ? `backend:\n  run: ["node", "serve.js"]\n`
    : ""
  return `plugin: ${id}\nversion: 1\npanel:\n  title: ${opts.title ?? id}\n${backend}`
}

function writePlugin(root: string, id: string, opts: { backend?: boolean; title?: string; ui?: Record<string, string> } = {}): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "plugin.yaml"), manifestSource(id, opts))
  if (opts.ui !== undefined) {
    const uiDir = join(dir, "ui")
    mkdirSync(uiDir, { recursive: true })
    for (const [name, content] of Object.entries(opts.ui)) {
      const filePath = join(uiDir, name)
      mkdirSync(join(filePath, ".."), { recursive: true })
      writeFileSync(filePath, content)
    }
  }
  return dir
}

interface Stack {
  api: ConductorApi
  daemon: Daemon
  project: string
  supervisor: FakeSupervisor
  registry: PluginRegistry
  request: (method: string, path: string, headers?: Record<string, string>, body?: string) => Promise<Response>
}

async function makeStack(input: {
  plugins?: (globalDir: string, project: string) => Promise<void> | void
  auth?: ApiConfig["auth"]
  withPluginsDep?: boolean
}): Promise<Stack> {
  const project = writeProject()
  const globalDir = tempDir("conductor-plugin-api-global-")
  await input.plugins?.(globalDir, project)

  const registry = await PluginRegistry.scan({
    globalDir,
    projects: [{ id: "proj-1", root: project }],
  })
  const supervisor = new FakeSupervisor()

  const sessions = new FakeSessions()
  const logger = new CollectingLogger()
  const daemon = new Daemon(
    { databasePath: join(tempDir("conductor-plugin-api-db-"), "state.db"), projects: [project], heartbeatIntervalMs: 60_000 },
    { sessions, logger, scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
  )
  daemonsToStop.push(daemon)
  await daemon.start()

  const api = createApi(
    { bind: { host: "127.0.0.1", port: 0 }, auth: input.auth ?? { mode: "none" } },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      workflowStatus: dir => daemon.registry.getStatus(dir),
      logger,
      ...(input.withPluginsDep === false ? {} : { plugins: createPluginControl(registry, supervisor) }),
    },
  )
  apisToClose.push(api)

  const request = (method: string, path: string, headers?: Record<string, string>, body?: string) =>
    api.handle(new Request(`http://conductor.test${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }))

  return { api, daemon, project, supervisor, registry, request }
}

async function startFakeBackend(handler: (req: Request) => Response | Promise<Response>): Promise<{ port: number; stop(): Promise<void>; requests: Request[] }> {
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(req)
      return handler(req)
    },
  })
  backendsToStop.push({ stop: () => server.stop(true) })
  return { port: server.port!, stop: () => server.stop(true), requests }
}

describe("plugins dependency absent", () => {
  it("404s the listing and proxy routes when ApiDeps.plugins is not supplied", async () => {
    const { request } = await makeStack({ withPluginsDep: false })
    const listing = await request("GET", "/v1/plugins")
    expect(listing.status).toBe(404)
    const proxied = await request("GET", "/v1/plugins/openspec/changes")
    expect(proxied.status).toBe(404)
  })
})

describe("GET /v1/plugins listing", () => {
  it("lists a global plugin with its state and diagnostics", async () => {
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")

    const response = await request("GET", "/v1/plugins")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { enabled: boolean; plugins: Array<{ id: string; state: string; scope: string }> }
    expect(body.enabled).toBe(true)
    expect(body.plugins).toHaveLength(1)
    expect(body.plugins[0]).toMatchObject({ id: "openspec", scope: "global", state: "running" })
  })

  it("filters the listing by project, applying shadowing", async () => {
    const { request, project } = await makeStack({
      plugins: (globalDir, projectDir) => {
        writePlugin(globalDir, "global-only", {})
        writePlugin(join(projectDir, ".conductor", "plugins"), "proj-only", {})
      },
    })

    const scoped = await request("GET", `/v1/plugins?project=proj-1`)
    const scopedBody = (await scoped.json()) as { plugins: Array<{ id: string }> }
    expect(scopedBody.plugins.map(p => p.id).sort()).toEqual(["global-only", "proj-only"])

    const other = await request("GET", `/v1/plugins?project=other-project`)
    const otherBody = (await other.json()) as { plugins: Array<{ id: string }> }
    expect(otherBody.plugins.map(p => p.id)).toEqual(["global-only"])
    void project
  })

  it("surfaces the supervisor's runtime diagnostic for a parked/error plugin (M4)", async () => {
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "error")
    supervisor.setDiagnostic(
      { scope: "global", id: "openspec" },
      { path: "/plugins/openspec", message: 'plugin "openspec" backend crashed 5 time(s) (last: exit code 1); restart budget exhausted' },
    )

    const response = await request("GET", "/v1/plugins")
    const body = (await response.json()) as { plugins: Array<{ id: string; state: string; diagnostics: Array<{ message: string }> }> }
    const entry = body.plugins.find(p => p.id === "openspec")
    expect(entry?.state).toBe("error")
    expect(entry?.diagnostics.some(d => d.message.includes("restart budget exhausted"))).toBe(true)
  })
})

describe("proxy: auth boundary", () => {
  it("rejects an unauthenticated proxy request before the backend is ever hit", async () => {
    const backend = await startFakeBackend(() => new Response("should not be reached"))
    const { request, supervisor } = await makeStack({
      auth: { mode: "bearer", token: "secret-token" },
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes")
    expect(response.status).toBe(401)
    expect(backend.requests).toHaveLength(0)
  })

  it("proxies once the correct bearer token is presented", async () => {
    const backend = await startFakeBackend(() => new Response("ok"))
    const { request, supervisor } = await makeStack({
      auth: { mode: "bearer", token: "secret-token" },
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes", { authorization: "Bearer secret-token" })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(backend.requests).toHaveLength(1)
  })
})

describe("proxy: prefix stripping and body/header hygiene", () => {
  it("strips the /v1/plugins/<id> prefix so the backend sees the root-relative path", async () => {
    const backend = await startFakeBackend(req => new Response(new URL(req.url).pathname))
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes")
    expect(await response.text()).toBe("/changes")
  })

  it("never forwards the Authorization header to the backend", async () => {
    const backend = await startFakeBackend(req => new Response(req.headers.get("authorization") ?? "none"))
    const { request, supervisor } = await makeStack({
      auth: { mode: "bearer", token: "secret-token" },
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes", { authorization: "Bearer secret-token" })
    expect(await response.text()).toBe("none")
  })

  it("strips hop-by-hop response headers from the backend's response", async () => {
    const backend = await startFakeBackend(() =>
      new Response("ok", {
        headers: {
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "x-custom": "keep-me",
        },
      }),
    )
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes")
    expect(response.headers.get("connection")).toBeNull()
    expect(response.headers.get("keep-alive")).toBeNull()
    expect(response.headers.get("transfer-encoding")).toBeNull()
    expect(response.headers.get("x-custom")).toBe("keep-me")
  })

  it("relays method and body through to the backend", async () => {
    const backend = await startFakeBackend(async req => new Response(`${req.method}:${await req.text()}`))
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("POST", "/v1/plugins/openspec/start-work", { "content-type": "application/json" }, JSON.stringify({ a: 1 }))
    expect(await response.text()).toBe('POST:{"a":1}')
  })

  it("passes the request's query string through to the backend intact (M3)", async () => {
    const backend = await startFakeBackend(req => new Response(new URL(req.url).pathname + new URL(req.url).search))
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes?project=proj-1&foo=bar")
    expect(await response.text()).toBe("/changes?project=proj-1&foo=bar")
  })

  it("never forwards the cookie header to the backend (M6 — the plugin-session cookie authorizes ALL plugins, not just this one)", async () => {
    const backend = await startFakeBackend(req => new Response(req.headers.get("cookie") ?? "none"))
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes", { cookie: "conductor_plugin_session=whatever" })
    expect(await response.text()).toBe("none")
  })
})

describe("proxy: error envelopes", () => {
  it("unknown plugin id maps to not_found", async () => {
    const { request } = await makeStack({})
    const response = await request("GET", "/v1/plugins/nope/changes")
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("not_found")
  })

  it("disabled plugin maps to not_found, backend never hit", async () => {
    const backend = await startFakeBackend(() => new Response("should not be reached"))
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "disabled")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const response = await request("GET", "/v1/plugins/openspec/changes")
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("not_found")
    expect(backend.requests).toHaveLength(0)
  })

  it("a backend declared but not currently running maps to unavailable", async () => {
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "error")
    // No port set — the supervisor reports null when nothing is alive.

    const response = await request("GET", "/v1/plugins/openspec/changes")
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("unavailable")
  })

  it("a stale port whose backend has actually crashed maps to unavailable via connection failure", async () => {
    const { request, supervisor } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    // A port nothing listens on — simulates a crashed backend whose last
    // known port the supervisor has not yet cleared.
    supervisor.setPort({ scope: "global", id: "openspec" }, 1)

    const response = await request("GET", "/v1/plugins/openspec/changes")
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("unavailable")
  })
})

describe("proxy: static-only plugins", () => {
  it("serves a file under ui/ for a plugin with no backend", async () => {
    const { request } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "static-only", { ui: { "index.html": "<html>hi</html>" } })
      },
    })

    const response = await request("GET", "/v1/plugins/static-only/ui/index.html")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<html>hi</html>")
  })

  it("rejects a traversal attempt outside the plugin's ui/ directory", async () => {
    // Real `..` segments are normalized away by the URL constructor
    // before routing ever sees them — the guard is exercised with a
    // percent-encoded traversal payload, matching the SPA static-serving
    // traversal test's convention (api.test.ts "rejects path traversal").
    const { request } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "static-only", { ui: { "index.html": "<html>hi</html>" } })
      },
    })
    for (const path of [
      "/v1/plugins/static-only/ui/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
      "/v1/plugins/static-only/ui/..%2f..%2f..%2fsecret.txt",
    ]) {
      const response = await request("GET", path)
      const text = await response.text()
      expect(text).not.toContain("top secret")
      expect(response.status).not.toBe(200)
    }
  })

  it("rejects an encoded traversal from ui/ into the plugin's OWN directory (M1 regression — plugin.yaml/serve.ts must stay unreachable)", async () => {
    const { request } = await makeStack({
      plugins: globalDir => {
        const dir = writePlugin(globalDir, "static-only", { ui: { "index.html": "<html>hi</html>" } })
        writeFileSync(join(dir, "secret.env"), "TOP_SECRET=1")
        writeFileSync(join(dir, "serve.ts"), "// backend source, must never be served")
      },
    })
    for (const path of [
      "/v1/plugins/static-only/ui/..%2Fsecret.env",
      "/v1/plugins/static-only/ui/%2e%2e/secret.env",
      "/v1/plugins/static-only/ui/..%2Fplugin.yaml",
      "/v1/plugins/static-only/ui/..%2Fserve.ts",
    ]) {
      const response = await request("GET", path)
      const text = await response.text()
      expect(text).not.toContain("TOP_SECRET")
      expect(text).not.toContain("backend source")
      expect(response.status).not.toBe(200)
    }
  })

  it("404s a non-ui path on a static-only plugin", async () => {
    const { request } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "static-only", { ui: { "index.html": "<html>hi</html>" } })
      },
    })

    const response = await request("GET", "/v1/plugins/static-only/changes")
    expect(response.status).toBe(404)
  })

  it("serves ui/index.html for the plugin's bare root ui route (M2 — no trailing slash after api.ts's normalization)", async () => {
    const { request } = await makeStack({
      plugins: globalDir => {
        writePlugin(globalDir, "static-only", { ui: { "index.html": "<html>root</html>" } })
      },
    })

    // api.ts strips trailing slashes from `path`, so a client request to
    // `/v1/plugins/static-only/ui/` is routed with `restPath === "/ui"` —
    // this must resolve to `ui/index.html`, not 404.
    const bare = await request("GET", "/v1/plugins/static-only/ui")
    expect(bare.status).toBe(200)
    expect(await bare.text()).toBe("<html>root</html>")

    const trailing = await request("GET", "/v1/plugins/static-only/ui/")
    expect(trailing.status).toBe(200)
    expect(await trailing.text()).toBe("<html>root</html>")
  })
})

function cookieValue(setCookieHeader: string | null): string {
  expect(setCookieHeader).not.toBeNull()
  const match = setCookieHeader!.match(/conductor_plugin_session=([^;]+)/)
  expect(match).not.toBeNull()
  return match![1]!
}

describe("POST /v1/plugins/session", () => {
  it("requires bearer auth for the exchange itself", async () => {
    const { request } = await makeStack({ auth: { mode: "bearer", token: "secret-token" } })
    const response = await request("POST", "/v1/plugins/session")
    expect(response.status).toBe(401)
  })

  it("404s when the plugins dep is absent", async () => {
    const { request } = await makeStack({ withPluginsDep: false })
    const response = await request("POST", "/v1/plugins/session")
    expect(response.status).toBe(404)
  })

  it("sets an HttpOnly, SameSite=Strict cookie scoped to /v1/plugins", async () => {
    const { request } = await makeStack({ auth: { mode: "bearer", token: "secret-token" } })
    const response = await request("POST", "/v1/plugins/session", { authorization: "Bearer secret-token" })
    expect(response.status).toBe(204)
    const setCookie = response.headers.get("set-cookie")
    expect(setCookie).not.toBeNull()
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Strict")
    expect(setCookie).toContain("Path=/v1/plugins")
    expect(setCookie).toMatch(/conductor_plugin_session=[0-9a-f]+/)
  })

  it("succeeds under auth.mode: none without requiring a header", async () => {
    const { request } = await makeStack({ auth: { mode: "none" } })
    const response = await request("POST", "/v1/plugins/session")
    expect(response.status).toBe(204)
  })

  it("rejects a cookie-only exchange request — the cookie cannot mint itself a fresh cookie forever (M5)", async () => {
    const { request } = await makeStack({ auth: { mode: "bearer", token: "secret-token" } })
    const first = await request("POST", "/v1/plugins/session", { authorization: "Bearer secret-token" })
    const cookie = cookieValue(first.headers.get("set-cookie"))

    const renewed = await request("POST", "/v1/plugins/session", { cookie: `conductor_plugin_session=${cookie}` })
    expect(renewed.status).toBe(401)

    // Bearer still works for a fresh exchange.
    const second = await request("POST", "/v1/plugins/session", { authorization: "Bearer secret-token" })
    expect(second.status).toBe(204)
  })
})

describe("plugin-session cookie authorizes the plugin namespace only", () => {
  it("the exchanged cookie authorizes the listing, ui, and proxy routes without a bearer header", async () => {
    const backend = await startFakeBackend(() => new Response("ok"))
    const { request, supervisor } = await makeStack({
      auth: { mode: "bearer", token: "secret-token" },
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true, ui: { "index.html": "<html>hi</html>" } })
      },
    })
    supervisor.setState({ scope: "global", id: "openspec" }, "running")
    supervisor.setPort({ scope: "global", id: "openspec" }, backend.port)

    const exchange = await request("POST", "/v1/plugins/session", { authorization: "Bearer secret-token" })
    const cookie = cookieValue(exchange.headers.get("set-cookie"))
    const cookieHeader = { cookie: `${cookie === "" ? "" : `conductor_plugin_session=${cookie}`}` }

    const listing = await request("GET", "/v1/plugins", cookieHeader)
    expect(listing.status).toBe(200)

    const proxied = await request("GET", "/v1/plugins/openspec/changes", cookieHeader)
    expect(proxied.status).toBe(200)
    expect(await proxied.text()).toBe("ok")
  })

  it("the cookie does NOT authorize /v1/features or any other non-plugin route", async () => {
    const { request } = await makeStack({ auth: { mode: "bearer", token: "secret-token" } })
    const exchange = await request("POST", "/v1/plugins/session", { authorization: "Bearer secret-token" })
    const cookie = cookieValue(exchange.headers.get("set-cookie"))

    const response = await request("GET", "/v1/features", { cookie: `conductor_plugin_session=${cookie}` })
    expect(response.status).toBe(401)
  })

  it("an invalid or unrecognized cookie value does not authorize a plugin route", async () => {
    const { request } = await makeStack({
      auth: { mode: "bearer", token: "secret-token" },
      plugins: globalDir => {
        writePlugin(globalDir, "openspec", { backend: true })
      },
    })

    const response = await request("GET", "/v1/plugins/openspec/changes", { cookie: "conductor_plugin_session=not-a-real-value" })
    expect(response.status).toBe(401)
  })
})

describe("proxy: project resolution disambiguates same-id plugins across projects (M7)", () => {
  it("a ?project= query resolves to THAT project's own plugin, not the first-registered one", async () => {
    const projectA = writeProject()
    const projectB = writeProject()
    writePlugin(join(projectA, ".conductor", "plugins"), "openspec", { backend: true })
    writePlugin(join(projectB, ".conductor", "plugins"), "openspec", { backend: true })

    const registry = await PluginRegistry.scan({
      globalDir: null,
      projects: [{ id: "proj-a", root: projectA }, { id: "proj-b", root: projectB }],
    })
    const supervisor = new FakeSupervisor()
    const backendA = await startFakeBackend(() => new Response("from-a"))
    const backendB = await startFakeBackend(() => new Response("from-b"))
    supervisor.setState({ scope: "project", id: "openspec", projectId: "proj-a" }, "running")
    supervisor.setPort({ scope: "project", id: "openspec", projectId: "proj-a" }, backendA.port)
    supervisor.setState({ scope: "project", id: "openspec", projectId: "proj-b" }, "running")
    supervisor.setPort({ scope: "project", id: "openspec", projectId: "proj-b" }, backendB.port)

    const logger = new CollectingLogger()
    const daemon = new Daemon(
      { databasePath: join(tempDir("conductor-plugin-api-db-"), "state.db"), projects: [projectA, projectB], heartbeatIntervalMs: 60_000 },
      { sessions: new FakeSessions(), logger, scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
    )
    daemonsToStop.push(daemon)
    await daemon.start()

    const api = createApi(
      { bind: { host: "127.0.0.1", port: 0 }, auth: { mode: "none" } },
      {
        store: daemon.store,
        engine: daemon.engine,
        health: () => daemon.health(),
        resolveWorkflow: daemon.registry.resolver,
        logger,
        plugins: createPluginControl(registry, supervisor),
      },
    )
    apisToClose.push(api)
    const request = (path: string) => api.handle(new Request(`http://conductor.test${path}`))

    const forA = await request(`/v1/plugins/openspec/changes?project=${encodeURIComponent("proj-a")}`)
    expect(await forA.text()).toBe("from-a")

    const forB = await request(`/v1/plugins/openspec/changes?project=${encodeURIComponent("proj-b")}`)
    expect(await forB.text()).toBe("from-b")
  })
})
