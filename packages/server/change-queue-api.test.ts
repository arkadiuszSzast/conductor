import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "./src/daemon.ts"
import { createApi, type ApiConfig, type ConductorApi } from "./src/api.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner, SessionClient } from "./src/ports.ts"

class FakeSessions implements SessionClient {
  private counter = 0
  async createSession(): Promise<{ id: string }> {
    return { id: `ses-${++this.counter}` }
  }
  async prompt(): Promise<void> {}
  async note(): Promise<void> {}
  async abort(): Promise<void> {}
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(): Promise<"busy" | "idle" | "retry" | "missing"> {
    return "busy"
  }
}

class FakeGit implements ProcessRunner {
  archivedOnRemote = new Set<string>()
  fetches = 0
  fetchTimeouts: Array<number | undefined> = []
  async exec(command: readonly string[], options?: ProcessExecOptions): Promise<ProcessExecResult> {
    const ok = (stdout = ""): ProcessExecResult => ({ code: 0, stdout, stderr: "", output: stdout })
    if (command[1] === "symbolic-ref") return { code: 1, stdout: "", stderr: "", output: "" }
    if (command[1] === "fetch") {
      this.fetches++
      this.fetchTimeouts.push(options?.timeoutMs)
    }
    if (command[1] === "ls-tree") {
      return ok([...this.archivedOnRemote].map(name => `openspec/changes/archive/2026-03-01-${name}`).join("\n"))
    }
    return ok()
  }
  async shell(): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
}

const WORKFLOW = `
name: dogfood
on: [manual]
inputs:
  change_slug: { type: string, required: true }
roles:
  implementer: { agent: build }
jobs:
  main:
    steps:
      - id: implement
        agent:
          role: implementer
          prompt: "Implement {{ inputs.change_slug }}."
`

const temporaryDirectories: string[] = []
const daemonsToStop: Daemon[] = []
const apisToClose: ConductorApi[] = []

afterEach(async () => {
  for (const api of apisToClose.splice(0)) api.close()
  for (const daemon of daemonsToStop.splice(0)) await daemon.stop()
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

function writeChange(project: string, name: string, dependsOn?: readonly string[]): void {
  const dir = join(project, "openspec", "changes", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, ".openspec.yaml"),
    `schema: spec-driven\n${dependsOn !== undefined ? `depends_on: [${dependsOn.join(", ")}]\n` : ""}`,
  )
  writeFileSync(join(dir, "proposal.md"), `## Why\nBecause ${name}.\n`)
}

async function makeHarness(auth: ApiConfig["auth"] = { mode: "none" }) {
  const project = tempDir("conductor-queue-api-project-")
  writeFileSync(join(project, "conductor.yaml"), WORKFLOW)
  const git = new FakeGit()
  const daemon = new Daemon(
    { databasePath: join(tempDir("conductor-queue-api-db-"), "state.db"), projects: [project], heartbeatIntervalMs: 60_000 },
    {
      sessions: new FakeSessions(),
      process: git,
      logger: { log: () => {} },
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
      changeQueueTimer: { setInterval: () => ({}), clearInterval: () => {} },
    },
  )
  daemonsToStop.push(daemon)
  await daemon.start()
  const api = createApi(
    { bind: { host: "127.0.0.1", port: 0 }, auth },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      workflowStatus: dir => daemon.registry.getStatus(dir),
      changeQueue: daemon.changeQueueSources,
    },
  )
  apisToClose.push(api)
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    api.handle(
      new Request(`http://conductor.test${path}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: { "content-type": "application/json", ...headers },
      }),
    )
  const dir = daemon.registry.resolve(project)!.projectDir
  return { daemon, project: dir, git, request }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>
const queueUrl = (h: Harness) => `/v1/projects/queue?dir=${encodeURIComponent(h.project)}`

/** One merged-set read (as a scheduler pass would do) so the daemon knows the remote's archive list. */
async function knowMergedSet(h: Harness): Promise<void> {
  expect((await h.daemon.changeQueueSources.readMerged(h.project)).kind).toBe("known")
}

async function add(h: Harness, change: string): Promise<Response> {
  return h.request("POST", "/v1/projects/queue/entries", { dir: h.project, change })
}

describe("GET /v1/projects/queue", () => {
  it("returns default settings and no entries for a project with an empty queue", async () => {
    const h = await makeHarness()
    const response = await h.request("GET", queueUrl(h))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settings: { paused: false, parallelism: 1 }, entries: [] })
  })

  it("lists entries in order with state, reason, live dependsOn and featureId", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    writeChange(h.project, "b", ["a"])
    expect((await add(h, "a")).status).toBe(201)
    expect((await add(h, "b")).status).toBe(201)
    writeChange(h.project, "b", ["a", "c"])
    writeChange(h.project, "c")

    const body = (await (await h.request("GET", queueUrl(h))).json()) as {
      entries: Array<Record<string, unknown>>
    }
    expect(body.entries.map(e => [e.change, e.position, e.status, e.dependsOn, e.featureId])).toEqual([
      ["a", 0, "waiting", [], null],
      ["b", 1, "waiting", ["a", "c"], null],
    ])
    expect(Object.keys(body.entries[0]!).sort()).toEqual(
      ["change", "dependsOn", "featureId", "id", "position", "reason", "state", "status"].sort(),
    )
    expect(typeof body.entries[0]!.reason).toBe("string")
  })

  it("lists live entries first, then at most 20 merged entries newest first", async () => {
    const h = await makeHarness()
    const now = { value: 1_000 }
    const store = h.daemon.store
    const ids: string[] = []
    for (let i = 0; i < 23; i++) {
      writeChange(h.project, `m${i}`)
      const entry = store.addEntry(h.project, `m${i}`)
      ids.push(entry.id)
      now.value++
      h.daemon.store["db"].run("UPDATE change_queue_entry SET status = 'merged', state = ?, reason = NULL, time_updated = ? WHERE id = ?", [
        JSON.stringify({ kind: "merged" }),
        now.value,
        entry.id,
      ])
    }
    writeChange(h.project, "live")
    await add(h, "live")
    const body = (await (await h.request("GET", queueUrl(h))).json()) as { entries: Array<{ change: string; status: string }> }
    expect(body.entries).toHaveLength(21)
    expect(body.entries[0]).toMatchObject({ change: "live", status: "waiting" })
    expect(body.entries.slice(1).map(e => e.change)).toEqual(Array.from({ length: 20 }, (_, i) => `m${22 - i}`))
    expect(store.getQueue(h.project).entries).toHaveLength(24)
  })

  it("does not list removed entries", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    const created = (await (await add(h, "a")).json()) as { id: string }
    await h.request("DELETE", `/v1/projects/queue/entries/${created.id}`)
    const body = (await (await h.request("GET", queueUrl(h))).json()) as { entries: unknown[] }
    expect(body.entries).toEqual([])
  })

  it("rejects a missing dir with 400 and an unconfigured project with the createFeature error code", async () => {
    const h = await makeHarness()
    const missing = await h.request("GET", "/v1/projects/queue")
    expect(missing.status).toBe(400)
    const unknown = await h.request("GET", "/v1/projects/queue?dir=/no/such/project")
    expect(unknown.status).toBe(422)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("project_not_configured")
    const create = await h.request("POST", "/v1/features", { title: "x", project: "/no/such/project" })
    expect(((await create.json()) as { error: { code: string } }).error.code).toBe("project_not_configured")
  })

  it("requires the bearer token when auth is bearer", async () => {
    const h = await makeHarness({ mode: "bearer", token: "secret" })
    expect((await h.request("GET", queueUrl(h))).status).toBe(401)
    expect((await h.request("POST", "/v1/projects/queue/entries", { dir: h.project, change: "a" })).status).toBe(401)
    expect((await h.request("DELETE", "/v1/projects/queue/entries/x")).status).toBe(401)
    expect((await h.request("PATCH", "/v1/projects/queue", { dir: h.project, paused: true })).status).toBe(401)
    const ok = await h.request("GET", queueUrl(h), undefined, { authorization: "Bearer secret" })
    expect(ok.status).toBe(200)
  })
})

describe("POST /v1/projects/queue/entries", () => {
  it("adds a valid change and returns the entry with 201", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    writeChange(h.project, "b", ["a"])
    const response = await add(h, "b")
    expect(response.status).toBe(201)
    const entry = (await response.json()) as Record<string, unknown>
    expect(entry).toMatchObject({ change: "b", position: 0, status: "waiting", dependsOn: ["a"], featureId: null })
    expect(typeof entry.id).toBe("string")
    expect(h.daemon.store.getQueue(h.project).entries).toHaveLength(1)
  })

  it("reads \"waiting for `base`\" immediately, in the response and the next GET, once the merged set is known", async () => {
    const h = await makeHarness()
    await knowMergedSet(h)
    writeChange(h.project, "base")
    writeChange(h.project, "dependant", ["base"])
    const response = await add(h, "dependant")
    const entry = (await response.json()) as { status: string; reason: string; state: { kind: string; waitingOn: string[] } }
    expect(entry.status).toBe("waiting")
    expect(entry.reason).toBe("waiting for `base`")
    expect(entry.state).toMatchObject({ kind: "waiting", waitingOn: ["base"] })
    const listed = (await (await h.request("GET", queueUrl(h))).json()) as { entries: Array<{ reason: string }> }
    expect(listed.entries[0]!.reason).toBe("waiting for `base`")
  })

  it("shows the limit and paused reasons immediately for a ready change", async () => {
    const h = await makeHarness()
    await knowMergedSet(h)
    writeChange(h.project, "a")
    writeChange(h.project, "b")
    await add(h, "a")
    await h.daemon.changeQueue.tick()
    const limited = (await (await add(h, "b")).json()) as { reason: string }
    expect(limited.reason).toBe("parallelism limit reached (1)")

    await h.request("PATCH", "/v1/projects/queue", { dir: h.project, paused: true, parallelism: 5 })
    writeChange(h.project, "c")
    const paused = (await (await add(h, "c")).json()) as { reason: string }
    expect(paused.reason).toBe("queue paused")
  })

  it("says the merged set is not known yet when no pass or fetch has succeeded", async () => {
    const h = await makeHarness()
    writeChange(h.project, "base")
    writeChange(h.project, "dependant", ["base"])
    const entry = (await (await add(h, "dependant")).json()) as { reason: string }
    expect(entry.reason).toContain("merged set not yet known")
    expect(entry.reason).not.toBe("queued; not yet evaluated")
  })

  it("accepts a dependency that is archived only on the remote after fetching", async () => {
    const h = await makeHarness()
    writeChange(h.project, "b", ["old-dep"])
    h.git.archivedOnRemote.add("old-dep")
    const response = await add(h, "b")
    expect(response.status).toBe(201)
    expect(h.git.fetches).toBe(1)
  })

  it("bounds the fetch it triggers to a short budget, while the scheduler keeps its own timeout", async () => {
    const h = await makeHarness()
    writeChange(h.project, "b", ["old-dep"])
    h.git.archivedOnRemote.add("old-dep")
    expect((await add(h, "b")).status).toBe(201)
    expect(h.git.fetchTimeouts).toHaveLength(1)
    expect(h.git.fetchTimeouts[0]).toBeLessThanOrEqual(10_000)
    expect(h.git.fetchTimeouts[0]).toBeGreaterThan(0)

    await h.daemon.changeQueue.tick()
    expect(h.git.fetchTimeouts.at(-1)).toBe(30_000)
  })

  it("refuses a cycle with 422 invalid_queue_entry naming both changes, and queues nothing", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a", ["b"])
    writeChange(h.project, "b", ["a"])
    const response = await add(h, "a")
    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string }
      diagnostics: Array<{ kind: string; changes: string[] }>
    }
    expect(body.error.code).toBe("invalid_queue_entry")
    expect(body.error.message).toContain("`a`")
    expect(body.error.message).toContain("`b`")
    expect(body.diagnostics).toEqual([expect.objectContaining({ kind: "cycle", changes: ["a", "b"] })])
    expect(h.daemon.store.getQueue(h.project).entries).toHaveLength(0)
  })

  it("refuses an unknown dependency with 422 naming it", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a", ["does-not-exist"])
    const response = await add(h, "a")
    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      error: { code: string; message: string }
      diagnostics: Array<{ kind: string; changes: string[] }>
    }
    expect(body.error.code).toBe("invalid_queue_entry")
    expect(body.error.message).toContain("does-not-exist")
    expect(body.diagnostics).toEqual([expect.objectContaining({ kind: "unknown-dependency", changes: ["a", "does-not-exist"] })])
    expect(h.daemon.store.getQueue(h.project).entries).toHaveLength(0)
  })

  it("refuses a change with no directory, and one with an unreadable .openspec.yaml, with 422", async () => {
    const h = await makeHarness()
    const missing = await add(h, "nope")
    expect(missing.status).toBe(422)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("invalid_queue_entry")

    writeChange(h.project, "bad")
    writeFileSync(join(h.project, "openspec/changes/bad/.openspec.yaml"), "depends_on: nope\n")
    const bad = await add(h, "bad")
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { diagnostics: Array<{ kind: string }> }).diagnostics[0]!.kind).toBe("invalid-depends-on")
  })

  it("refuses, with a not-startable diagnostic, when the workflow declares no change_slug/change input", async () => {
    const h = await makeHarness()
    writeFileSync(
      join(h.project, "conductor.yaml"),
      WORKFLOW.replace("change_slug: { type: string, required: true }", "ticket: { type: string, required: true }").replace(
        "inputs.change_slug",
        "inputs.ticket",
      ),
    )
    expect(h.daemon.registry.reload(h.project).ok).toBe(true)
    writeChange(h.project, "a")
    const response = await add(h, "a")
    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      error: { code: string; message: string }
      diagnostics: Array<{ kind: string; message: string }>
    }
    expect(body.error.code).toBe("invalid_queue_entry")
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ kind: "not-startable", message: "the workflow declares no `change_slug`/`change` string input" }),
    ])
    expect(h.daemon.store.getQueue(h.project).entries).toHaveLength(0)
  })

  it("refuses a duplicate live entry with 409, but allows re-queueing after removal", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    const first = (await (await add(h, "a")).json()) as { id: string }
    const duplicate = await add(h, "a")
    expect(duplicate.status).toBe(409)
    expect(((await duplicate.json()) as { error: { code: string } }).error.code).toBe("conflict")

    expect((await h.request("DELETE", `/v1/projects/queue/entries/${first.id}`)).status).toBe(200)
    expect((await add(h, "a")).status).toBe(201)
  })

  it("validates the body", async () => {
    const h = await makeHarness()
    expect((await h.request("POST", "/v1/projects/queue/entries", { dir: h.project })).status).toBe(400)
    expect((await h.request("POST", "/v1/projects/queue/entries", { change: "a" })).status).toBe(400)
    expect((await h.request("POST", "/v1/projects/queue/entries", { dir: "/no/such", change: "a" })).status).toBe(422)
  })
})

describe("DELETE /v1/projects/queue/entries/:id", () => {
  it("removes an unstarted entry with 200", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    const created = (await (await add(h, "a")).json()) as { id: string }
    const response = await h.request("DELETE", `/v1/projects/queue/entries/${created.id}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ entry: { id: created.id, change: "a", status: "removed" } })
    expect(h.daemon.store.getQueueEntry(created.id)!.status).toBe("removed")
  })

  it("refuses to remove a started entry with 409 and tells the operator to abandon the feature", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    const created = (await (await add(h, "a")).json()) as { id: string }
    await h.daemon.changeQueue.tick()
    const entry = h.daemon.store.getQueueEntry(created.id)!
    expect(entry.status).toBe("running")

    const response = await h.request("DELETE", `/v1/projects/queue/entries/${created.id}`)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("conflict")
    expect(body.error.message).toContain("abandon the feature")
    expect(body.error.message).toContain(entry.featureId!)
    expect(h.daemon.store.getQueueEntry(created.id)!.status).toBe("running")
  })

  it("removes an entry whose feature ended without a merge (done or abandoned)", async () => {
    for (const status of ["done", "abandoned"] as const) {
      const h = await makeHarness()
      writeChange(h.project, "a")
      const created = (await (await add(h, "a")).json()) as { id: string }
      await h.daemon.changeQueue.tick()
      const entry = h.daemon.store.getQueueEntry(created.id)!
      expect(entry.status).toBe("running")
      expect((await h.request("DELETE", `/v1/projects/queue/entries/${created.id}`)).status).toBe(409)

      if (status === "done") {
        const run = h.daemon.store.getActiveRun(entry.featureId!)!
        await h.daemon.engine.report({ runId: run.id, outcome: "succeeded" })
      } else {
        await h.daemon.engine.abandon(entry.featureId!)
      }
      expect(h.daemon.store.getFeature(entry.featureId!)!.status).toBe(status)
      const response = await h.request("DELETE", `/v1/projects/queue/entries/${created.id}`)
      expect(response.status).toBe(200)
      expect(h.daemon.store.getQueueEntry(created.id)!.status).toBe("removed")
    }
  })

  it("answers 400 invalid_request, not 500, for a malformed percent-encoded id", async () => {
    const h = await makeHarness()
    const response = await h.request("DELETE", "/v1/projects/queue/entries/%E0%A4%A")
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_request")
  })

  it("returns 404 for an unknown entry", async () => {
    const h = await makeHarness()
    const response = await h.request("DELETE", "/v1/projects/queue/entries/does-not-exist")
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })
})

describe("PATCH /v1/projects/queue", () => {
  it("pauses, resumes and sets parallelism, returning the queue", async () => {
    const h = await makeHarness()
    const paused = await h.request("PATCH", "/v1/projects/queue", { dir: h.project, paused: true, parallelism: 3 })
    expect(paused.status).toBe(200)
    expect(((await paused.json()) as { settings: unknown }).settings).toEqual({ paused: true, parallelism: 3 })
    expect(h.daemon.store.getQueueSettings(h.project)).toMatchObject({ paused: true, parallelism: 3 })

    const resumed = await h.request("PATCH", "/v1/projects/queue", { dir: h.project, paused: false })
    expect(((await resumed.json()) as { settings: unknown }).settings).toEqual({ paused: false, parallelism: 3 })
  })

  it("reorders unstarted entries", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    writeChange(h.project, "b")
    writeChange(h.project, "c")
    const ids: string[] = []
    for (const change of ["a", "b", "c"]) ids.push(((await (await add(h, change)).json()) as { id: string }).id)

    const response = await h.request("PATCH", "/v1/projects/queue", { dir: h.project, order: [ids[2], ids[0], ids[1]] })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { entries: Array<{ change: string; position: number }> }
    expect(body.entries.map(e => [e.change, e.position])).toEqual([["c", 0], ["a", 1], ["b", 2]])
  })

  it.each([
    ["zero parallelism", { parallelism: 0 }],
    ["fractional parallelism", { parallelism: 1.5 }],
    ["string parallelism", { parallelism: "2" }],
    ["non-boolean paused", { paused: "yes" }],
    ["non-array order", { order: "a,b" }],
    ["order with non-strings", { order: [1, 2] }],
    ["order naming an unknown entry", { order: ["ghost"] }],
  ])("rejects %s with 422 and writes nothing", async (_name, patch) => {
    const h = await makeHarness()
    const response = await h.request("PATCH", "/v1/projects/queue", { dir: h.project, ...patch })
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_queue_settings")
    expect(h.daemon.store.getQueueSettings(h.project)).toMatchObject({ paused: false, parallelism: 1 })
  })

  it("rejects a reorder that includes a started entry, and keeps the settings from the same request unchanged", async () => {
    const h = await makeHarness()
    writeChange(h.project, "a")
    const id = ((await (await add(h, "a")).json()) as { id: string }).id
    await h.daemon.changeQueue.tick()
    const response = await h.request("PATCH", "/v1/projects/queue", { dir: h.project, order: [id], parallelism: 5 })
    expect(response.status).toBe(422)
    expect(h.daemon.store.getQueueSettings(h.project).parallelism).toBe(1)
  })

  it("requires dir and at least one field", async () => {
    const h = await makeHarness()
    expect((await h.request("PATCH", "/v1/projects/queue", { paused: true })).status).toBe(400)
    expect((await h.request("PATCH", "/v1/projects/queue", { dir: h.project })).status).toBe(400)
    expect((await h.request("PATCH", "/v1/projects/queue", { dir: "/no/such", paused: true })).status).toBe(422)
  })
})

describe("queue routes without a change-queue port", () => {
  it("404 like any unknown route", async () => {
    const project = tempDir("conductor-queue-api-noport-")
    writeFileSync(join(project, "conductor.yaml"), WORKFLOW)
    const daemon = new Daemon(
      { databasePath: join(tempDir("conductor-queue-api-db-"), "state.db"), projects: [project], heartbeatIntervalMs: 60_000 },
      { sessions: new FakeSessions(), logger: { log: () => {} }, scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
    )
    daemonsToStop.push(daemon)
    await daemon.start()
    const api = createApi(
      { bind: { host: "127.0.0.1", port: 0 }, auth: { mode: "none" } },
      { store: daemon.store, engine: daemon.engine, health: () => daemon.health(), resolveWorkflow: daemon.registry.resolver },
    )
    apisToClose.push(api)
    const response = await api.handle(new Request(`http://conductor.test/v1/projects/queue?dir=${encodeURIComponent(project)}`))
    expect(response.status).toBe(404)
  })
})
