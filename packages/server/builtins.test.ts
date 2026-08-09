import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { builtins } from "./src/engine/builtins.ts"
import { realProcessRunner } from "./src/engine/process.ts"
import type { FeatureState } from "./src/store.ts"
import type { GhClient, StorePort, ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/engine/ports.ts"
import type { EngineConfig } from "./src/engine/types.ts"

function feature(over: Partial<FeatureState> = {}): FeatureState {
  return {
    id: "f1",
    title: "F",
    slug: "f",
    projectDir: "/tmp/proj",
    workflow: null,
    description: null,
    status: "running",
    currentStep: "step",
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    attempts: {},
    rounds: {},
    escalation: null,
    ...over,
  }
}

function config(over: Partial<EngineConfig> = {}): EngineConfig {
  return {
    pipeline: [],
    roles: {},
    resolvedWorkflows: {},
    baseBranch: "main",
    runTtlMs: 3_600_000,
    nudgeIdleCycles: 2,
    maxNudges: 2,
    ...over,
  }
}

/** Records every command it was asked to run; scripted responses by exact command match. */
class FakeProcessRunner implements ProcessRunner {
  calls: Array<{ kind: "exec" | "shell"; command: string; cwd: string }> = []
  responses = new Map<string, ProcessExecResult>()

  private key(kind: "exec" | "shell", command: string): string {
    return `${kind}:${command}`
  }

  script(kind: "exec" | "shell", command: string, result: { code: number; stdout: string; stderr: string }): void {
    this.responses.set(this.key(kind, command), { ...result, output: result.stdout || result.stderr })
  }

  async exec(command: readonly string[], options: ProcessExecOptions): Promise<ProcessExecResult> {
    const joined = command.join(" ")
    this.calls.push({ kind: "exec", command: joined, cwd: options.cwd })
    return this.responses.get(this.key("exec", joined)) ?? { code: 0, stdout: "", stderr: "", output: "" }
  }

  async shell(command: string, options: ProcessExecOptions): Promise<ProcessExecResult> {
    this.calls.push({ kind: "shell", command, cwd: options.cwd })
    return this.responses.get(this.key("shell", command)) ?? { code: 0, stdout: "", stderr: "", output: "" }
  }
}

class FakeStore implements Partial<StorePort> {
  worktreeSet: { worktree: string | null; branch?: string | null } | null = null
  findings: Array<{ id: string; stepId: string; path: string; line: number; severity: string; tags: string[]; body: string; status: "new" | "fixed" | "dismissed" | "reopened"; resolution: string | null; threadId: string | null; synced: boolean }> = []
  prHeads = new Map<string, string>()

  setFeatureFields(_id: string, fields: Partial<{ worktree: string | null; branch: string | null }>): void {
    this.worktreeSet = { worktree: fields.worktree ?? null, ...(fields.branch !== undefined ? { branch: fields.branch } : {}) }
  }
  listFindings() {
    return this.findings
  }
  supersedeOldHeads(): number {
    return 0
  }
  getPrHead(pr: number, sha: string) {
    const status = this.prHeads.get(`${pr}:${sha}`)
    return status ? { status } : null
  }
  upsertPrHead(_featureId: string, pr: number, sha: string, status: string): void {
    this.prHeads.set(`${pr}:${sha}`, status)
  }
}

function fakeGh(over: Partial<GhClient> = {}): GhClient {
  return {
    prChecks: async () => ({ allConcluded: true, anyFailed: false, failedNames: [] }),
    prView: async () => ({ number: 1, headSha: "sha", state: "OPEN", mergeable: "MERGEABLE" }),
    prCreate: async () => 42,
    prMerge: async () => {},
    unresolvedThreadCount: async () => 0,
    unresolvedThreads: async () => [],
    resolveThread: async () => {},
    replyToThread: async () => {},
    reviewActivitySince: async () => 0,
    postComment: async () => ({ ok: true }),
    postReview: async () => ({ ok: true }),
    ...over,
  }
}

describe("builtins: worktree.create", () => {
  it("branches from origin/<base> and records worktree/branch on the store", async () => {
    const process = new FakeProcessRunner()
    process.script("exec", "git fetch origin main", { code: 0, stdout: "", stderr: "" })
    process.script("exec", "git rev-parse --quiet --verify --end-of-options main", { code: 0, stdout: "abc\n", stderr: "" })
    process.script("exec", "git rev-parse --quiet --verify --end-of-options origin/main", { code: 0, stdout: "abc\n", stderr: "" })
    const store = new FakeStore()

    const result = await builtins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config(),
      store: store as unknown as StorePort,
      gh: fakeGh(),
      process,
      params: {},
    })

    expect(result.kind).toBe("succeeded")
    expect(store.worktreeSet?.branch).toBe("feat/f")
    // the worktree add command used the injected process, not a global shell,
    // and runs as argv (no shell interpolation).
    expect(process.calls.some(c => c.kind === "exec" && c.command.startsWith("git worktree add"))).toBe(true)
    expect(process.calls.every(c => c.kind === "exec")).toBe(true)
  })

  it("degrades gracefully when git fetch fails (offline)", async () => {
    const process = new FakeProcessRunner()
    process.script("exec", "git fetch origin main", { code: 1, stdout: "", stderr: "network unreachable" })
    const store = new FakeStore()

    const result = await builtins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config(),
      store: store as unknown as StorePort,
      gh: fakeGh(),
      process,
      params: {},
    })

    expect(result.kind).toBe("succeeded")
    expect(result.kind === "succeeded" && result.output).toContain("offline")
  })

  it("rejects an option-like branch name before it reaches argv", async () => {
    const process = new FakeProcessRunner()
    const store = new FakeStore()

    const result = await builtins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config(),
      store: store as unknown as StorePort,
      gh: fakeGh(),
      process,
      params: { branch: "--upload-pack=evil" },
    })

    expect(result.kind).toBe("failed")
    expect(process.calls.some(c => c.command.includes("--upload-pack=evil"))).toBe(false)
  })

  it("rejects a malicious base branch containing shell metacharacters as a literal ref, never interpolated", async () => {
    const process = new FakeProcessRunner()
    // check-ref-format rejects refs with a backslash; anything else it
    // accepts as a LITERAL ref string (shell metacharacters are not
    // special once argv, not a shell line, is what runs).
    process.script("exec", 'git check-ref-format --allow-onelevel main; touch pwned', { code: 1, stdout: "", stderr: "" })
    const store = new FakeStore()

    const result = await builtins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config({ baseBranch: "main; touch pwned" }),
      store: store as unknown as StorePort,
      gh: fakeGh(),
      process,
      params: {},
    })

    expect(result.kind).toBe("failed")
    // the metacharacter-laden string was passed as ONE argv element to
    // check-ref-format, never executed by a shell.
    expect(process.calls.some(c => c.kind === "exec" && c.command.includes("git fetch"))).toBe(false)
  })

  it("refuses a worktree path that would escape the resolved worktree root", async () => {
    const process = new FakeProcessRunner()
    const store = new FakeStore()

    const result = await builtins["worktree.create"]!({
      feature: feature({ slug: "../../../etc/evil" }),
      stepId: "worktree",
      config: config(),
      store: store as unknown as StorePort,
      gh: fakeGh(),
      process,
      params: {},
    })

    expect(result.kind).toBe("failed")
    expect(result.kind === "failed" && result.reason).toContain("escapes worktree root")
    expect(process.calls.some(c => c.command.includes("worktree add"))).toBe(false)
  })

  it("end-to-end against a real git repo: shell metacharacters in branch/base stay literal, never executed", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "conductor-worktree-"))
    const marker = path.join(tmpdir(), `conductor-pwn-marker-${Date.now()}`)
    try {
      await realProcessRunner.exec(["git", "init", "-q"], { cwd: projectDir })
      await realProcessRunner.exec(["git", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: projectDir })
      await realProcessRunner.exec(["git", "branch", "-M", "main"], { cwd: projectDir })

      const result = await builtins["worktree.create"]!({
        feature: feature({ projectDir, slug: "f", worktree: null, branch: null }),
        stepId: "worktree",
        config: config({ baseBranch: `main;touch ${marker}` }),
        store: { setFeatureFields: () => {} } as unknown as StorePort,
        gh: fakeGh(),
        process: realProcessRunner,
        params: {},
      })

      expect(result.kind).toBe("failed")
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(marker, { force: true })
    }
  })
})

describe("builtins: worktree.create against a real git repo (origin/divergence/layout)", () => {
  let root: string
  let originDir: string
  let cloneDir: string

  async function sh(cmd: string, cwd: string): Promise<string> {
    const result = await realProcessRunner.shell(cmd, { cwd })
    if (result.code !== 0) throw new Error(`${cmd} failed: ${result.output}`)
    return result.output
  }

  async function initRepo(): Promise<void> {
    root = mkdtempSync(path.join(tmpdir(), "conductor-git-"))
    originDir = path.join(root, "origin.git")
    cloneDir = path.join(root, "project")
    await sh(`git init --bare -b main ${JSON.stringify(originDir)}`, root)
    await sh(`git clone ${JSON.stringify(originDir)} ${JSON.stringify(cloneDir)}`, root)
    await sh(`git -C ${JSON.stringify(cloneDir)} -c user.email=t@t -c user.name=t -c commit.gpgSign=false commit --allow-empty -m root`, root)
    await sh(`git -C ${JSON.stringify(cloneDir)} push origin main`, root)
  }

  function cleanup(): void {
    rmSync(root, { recursive: true, force: true })
  }

  it("bases the branch on origin/<base>, including commits merged there after the local clone went stale", async () => {
    await initRepo()
    try {
      const otherClone = path.join(root, "other")
      await sh(`git clone ${JSON.stringify(originDir)} ${JSON.stringify(otherClone)}`, root)
      const { writeFileSync } = await import("node:fs")
      writeFileSync(path.join(otherClone, "merged-on-origin.txt"), "new\n")
      await sh(`git -C ${JSON.stringify(otherClone)} add . && git -C ${JSON.stringify(otherClone)} -c user.email=t@t -c user.name=t -c commit.gpgSign=false commit -m "merged PR"`, root)
      await sh(`git -C ${JSON.stringify(otherClone)} push origin main`, root)

      const result = await builtins["worktree.create"]!({
        feature: feature({ projectDir: cloneDir, slug: "wt-fresh", worktree: null, branch: null }),
        stepId: "worktree",
        config: config(),
        store: new FakeStore() as unknown as StorePort,
        gh: fakeGh(),
        process: realProcessRunner,
        params: {},
      })
      expect(result.kind).toBe("succeeded")
      const worktree = `${cloneDir}-wt-fresh`
      const files = await sh("ls", worktree)
      expect(files).toContain("merged-on-origin.txt")
    } finally {
      cleanup()
    }
  })

  it("reports divergence when the local base has local-only commits (not included)", async () => {
    await initRepo()
    try {
      const { writeFileSync } = await import("node:fs")
      writeFileSync(path.join(cloneDir, "local-only.txt"), "local\n")
      await sh(`git -C ${JSON.stringify(cloneDir)} add . && git -C ${JSON.stringify(cloneDir)} -c user.email=t@t -c user.name=t -c commit.gpgSign=false commit -m "local only"`, root)

      const result = await builtins["worktree.create"]!({
        feature: feature({ projectDir: cloneDir, slug: "wt-diverged", worktree: null, branch: null }),
        stepId: "worktree",
        config: config(),
        store: new FakeStore() as unknown as StorePort,
        gh: fakeGh(),
        process: realProcessRunner,
        params: {},
      })
      expect(result.kind).toBe("succeeded")
      expect(result.kind === "succeeded" ? result.output : "").toContain("local-only commits are not included")

      const worktree = `${cloneDir}-wt-diverged`
      const files = await sh("ls", worktree)
      expect(files).not.toContain("local-only.txt")
    } finally {
      cleanup()
    }
  })

  it("places worktrees inside a configured worktreeDir as <slug>", async () => {
    await initRepo()
    try {
      const store = new FakeStore()
      const result = await builtins["worktree.create"]!({
        feature: feature({ projectDir: cloneDir, slug: "wt-custom", worktree: null, branch: null }),
        stepId: "worktree",
        config: config({ worktreeDir: "../wt-farm/{project}" }),
        store: store as unknown as StorePort,
        gh: fakeGh(),
        process: realProcessRunner,
        params: {},
      })
      expect(result.kind).toBe("succeeded")
      const expected = path.join(path.dirname(cloneDir), "wt-farm", path.basename(cloneDir), "wt-custom")
      expect(store.worktreeSet?.worktree).toBe(expected)
      expect(existsSync(expected)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("default layout is unchanged: ../<project>-<slug>", async () => {
    await initRepo()
    try {
      const store = new FakeStore()
      const result = await builtins["worktree.create"]!({
        feature: feature({ projectDir: cloneDir, slug: "wt-default", worktree: null, branch: null }),
        stepId: "worktree",
        config: config(),
        store: store as unknown as StorePort,
        gh: fakeGh(),
        process: realProcessRunner,
        params: {},
      })
      expect(result.kind).toBe("succeeded")
      expect(store.worktreeSet?.worktree).toBe(`${cloneDir}-wt-default`)
      expect(existsSync(`${cloneDir}-wt-default`)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe("builtins: worktree.remove / git.push argv safety", () => {
  it("git.push validates the branch via check-ref-format and never touches the shell", async () => {
    const process = new FakeProcessRunner()
    const result = await builtins["git.push"]!({
      feature: feature({ branch: "feat/f; rm -rf /" }),
      stepId: "push",
      config: config(),
      store: new FakeStore() as unknown as StorePort,
      gh: fakeGh(),
      process,
      params: {},
    })
    // The metacharacter-laden branch string is passed as a SINGLE argv
    // element to check-ref-format and (if it were valid) to `git push` —
    // never a shell string that could split/expand it.
    expect(process.calls.every(c => c.kind === "exec")).toBe(true)
    expect(process.calls.some(c => c.command === "git check-ref-format --allow-onelevel feat/f; rm -rf /")).toBe(true)
    expect(result.kind).toBe("succeeded")
  })

  it("realProcessRunner rejects a branch containing shell metacharacters as an invalid ref (never executes them)", async () => {
    const result = await builtins["git.push"]!({
      feature: feature({ branch: "feat/f; touch /tmp/conductor-pwn-test", projectDir: "/tmp" }),
      stepId: "push",
      config: config(),
      store: new FakeStore() as unknown as StorePort,
      gh: fakeGh(),
      process: realProcessRunner,
      params: {},
    })
    expect(result.kind).toBe("failed")
    expect(existsSync("/tmp/conductor-pwn-test")).toBe(false)
  })

  it("worktree.remove passes the stored worktree path through -- as argv, never a shell string", async () => {
    const process = new FakeProcessRunner()
    process.script("exec", 'git worktree remove --force -- /tmp/proj-f; rm -rf /', { code: 0, stdout: "", stderr: "" })
    const result = await builtins["worktree.remove"]!({
      feature: feature({ worktree: "/tmp/proj-f; rm -rf /" }),
      stepId: "cleanup",
      config: config(),
      store: new FakeStore() as unknown as StorePort,
      gh: fakeGh(),
      process,
      params: {},
    })
    expect(result.kind).toBe("succeeded")
    expect(process.calls.every(c => c.kind === "exec")).toBe(true)
  })
})

describe("builtins: pr.await_checks", () => {
  it("returns pending while checks have not all concluded", async () => {
    const outcome = await builtins["pr.await_checks"]!({
      feature: feature({ pr: 7 }),
      stepId: "await_ci",
      config: config({ repo: "o/r" }),
      store: new FakeStore() as unknown as StorePort,
      gh: fakeGh({ prChecks: async () => ({ allConcluded: false, anyFailed: false, failedNames: [] }) }),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("pending")
  })

  it("fails loudly on a conflicting PR instead of polling forever", async () => {
    const outcome = await builtins["pr.await_checks"]!({
      feature: feature({ pr: 7 }),
      stepId: "await_ci",
      config: config({ repo: "o/r" }),
      store: new FakeStore() as unknown as StorePort,
      gh: fakeGh({ prView: async () => ({ number: 7, headSha: "sha", state: "OPEN", mergeable: "CONFLICTING" }) }),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.reason).toContain("merge conflicts")
  })
})

describe("builtins: findings.check", () => {
  it("blocks on any open finding during the polish round", async () => {
    const store = new FakeStore()
    store.findings = [{ id: "F1", stepId: "review", path: "a.ts", line: 1, severity: "nit", tags: [], body: "x", status: "new", resolution: null, threadId: null, synced: false }]
    const outcome = await builtins["findings.check"]!({
      feature: feature({ attempts: {} }),
      stepId: "gate",
      config: config(),
      store: store as unknown as StorePort,
      gh: fakeGh(),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("failed")
  })

  it("after polish, only blocking severities count", async () => {
    const store = new FakeStore()
    store.findings = [{ id: "F1", stepId: "review", path: "a.ts", line: 1, severity: "nit", tags: [], body: "x", status: "new", resolution: null, threadId: null, synced: false }]
    const outcome = await builtins["findings.check"]!({
      feature: feature({ attempts: { gate: 1 } }),
      stepId: "gate",
      config: config(),
      store: store as unknown as StorePort,
      gh: fakeGh(),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("succeeded")
  })
})
