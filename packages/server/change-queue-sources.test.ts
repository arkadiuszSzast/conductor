import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { realProcessRunner } from "./src/process.ts"
import type { ProcessRunner } from "./src/ports.ts"
import {
  archivedChangeName,
  ChangeQueueSources,
  diagnoseChange,
  type OpenSpecFiles,
} from "./src/change-queue-sources.ts"

const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function put(root: string, path: string, content = "x\n"): void {
  const full = join(root, path)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content)
}

let base: string
const logs: string[] = []
const log = { log: (message: string) => void logs.push(message) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "conductor-sources-"))
  logs.length = 0
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A bare remote plus the project clone (the daemon's checkout) and a second clone that plays "the PR merging". */
function repos(defaultBranch: string): { remote: string; project: string; other: string } {
  const remote = join(base, "remote.git")
  const seed = join(base, "seed")
  git(base, "init", "--bare", "-b", defaultBranch, remote)
  git(base, "init", "-b", defaultBranch, seed)
  put(seed, "README.md")
  git(seed, "add", "-A")
  git(seed, "commit", "-m", "init")
  git(seed, "remote", "add", "origin", remote)
  git(seed, "push", "origin", defaultBranch)
  const project = join(base, "project")
  const other = join(base, "other")
  git(base, "clone", remote, project)
  git(base, "clone", remote, other)
  return { remote, project, other }
}

function mergeArchiveOnRemote(other: string, defaultBranch: string, name: string, date = "2026-02-03"): void {
  put(other, `openspec/changes/archive/${date}-${name}/proposal.md`)
  git(other, "add", "-A")
  git(other, "commit", "-m", `archive ${name}`)
  git(other, "push", "origin", defaultBranch)
}

function sources(extra: Partial<ConstructorParameters<typeof ChangeQueueSources>[0]> = {}): ChangeQueueSources {
  return new ChangeQueueSources({ process: realProcessRunner, log, ...extra })
}

describe("archivedChangeName", () => {
  it("strips the leading date and rejects names without one", () => {
    expect(archivedChangeName("2026-02-03-quest-outcomes")).toBe("quest-outcomes")
    expect(archivedChangeName("2026-02-03-2026-style-name")).toBe("2026-style-name")
    expect(archivedChangeName("quest-outcomes")).toBeNull()
    expect(archivedChangeName("2026-02-03-")).toBeNull()
  })
})

describe("ChangeQueueSources.readMerged (temp git repo with a bare remote)", () => {
  it("counts a change archived on the remote default branch as merged, fetching first", async () => {
    const { project, other } = repos("main")
    mergeArchiveOnRemote(other, "main", "quest-outcomes")
    expect(git(project, "ls-tree", "--name-only", "HEAD", "openspec/changes/archive/").trim()).toBe("")

    const merged = await sources().readMerged(project)
    expect(merged).toEqual({ kind: "known", names: new Set(["quest-outcomes"]), defaultBranch: "main", stale: false })
  })

  it("does not count a change archived only in the local checkout", async () => {
    const { project } = repos("main")
    put(project, "openspec/changes/archive/2026-02-03-local-only/proposal.md")
    git(project, "add", "-A")
    git(project, "commit", "-m", "archive locally")

    const s = sources()
    const merged = await s.readMerged(project)
    expect(merged.kind === "known" && [...merged.names]).toEqual([])
    const local = await s.readLocal(project)
    expect(local.archived.has("local-only")).toBe(true)
  })

  it("follows a default branch other than main", async () => {
    const { project, other } = repos("trunk")
    mergeArchiveOnRemote(other, "trunk", "on-trunk")
    const merged = await sources().readMerged(project)
    expect(merged).toEqual({ kind: "known", names: new Set(["on-trunk"]), defaultBranch: "trunk", stale: false })
  })

  it("falls back to main when origin/HEAD is not set", async () => {
    const { project, other } = repos("main")
    mergeArchiveOnRemote(other, "main", "x")
    git(project, "remote", "set-head", "origin", "--delete")
    const merged = await sources().readMerged(project)
    expect(merged.kind === "known" && merged.defaultBranch).toBe("main")
    expect(merged.kind === "known" && merged.names.has("x")).toBe(true)
  })

  it("on a fetch failure uses the last known merged set and marks it stale", async () => {
    const { remote, project, other } = repos("main")
    mergeArchiveOnRemote(other, "main", "first")
    const s = sources()
    expect((await s.readMerged(project)).kind).toBe("known")

    rmSync(remote, { recursive: true, force: true })
    const after = await s.readMerged(project)
    expect(after).toEqual({ kind: "known", names: new Set(["first"]), defaultBranch: "main", stale: true })
    expect(logs.some(line => line.includes("last known merged set"))).toBe(true)
    expect(s.lastKnownMerged(project)).toEqual(new Set(["first"]))
  })

  it("on a fetch failure with no earlier success reports unknown instead of throwing", async () => {
    const { remote, project } = repos("main")
    rmSync(remote, { recursive: true, force: true })
    const merged = await sources().readMerged(project)
    expect(merged.kind).toBe("unknown")
    expect(logs.some(line => line.includes("merged set unknown"))).toBe(true)
  })

  it("bounds the fetch with a timeout and never lets git prompt", async () => {
    const calls: Array<{ command: readonly string[]; timeoutMs?: number; env?: Readonly<Record<string, string>> }> = []
    const fake: ProcessRunner = {
      async exec(command, options) {
        calls.push({ command, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.env !== undefined ? { env: options.env } : {}) })
        if (command[1] === "fetch") return { code: 124, stdout: "", stderr: "", output: "" }
        return { code: 1, stdout: "", stderr: "", output: "" }
      },
      async shell() {
        throw new Error("unused")
      },
    }
    const merged = await sources({ process: fake, fetchTimeoutMs: 1234 }).readMerged("/p")
    expect(merged.kind).toBe("unknown")
    const fetch = calls.find(call => call.command[1] === "fetch")!
    expect(fetch.command).toEqual(["git", "fetch", "--quiet", "origin", "main"])
    expect(fetch.timeoutMs).toBe(1234)
    expect(fetch.env).toEqual({ GIT_TERMINAL_PROMPT: "0" })
    expect(calls.some(call => call.command[1] === "ls-tree")).toBe(false)
  })
})

describe("ChangeQueueSources.readLocal", () => {
  function tree(): string {
    const project = join(base, "plain")
    put(project, "openspec/changes/a/.openspec.yaml", "schema: spec-driven\ndepends_on: [b, c]\n")
    put(project, "openspec/changes/a/proposal.md", "## Why\nbecause\n")
    put(project, "openspec/changes/b/.openspec.yaml", "schema: spec-driven\n")
    put(project, "openspec/changes/b/proposal.md", "p")
    put(project, "openspec/changes/c/proposal.md", "p")
    put(project, "openspec/changes/bad/.openspec.yaml", "depends_on: oops\n")
    put(project, "openspec/changes/broken/.openspec.yaml", "depends_on: [unclosed\n")
    put(project, "openspec/changes/archive/2026-01-02-old/proposal.md", "p")
    put(project, "openspec/changes/archive/not-dated/proposal.md", "p")
    return project
  }

  it("reads active and archived names (date prefix stripped) and depends_on per change", async () => {
    const local = await sources().readLocal(tree())
    expect([...local.active].sort()).toEqual(["a", "b", "bad", "broken", "c"])
    expect([...local.archived]).toEqual(["old"])
    expect(local.graph.get("a")).toEqual(["b", "c"])
    expect(local.graph.get("b")).toEqual([])
    expect(local.graph.get("c")).toEqual([])
    expect([...local.proposals].sort()).toEqual(["a", "b", "c"])
  })

  it("surfaces an unparseable or malformed .openspec.yaml as a diagnostic instead of crashing", async () => {
    const s = sources()
    const local = await s.readLocal(tree())
    expect([...local.unreadable.keys()].sort()).toEqual(["bad", "broken"])
    expect(local.graph.has("bad")).toBe(false)

    const diagnostics = diagnoseChange("bad", local, new Set())
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ kind: "invalid-depends-on", changes: ["bad"] })
    expect(diagnoseChange("broken", local, new Set())[0]).toMatchObject({ kind: "invalid-depends-on" })
  })

  it("returns empty sets when the project has no openspec directory", async () => {
    const local = await sources().readLocal(join(base, "nothing"))
    expect(local.active.size).toBe(0)
    expect(local.archived.size).toBe(0)
  })

  it("reads through the injected files port", async () => {
    const files: OpenSpecFiles = {
      async listDirectories(dir) {
        return dir.endsWith("openspec/changes") ? ["x", "archive"] : dir.endsWith("archive") ? ["2026-01-01-y"] : []
      },
      async readText(path) {
        if (path.endsWith("x/.openspec.yaml")) return "depends_on: [y]\n"
        if (path.endsWith("x/proposal.md")) return "p"
        return null
      },
    }
    const local = await sources({ files }).readLocal("/virtual")
    expect([...local.active]).toEqual(["x"])
    expect([...local.archived]).toEqual(["y"])
    expect(local.graph.get("x")).toEqual(["y"])
  })

  it("a file read error marks only that change unreadable", async () => {
    const files: OpenSpecFiles = {
      async listDirectories(dir) {
        return dir.endsWith("openspec/changes") ? ["ok", "boom"] : []
      },
      async readText(path) {
        if (path.includes("/boom/")) throw new Error("EACCES: denied")
        return path.endsWith("proposal.md") ? "p" : null
      },
    }
    const local = await sources({ files }).readLocal("/virtual")
    expect(local.unreadable.get("boom")).toContain("EACCES")
    expect(local.graph.get("ok")).toEqual([])
  })
})

describe("diagnoseChange", () => {
  it("reports a change without a directory or proposal as not startable, then falls through to graph validation", async () => {
    const files: OpenSpecFiles = {
      async listDirectories(dir) {
        return dir.endsWith("openspec/changes") ? ["a", "b", "noprop"] : []
      },
      async readText(path) {
        if (path.endsWith("a/.openspec.yaml")) return "depends_on: [b, ghost]\n"
        if (path.endsWith("b/.openspec.yaml")) return "depends_on: [a]\n"
        if (path.endsWith(".openspec.yaml")) return null
        return path.endsWith("noprop/proposal.md") ? null : "p"
      },
    }
    const local = await sources({ files }).readLocal("/virtual")
    expect(diagnoseChange("missing", local, new Set())[0]).toMatchObject({ kind: "not-startable" })
    expect(diagnoseChange("noprop", local, new Set())[0]).toMatchObject({ kind: "not-startable" })
    expect(diagnoseChange("a", local, new Set()).map(d => d.kind).sort()).toEqual(["cycle", "unknown-dependency"])
    expect(diagnoseChange("a", local, new Set(["ghost"])).map(d => d.kind)).toEqual(["cycle"])
  })
})
