import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { handleRequest, type ExecResult, type OpenSpecServeDeps } from "./serve.ts"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "openspec-plugin-test-"))
}

function baseDeps(overrides: Partial<OpenSpecServeDeps> = {}): OpenSpecServeDeps {
  return {
    projectDir: "/nonexistent",
    conductorUrl: "http://127.0.0.1:4400",
    conductorToken: "secret-token",
    uiDir: "/nonexistent/ui",
    exec: async () => ({ code: 0, stdout: '{"changes":[]}', stderr: "" }),
    fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    readFile: async () => {
      throw new Error("ENOENT")
    },
    readDir: async () => [],
    isDirectory: async () => false,
    ...overrides,
  }
}

function writeChangeFixture(root: string, name: string, tasksMarkdown: string): void {
  const dir = join(root, "openspec", "changes", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "tasks.md"), tasksMarkdown)
  writeFileSync(join(dir, "proposal.md"), `## Why\n\nBecause ${name} matters.\n\n## What Changes\n\n- do it\n`)
}

function realFsDeps(projectDir: string, overrides: Partial<OpenSpecServeDeps> = {}): OpenSpecServeDeps {
  return baseDeps({
    projectDir,
    readFile: async path => {
      const { readFile } = await import("node:fs/promises")
      return readFile(path, "utf8")
    },
    readDir: async path => {
      const { readdir } = await import("node:fs/promises")
      return readdir(path)
    },
    isDirectory: async path => {
      const { stat } = await import("node:fs/promises")
      try {
        return (await stat(path)).isDirectory()
      } catch {
        return false
      }
    },
    ...overrides,
  })
}

describe("GET /changes", () => {
  it("returns { openspec: false } when the project has no openspec/ root", async () => {
    const dir = tempDir()
    try {
      const response = await handleRequest(new Request("http://x/changes"), realFsDeps(dir))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ openspec: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lists active changes with task progress from a fixture tree, and archived names", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "openspec"), { recursive: true })
      writeChangeFixture(dir, "add-feature", "- [x] done one\n- [x] done two\n- [ ] pending one\n")
      mkdirSync(join(dir, "openspec", "changes", "archive", "old-change"), { recursive: true })

      const exec = async (command: readonly string[]): Promise<ExecResult> => {
        expect(command).toEqual(["openspec", "list", "--json"])
        return {
          code: 0,
          stdout: JSON.stringify({ changes: [{ name: "add-feature", completedTasks: 2, totalTasks: 3 }] }),
          stderr: "",
        }
      }

      const response = await handleRequest(new Request("http://x/changes"), realFsDeps(dir, { exec }))
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        openspec: boolean
        active: Array<{ name: string; taskProgress: { done: number; total: number } | null }>
        archived: string[]
      }
      expect(body.openspec).toBe(true)
      expect(body.active).toEqual([{ name: "add-feature", taskProgress: { done: 2, total: 3 } }])
      expect(body.archived).toEqual(["old-change"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to counting tasks.md checkboxes when the CLI omits task counts", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "openspec"), { recursive: true })
      writeChangeFixture(dir, "no-counts", "- [x] one\n- [ ] two\n- [ ] three\n")

      const exec = async (): Promise<ExecResult> => ({
        code: 0,
        stdout: JSON.stringify({ changes: [{ name: "no-counts" }] }),
        stderr: "",
      })

      const response = await handleRequest(new Request("http://x/changes"), realFsDeps(dir, { exec }))
      const body = (await response.json()) as { active: Array<{ name: string; taskProgress: unknown }> }
      expect(body.active).toEqual([{ name: "no-counts", taskProgress: { done: 1, total: 3 } }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports no task progress when the CLI call fails and no tasks.md exists", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "openspec"), { recursive: true })

      const exec = async (): Promise<ExecResult> => ({ code: 1, stdout: "", stderr: "boom" })
      const response = await handleRequest(new Request("http://x/changes"), realFsDeps(dir, { exec }))
      const body = (await response.json()) as { openspec: boolean; active: unknown[]; archived: unknown[] }
      expect(body.openspec).toBe(true)
      expect(body.active).toEqual([])
      expect(body.archived).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lists changes from the filesystem when the openspec CLI is not installed (exit 127)", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "openspec", "changes", "sample-change"), { recursive: true })
      writeFileSync(join(dir, "openspec", "changes", "sample-change", "tasks.md"), "- [x] one\n- [ ] two\n")
      mkdirSync(join(dir, "openspec", "changes", "archive", "old-change"), { recursive: true })

      const exec = async (): Promise<ExecResult> => ({ code: 127, stdout: "", stderr: "openspec: command not found" })
      const response = await handleRequest(new Request("http://x/changes"), realFsDeps(dir, { exec }))
      const body = (await response.json()) as {
        openspec: boolean
        active: Array<{ name: string; taskProgress: { done: number; total: number } | null }>
        archived: string[]
      }
      expect(body.openspec).toBe(true)
      expect(body.active).toEqual([{ name: "sample-change", taskProgress: { done: 1, total: 2 } }])
      expect(body.archived).toEqual(["old-change"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("POST /start-work", () => {
  it("reads the proposal's Why section and calls the daemon with title/description and bearer token", async () => {
    const dir = tempDir()
    try {
      writeChangeFixture(dir, "retry-policy", "- [x] a\n")

      const captured: { url: string | null; init: RequestInit | null } = { url: null, init: null }
      const fetchFn = (async (url: string, init?: RequestInit) => {
        captured.url = url
        captured.init = init ?? null
        return new Response(JSON.stringify({ feature: { id: "feat-123" } }), { status: 201 })
      }) as unknown as typeof fetch

      const request = new Request("http://x/start-work", {
        method: "POST",
        body: JSON.stringify({ change: "retry-policy" }),
      })
      const response = await handleRequest(request, realFsDeps(dir, { fetchFn }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ featureId: "feat-123" })

      expect(captured.url).toBe("http://127.0.0.1:4400/v1/features")
      const headers = captured.init!.headers as Record<string, string>
      expect(headers.authorization).toBe("Bearer secret-token")
      const sentBody = JSON.parse(captured.init!.body as string) as { title: string; project: string; description: string }
      expect(sentBody.title).toBe("Retry Policy")
      expect(sentBody.project).toBe(dir)
      expect(sentBody.description).toContain("Because retry-policy matters.")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("relays the daemon's error envelope message with the upstream status on failure", async () => {
    const dir = tempDir()
    try {
      writeChangeFixture(dir, "broken-change", "")

      const fetchFn = (async () =>
        new Response(JSON.stringify({ error: { code: "project_not_configured", message: "no valid conductor.yaml" } }), {
          status: 422,
        })) as unknown as typeof fetch

      const request = new Request("http://x/start-work", {
        method: "POST",
        body: JSON.stringify({ change: "broken-change" }),
      })
      const response = await handleRequest(request, realFsDeps(dir, { fetchFn }))
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ error: "no valid conductor.yaml" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a missing or empty change field without calling the daemon", async () => {
    const dir = tempDir()
    try {
      let called = false
      const fetchFn = (async () => {
        called = true
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch

      const request = new Request("http://x/start-work", { method: "POST", body: JSON.stringify({}) })
      const response = await handleRequest(request, realFsDeps(dir, { fetchFn }))
      expect(response.status).toBe(400)
      expect(called).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("404s when the change has no proposal.md", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "openspec", "changes", "ghost"), { recursive: true })
      const request = new Request("http://x/start-work", {
        method: "POST",
        body: JSON.stringify({ change: "ghost" }),
      })
      const response = await handleRequest(request, realFsDeps(dir))
      expect(response.status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a change name that could escape the changes directory", async () => {
    const dir = tempDir()
    try {
      const request = new Request("http://x/start-work", {
        method: "POST",
        body: JSON.stringify({ change: "../../etc/passwd" }),
      })
      const response = await handleRequest(request, realFsDeps(dir))
      expect(response.status).toBe(400)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("static UI serving", () => {
  it("serves a file from the ui directory", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "ui"), { recursive: true })
      writeFileSync(join(dir, "ui", "index.html"), "<html>hi</html>")

      const response = await handleRequest(new Request("http://x/ui/"), baseDeps({
        uiDir: join(dir, "ui"),
        readFile: async path => {
          const { readFile } = await import("node:fs/promises")
          return readFile(path, "utf8")
        },
      }))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("<html>hi</html>")
      expect(response.headers.get("content-type")).toContain("text/html")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serves index.html for the bare /ui path (no trailing slash)", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "ui"), { recursive: true })
      writeFileSync(join(dir, "ui", "index.html"), "<html>hi</html>")

      const response = await handleRequest(new Request("http://x/ui"), baseDeps({
        uiDir: join(dir, "ui"),
        readFile: async path => {
          const { readFile } = await import("node:fs/promises")
          return readFile(path, "utf8")
        },
      }))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("<html>hi</html>")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serves a nested asset under /ui/", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "ui"), { recursive: true })
      writeFileSync(join(dir, "ui", "app.js"), "console.log('hi')")

      const response = await handleRequest(new Request("http://x/ui/app.js"), baseDeps({
        uiDir: join(dir, "ui"),
        readFile: async path => {
          const { readFile } = await import("node:fs/promises")
          return readFile(path, "utf8")
        },
      }))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/javascript")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a path-traversal attempt with 404, never escaping the ui directory", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "ui"), { recursive: true })
      writeFileSync(join(dir, "secret.txt"), "top secret")

      const response = await handleRequest(new Request("http://x/ui/../secret.txt"), baseDeps({
        uiDir: join(dir, "ui"),
        readFile: async path => {
          const { readFile } = await import("node:fs/promises")
          return readFile(path, "utf8")
        },
      }))
      expect(response.status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects an encoded traversal attempt", async () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "ui"), { recursive: true })
      writeFileSync(join(dir, "secret.txt"), "top secret")

      const response = await handleRequest(new Request("http://x/ui/%2e%2e/secret.txt"), baseDeps({
        uiDir: join(dir, "ui"),
        readFile: async path => {
          const { readFile } = await import("node:fs/promises")
          return readFile(path, "utf8")
        },
      }))
      expect(response.status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("unknown routes", () => {
  it("404s for anything not matching the three routes", async () => {
    const response = await handleRequest(new Request("http://x/nope"), baseDeps())
    expect(response.status).toBe(404)
  })
})
