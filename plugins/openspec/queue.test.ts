import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { handleRequest, type OpenSpecServeDeps } from "./serve.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function projectWith(changes: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), "openspec-queue-test-"))
  temporaryDirectories.push(dir)
  for (const [name, openspecYaml] of Object.entries(changes)) {
    const changeDir = join(dir, "openspec", "changes", name)
    mkdirSync(changeDir, { recursive: true })
    writeFileSync(join(changeDir, "proposal.md"), `## Why\n\nBecause ${name}.\n`)
    if (openspecYaml !== null) writeFileSync(join(changeDir, ".openspec.yaml"), openspecYaml)
  }
  return dir
}

interface DaemonCall {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

function deps(
  projectDir: string,
  respond: (call: DaemonCall) => Response | Promise<Response>,
  calls: DaemonCall[] = [],
): OpenSpecServeDeps {
  return {
    projectDir,
    conductorUrl: "http://127.0.0.1:4400",
    conductorToken: "secret-token",
    uiDir: "/nonexistent/ui",
    exec: async () => ({ code: 127, stdout: "", stderr: "openspec: command not found" }),
    fetchFn: (async (url: string, init?: RequestInit) => {
      const call: DaemonCall = {
        method: init?.method ?? "GET",
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      }
      calls.push(call)
      return respond(call)
    }) as unknown as typeof fetch,
    readFile: path => readFile(path, "utf8"),
    readDir: path => readdir(path),
    isDirectory: async path => {
      try {
        return (await stat(path)).isDirectory()
      } catch {
        return false
      }
    },
  }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })

const post = (path: string, body: unknown): Request =>
  new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) })

describe("declared dependencies in the change list", () => {
  it("lists each active change's depends_on read from .openspec.yaml", async () => {
    const dir = projectWith({
      "unify-content-gates": "schema: spec-driven\ncreated: 2026-07-01\n",
      "dialogue-node-atomic-commit": "schema: spec-driven\ndepends_on:\n  - unify-content-gates\n  - other\n",
      "no-yaml": null,
    })
    const response = await handleRequest(new Request("http://x/changes"), deps(dir, () => json(200, {})))
    const body = (await response.json()) as { active: Array<{ name: string; dependsOn: string[] }> }
    expect(body.active.map(c => [c.name, c.dependsOn])).toEqual([
      ["dialogue-node-atomic-commit", ["unify-content-gates", "other"]],
      ["no-yaml", []],
      ["unify-content-gates", []],
    ])
  })

  it("shows nothing and a warning for a malformed depends_on, without failing the listing", async () => {
    const dir = projectWith({
      "bad-shape": "depends_on: just-a-string\n",
      "bad-yaml": "depends_on: [unterminated\n  - : :\n",
      fine: "depends_on: [bad-shape]\n",
    })
    const response = await handleRequest(new Request("http://x/changes"), deps(dir, () => json(200, {})))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      active: Array<{ name: string; dependsOn: string[]; dependsOnWarning?: string }>
    }
    const byName = Object.fromEntries(body.active.map(c => [c.name, c]))
    expect(byName["bad-shape"]!.dependsOn).toEqual([])
    expect(byName["bad-shape"]!.dependsOnWarning).toContain("depends_on must be a list")
    expect(byName["bad-yaml"]!.dependsOn).toEqual([])
    expect(typeof byName["bad-yaml"]!.dependsOnWarning).toBe("string")
    expect(byName["fine"]!.dependsOn).toEqual(["bad-shape"])
    expect(byName["fine"]!.dependsOnWarning).toBeUndefined()
  })

  it("warns, and shows no dependencies, for an oversized or anchor/alias-bearing .openspec.yaml", async () => {
    const dir = projectWith({
      huge: `depends_on: [a]\n# ${"x".repeat(70 * 1024)}\n`,
      aliased: "base: &b [a]\ndepends_on: *b\n",
    })
    const response = await handleRequest(new Request("http://x/changes"), deps(dir, () => json(200, {})))
    const body = (await response.json()) as { active: Array<{ name: string; dependsOn: string[]; dependsOnWarning?: string }> }
    const byName = Object.fromEntries(body.active.map(c => [c.name, c]))
    expect(byName["huge"]!.dependsOn).toEqual([])
    expect(byName["huge"]!.dependsOnWarning).toContain("limit")
    expect(byName["aliased"]!.dependsOn).toEqual([])
    expect(byName["aliased"]!.dependsOnWarning).toContain("anchors or aliases")
  })

  it("includes dependsOn in the detail of an active change", async () => {
    const dir = projectWith({ "dialogue-node-atomic-commit": "depends_on: [unify-content-gates]\n" })
    const response = await handleRequest(
      new Request("http://x/change?name=dialogue-node-atomic-commit"),
      deps(dir, () => json(200, {})),
    )
    expect(((await response.json()) as { dependsOn: string[] }).dependsOn).toEqual(["unify-content-gates"])
  })
})

describe("GET /queue", () => {
  it("proxies the daemon's queue for the project with the bearer token", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const queue = {
      settings: { paused: false, parallelism: 1 },
      entries: [
        {
          id: "e1",
          change: "dialogue-node-atomic-commit",
          position: 0,
          status: "waiting",
          reason: "waiting for `unify-content-gates`",
          state: { kind: "waiting", why: "dependencies", waitingOn: ["unify-content-gates"], reason: "x" },
          dependsOn: ["unify-content-gates"],
          featureId: null,
        },
      ],
    }
    const response = await handleRequest(new Request("http://x/queue"), deps(dir, () => json(200, queue), calls))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(queue)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url).toBe(`http://127.0.0.1:4400/v1/projects/queue?dir=${encodeURIComponent(dir)}`)
    expect(calls[0]!.headers.authorization).toBe("Bearer secret-token")
  })

  it("surfaces a blocked entry's reason naming the escalated dependency, verbatim", async () => {
    const dir = projectWith({})
    const queue = {
      settings: { paused: false, parallelism: 1 },
      entries: [
        {
          id: "e2",
          change: "dependant",
          position: 1,
          status: "blocked",
          reason: "blocked: `base` escalated",
          state: { kind: "blocked", by: "base", stuck: "escalated", reason: "blocked: `base` escalated" },
          dependsOn: ["base"],
          featureId: null,
        },
      ],
    }
    const response = await handleRequest(new Request("http://x/queue"), deps(dir, () => json(200, queue)))
    const body = (await response.json()) as { entries: Array<{ status: string; reason: string }> }
    expect(body.entries[0]!.status).toBe("blocked")
    expect(body.entries[0]!.reason).toBe("blocked: `base` escalated")
  })

  it("relays a daemon error message with its status", async () => {
    const dir = projectWith({})
    const response = await handleRequest(
      new Request("http://x/queue"),
      deps(dir, () => json(422, { error: { code: "project_not_configured", message: "no valid conductor.yaml registered" } })),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: "no valid conductor.yaml registered" })
  })

  it("answers 502 when the daemon is unreachable", async () => {
    const dir = projectWith({})
    const response = await handleRequest(
      new Request("http://x/queue"),
      deps(dir, () => {
        throw new Error("connect ECONNREFUSED")
      }),
    )
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: string }).error).toContain("ECONNREFUSED")
  })
})

describe("POST /queue/entries", () => {
  it("queues a change through the daemon and returns the entry with its waiting reason", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const entry = {
      id: "e1",
      change: "dialogue-node-atomic-commit",
      position: 0,
      status: "waiting",
      reason: "waiting for `unify-content-gates`",
      state: null,
      dependsOn: ["unify-content-gates"],
      featureId: null,
    }
    const response = await handleRequest(
      post("/queue/entries", { change: "dialogue-node-atomic-commit" }),
      deps(dir, () => json(201, entry), calls),
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(entry)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url).toBe("http://127.0.0.1:4400/v1/projects/queue/entries")
    expect(calls[0]!.headers.authorization).toBe("Bearer secret-token")
    expect(calls[0]!.body).toEqual({ dir, change: "dialogue-node-atomic-commit" })
  })

  it("returns the daemon's cycle diagnostic as the error message and does not report a queued entry", async () => {
    const dir = projectWith({})
    const message = "cannot queue \"a\": dependency cycle: `a` → `b` → `a`"
    const response = await handleRequest(
      post("/queue/entries", { change: "a" }),
      deps(dir, () =>
        json(422, {
          error: { code: "invalid_queue_entry", message, requestId: "r1" },
          diagnostics: [{ kind: "cycle", changes: ["a", "b"], message: "x" }],
        }),
      ),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: message })
  })

  it("rejects a missing or unsafe change name without calling the daemon", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const d = deps(dir, () => json(201, {}), calls)
    expect((await handleRequest(post("/queue/entries", {}), d)).status).toBe(400)
    expect((await handleRequest(post("/queue/entries", { change: "../x" }), d)).status).toBe(400)
    expect((await handleRequest(new Request("http://x/queue/entries", { method: "POST", body: "nope" }), d)).status).toBe(400)
    expect(calls).toEqual([])
  })
})

describe("DELETE /queue/entries/:id", () => {
  it("dequeues through the daemon", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const removed = { entry: { id: "e1", change: "a", status: "removed" } }
    const response = await handleRequest(
      new Request("http://x/queue/entries/e1", { method: "DELETE" }),
      deps(dir, () => json(200, removed), calls),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(removed)
    expect(calls[0]!.method).toBe("DELETE")
    expect(calls[0]!.url).toBe("http://127.0.0.1:4400/v1/projects/queue/entries/e1")
    expect(calls[0]!.headers.authorization).toBe("Bearer secret-token")
  })

  it("relays the refusal to remove a started entry", async () => {
    const dir = projectWith({})
    const message = 'queue entry for "a" has started (feature f1); abandon the feature instead of removing the entry'
    const response = await handleRequest(
      new Request("http://x/queue/entries/e1", { method: "DELETE" }),
      deps(dir, () => json(409, { error: { code: "conflict", message } })),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: message })
  })

  it("rejects an id that would address another daemon path", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const response = await handleRequest(
      new Request("http://x/queue/entries/a%2F..%2Fb", { method: "DELETE" }),
      deps(dir, () => json(200, {}), calls),
    )
    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })
})

describe("PATCH /queue", () => {
  it("updates paused and parallelism through the daemon, keyed by the project", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const queue = { settings: { paused: true, parallelism: 3 }, entries: [] }
    const response = await handleRequest(
      new Request("http://x/queue", { method: "PATCH", body: JSON.stringify({ paused: true, parallelism: 3 }) }),
      deps(dir, () => json(200, queue), calls),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(queue)
    expect(calls[0]!.method).toBe("PATCH")
    expect(calls[0]!.url).toBe("http://127.0.0.1:4400/v1/projects/queue")
    expect(calls[0]!.body).toEqual({ dir, paused: true, parallelism: 3 })
  })

  it("forwards only paused and parallelism, never order", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    await handleRequest(
      new Request("http://x/queue", { method: "PATCH", body: JSON.stringify({ paused: false, order: ["a"], dir: "/other" }) }),
      deps(dir, () => json(200, {}), calls),
    )
    expect(calls[0]!.body).toEqual({ dir, paused: false })
  })

  it("relays the daemon's validation message and rejects an empty update locally", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const message = '"parallelism" must be an integer of at least 1'
    const d = deps(dir, () => json(422, { error: { code: "invalid_queue_settings", message } }), calls)
    const refused = await handleRequest(
      new Request("http://x/queue", { method: "PATCH", body: JSON.stringify({ parallelism: 0 }) }),
      d,
    )
    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ error: message })

    const empty = await handleRequest(new Request("http://x/queue", { method: "PATCH", body: "{}" }), d)
    expect(empty.status).toBe(400)
    expect(calls).toHaveLength(1)
  })
})

describe("daemon without a token", () => {
  it("sends no authorization header", async () => {
    const dir = projectWith({})
    const calls: DaemonCall[] = []
    const { conductorToken: _token, ...rest } = deps(dir, () => json(200, { settings: {}, entries: [] }), calls)
    await handleRequest(new Request("http://x/queue"), rest)
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })
})
