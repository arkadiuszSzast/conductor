/**
 * SPA build + real daemon smoke — a REAL `Daemon` plus `startApiServer`
 * with `ui.staticDir` pointed at the built `dist/`, exercised over fetch:
 *  - index.html reachable at `/` without a bearer token (page loads
 *    cannot attach one);
 *  - SPA fallback serves the shell for a deep client route;
 *  - `/v1/*` keeps precedence and stays guarded by bearer auth.
 *
 * The `dist/` directory is produced by `bun run build` in `apps/web`;
 * when it is absent (e.g. a test-only run before any build) the suite
 * builds it once via Bun.spawn. Only loopback sockets, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "@conductor/server"
import { startApiServer, type ApiServer } from "@conductor/server"
import type { SessionClient } from "@conductor/server"

const webRoot = join(import.meta.dir, "..")
const distDir = join(webRoot, "dist")

class FakeSessions implements SessionClient {
  private counter = 0
  async createSession(): Promise<{ id: string }> {
    return { id: `ses-${++this.counter}` }
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

const workflowSource = `
name: smoke
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

let daemon: Daemon
let server: ApiServer
let base: string
const tempDirs: string[] = []

beforeAll(async () => {
  if (!existsSync(join(distDir, "index.html"))) {
    const build = Bun.spawn(["bun", "run", "build"], { cwd: webRoot, stdout: "pipe", stderr: "pipe" })
    const code = await build.exited
    if (code !== 0) {
      const err = await new Response(build.stderr).text()
      throw new Error(`vite build failed: ${err}`)
    }
  }

  const project = mkdtempSync(join(tmpdir(), "conductor-spa-project-"))
  tempDirs.push(project)
  writeFileSync(join(project, "conductor.yaml"), workflowSource)
  const dbDir = mkdtempSync(join(tmpdir(), "conductor-spa-db-"))
  tempDirs.push(dbDir)

  daemon = new Daemon(
    { databasePath: join(dbDir, "state.db"), projects: [project], heartbeatIntervalMs: 60_000 },
    { sessions: new FakeSessions(), scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
  )
  await daemon.start()
  server = startApiServer(
    {
      bind: { host: "127.0.0.1", port: 0 },
      auth: { mode: "bearer", token: "spa-secret" },
      ui: { staticDir: distDir },
    },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      workflowStatus: dir => daemon.registry.getStatus(dir),
    },
  )
  base = `http://127.0.0.1:${server.port}`
}, 120_000)

afterAll(async () => {
  await server?.stop()
  await daemon?.stop()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("daemon serves the built SPA", () => {
  it("serves index.html at the root without authentication", async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain('<div id="root">')
  })

  it("serves the built assets with derived content types", async () => {
    const html = await (await fetch(`${base}/`)).text()
    const match = html.match(/src="(\/assets\/[^"]+\.js)"/)
    expect(match).not.toBeNull()
    const asset = await fetch(`${base}${match![1]}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("javascript")
  })

  it("falls back to index.html for deep client routes (SPA fallback)", async () => {
    const res = await fetch(`${base}/feature/some-feature-id`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain('<div id="root">')
  })

  it("/v1 keeps precedence and stays guarded by bearer auth", async () => {
    const unauthorized = await fetch(`${base}/v1/features`)
    expect(unauthorized.status).toBe(401)
    const body = (await unauthorized.json()) as { error: { code: string } }
    expect(body.error.code).toBe("unauthorized")

    const authorized = await fetch(`${base}/v1/features`, {
      headers: { authorization: "Bearer spa-secret" },
    })
    expect(authorized.status).toBe(200)
    const list = (await authorized.json()) as { features: unknown[] }
    expect(Array.isArray(list.features)).toBe(true)
  })

  it("the workflow projection the graph relies on answers for the project", async () => {
    const health = (await (
      await fetch(`${base}/v1/health`, { headers: { authorization: "Bearer spa-secret" } })
    ).json()) as { projects: Array<{ projectDir: string; state: string }> }
    expect(health.projects.length).toBe(1)
    const projectDir = health.projects[0]!.projectDir
    const res = await fetch(`${base}/v1/projects/workflow?dir=${encodeURIComponent(projectDir)}`, {
      headers: { authorization: "Bearer spa-secret" },
    })
    expect(res.status).toBe(200)
    const workflow = (await res.json()) as { name: string; jobs: Record<string, { steps: Array<{ id: string; kind: string }> }> }
    expect(workflow.name).toBe("smoke")
    expect(workflow.jobs["main"]!.steps).toEqual([{ id: "implement", kind: "agent" }])
  })
})
