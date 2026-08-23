/**
 * End-to-end proof that the bundled OpenSpec plugin is an ordinary
 * plugin (plugin-system tasks.md 6.4, `openspec-plugin` spec: "Installed
 * like any third-party plugin"): a real `PluginRegistry` scan discovers
 * it from a project's `.conductor/plugins/`, a real `PluginSupervisor`
 * spawns its `serve.ts` with `bun`, and the daemon proxies it through a
 * real `startApiServer` listener with NO special-casing — same shape as
 * `api-integration.test.ts` exercises the rest of the API.
 *
 * The API's own listen port must be known before the supervisor starts
 * (the plugin's `CONDUCTOR_URL` env), so — like production's explicit
 * `daemon.yaml` port, unlike the rest of this test suite's `port: 0`
 * convenience — the port is allocated up front with the same
 * `realPortAllocator` the supervisor itself uses for backend ports.
 *
 * The registry rejects symlinked plugin directories (plugin-registry
 * spec), so the fixture COPIES `plugins/openspec/` rather than linking
 * it, mirroring a real `cp -r` install.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "./src/daemon.ts"
import { startApiServer, type ApiServer } from "./src/api.ts"
import { PluginRegistry } from "./src/plugin-registry.ts"
import { PluginSupervisor } from "./src/plugin-supervisor.ts"
import { createPluginControl } from "./src/plugin-proxy.ts"
import { realPluginProcessSpawner, realPortAllocator } from "./src/process.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const BUNDLED_PLUGIN_DIR = resolve(REPO_ROOT, "plugins/openspec")

const temporaryDirectories: string[] = []
const daemonsToStop: Daemon[] = []
const serversToStop: ApiServer[] = []
const supervisorsToStop: PluginSupervisor[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(async () => {
  for (const supervisor of supervisorsToStop.splice(0)) await supervisor.stop()
  for (const server of serversToStop.splice(0)) await server.stop()
  for (const daemon of daemonsToStop.splice(0)) await daemon.stop()
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function pollUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise(res => setTimeout(res, 25))
  }
}

/** The supervisor marks a plugin "running" as soon as `spawn()` returns,
 *  before the child has actually bound its loopback port — an inherent
 *  race in any "spawn now, bind later" scheme. Waiting for the proxied
 *  endpoint to actually answer (rather than trusting `stateOf`) is what
 *  a real client does too: retry past the brief startup window. */
async function pollUntilReachable(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.status !== 503) return
    } catch {
      // connection refused while the child is still binding — retry.
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url} to become reachable`)
    await new Promise(res => setTimeout(res, 25))
  }
}

interface Stack {
  readonly daemon: Daemon
  readonly server: ApiServer
  readonly supervisor: PluginSupervisor
  readonly registry: PluginRegistry
  readonly base: string
  readonly project: string
}

async function startStackWithBundledPlugin(): Promise<Stack> {
  const project = tempDir("conductor-plugin-e2e-project-")
  cpSync(BUNDLED_PLUGIN_DIR, join(project, ".conductor", "plugins", "openspec"), { recursive: true })

  const databasePath = join(tempDir("conductor-plugin-e2e-db-"), "state.db")
  const daemon = new Daemon({ databasePath, projects: [project], heartbeatIntervalMs: 60_000 }, {})
  daemonsToStop.push(daemon)
  await daemon.start()

  const registry = await PluginRegistry.scan({ globalDir: null, projects: [{ id: project, root: project }] })
  expect(registry.loadDiagnostics()).toEqual([])

  const apiPort = await realPortAllocator.allocate()
  const base = `http://127.0.0.1:${apiPort}`

  const supervisor = new PluginSupervisor(
    { spawner: realPluginProcessSpawner, ports: realPortAllocator, log: { log: () => {} } },
    { conductorUrl: base },
  )
  supervisorsToStop.push(supervisor)
  await supervisor.start(registry.list())

  const control = createPluginControl(registry, supervisor)
  const server = startApiServer(
    { bind: { host: "127.0.0.1", port: apiPort }, auth: { mode: "none" } },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      plugins: control,
    },
  )
  serversToStop.push(server)

  await pollUntil(() => supervisor.stateOf({ scope: "project", id: "openspec", projectId: project }) === "running")
  await pollUntilReachable(`${base}/v1/plugins/openspec/changes?project=${encodeURIComponent(project)}`)

  return { daemon, server, supervisor, registry, base, project }
}

describe("Plugin e2e: the bundled OpenSpec plugin is discovered and run with no special-casing", () => {
  it("is discovered by scope, spawns its backend, and appears running in the listing", async () => {
    const { base, project, registry } = await startStackWithBundledPlugin()

    const discovered = registry.list()
    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.id).toBe("openspec")
    expect(discovered[0]!.scope).toBe("project")

    const listing = await fetch(`${base}/v1/plugins?project=${encodeURIComponent(project)}`)
    expect(listing.status).toBe(200)
    const listingBody = (await listing.json()) as { plugins: Array<{ id: string; state: string }> }
    expect(listingBody.plugins).toEqual([expect.objectContaining({ id: "openspec", state: "running" })])
  })

  it("proxies /changes to the spawned backend with an explanatory empty state for a project with no openspec/ root", async () => {
    const { base, project } = await startStackWithBundledPlugin()

    const proxied = await fetch(`${base}/v1/plugins/openspec/changes?project=${encodeURIComponent(project)}`)
    expect(proxied.status).toBe(200)
    expect(await proxied.json()).toEqual({ openspec: false })
  })

  it("proxies real OpenSpec data end to end for a project that has an openspec/ tree", async () => {
    const { base, project } = await startStackWithBundledPlugin()

    mkdirSync(join(project, "openspec", "changes", "sample-change"), { recursive: true })
    writeFileSync(join(project, "openspec", "changes", "sample-change", "tasks.md"), "- [x] one\n- [ ] two\n")
    writeFileSync(join(project, "openspec", "changes", "sample-change", "proposal.md"), "## Why\n\nBecause it matters.\n")

    const response = await fetch(`${base}/v1/plugins/openspec/changes?project=${encodeURIComponent(project)}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      openspec: boolean
      active: Array<{ name: string; taskProgress: { done: number; total: number } | null }>
    }
    expect(body.openspec).toBe(true)
    const sample = body.active.find(change => change.name === "sample-change")
    expect(sample?.taskProgress).toEqual({ done: 1, total: 2 })
  })

  it("serves the plugin's static UI through the same proxy", async () => {
    const { base, project } = await startStackWithBundledPlugin()

    const ui = await fetch(`${base}/v1/plugins/openspec/ui/?project=${encodeURIComponent(project)}`)
    expect(ui.status).toBe(200)
    expect(ui.headers.get("content-type")).toContain("text/html")
  })

  it("shuts down cleanly: the backend is reaped and further proxy calls answer 'unavailable'", async () => {
    const { base, project, supervisor } = await startStackWithBundledPlugin()

    await supervisor.stop()
    supervisorsToStop.length = 0
    expect(supervisor.stateOf({ scope: "project", id: "openspec", projectId: project })).toBe("stopped")

    const response = await fetch(`${base}/v1/plugins/openspec/changes?project=${encodeURIComponent(project)}`)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("unavailable")
  })
})
