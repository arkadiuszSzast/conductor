import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { legacyBuiltins } from "./src/legacy/builtins.ts"
import { realProcessRunner } from "./src/legacy/process.ts"
import type { LegacyFeatureState } from "./src/store.ts"
import type { LegacyGh, LegacyStorePort, ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/legacy/ports.ts"
import type { LegacyConfig } from "./src/legacy/types.ts"

function feature(over: Partial<LegacyFeatureState> = {}): LegacyFeatureState {
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

function config(over: Partial<LegacyConfig> = {}): LegacyConfig {
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

class FakeStore implements Partial<LegacyStorePort> {
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

function fakeGh(over: Partial<LegacyGh> = {}): LegacyGh {
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

describe("legacyBuiltins: worktree.create", () => {
  it("branches from origin/<base> and records worktree/branch on the store", async () => {
    const process = new FakeProcessRunner()
    process.script("exec", "git fetch origin main", { code: 0, stdout: "", stderr: "" })
    process.script("exec", "git rev-parse --quiet --verify --end-of-options main", { code: 0, stdout: "abc\n", stderr: "" })
    process.script("exec", "git rev-parse --quiet --verify --end-of-options origin/main", { code: 0, stdout: "abc\n", stderr: "" })
    const store = new FakeStore()

    const result = await legacyBuiltins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config(),
      store: store as unknown as LegacyStorePort,
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

    const result = await legacyBuiltins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config(),
      store: store as unknown as LegacyStorePort,
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

    const result = await legacyBuiltins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config(),
      store: store as unknown as LegacyStorePort,
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

    const result = await legacyBuiltins["worktree.create"]!({
      feature: feature(),
      stepId: "worktree",
      config: config({ baseBranch: "main; touch pwned" }),
      store: store as unknown as LegacyStorePort,
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

    const result = await legacyBuiltins["worktree.create"]!({
      feature: feature({ slug: "../../../etc/evil" }),
      stepId: "worktree",
      config: config(),
      store: store as unknown as LegacyStorePort,
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

      const result = await legacyBuiltins["worktree.create"]!({
        feature: feature({ projectDir, slug: "f", worktree: null, branch: null }),
        stepId: "worktree",
        config: config({ baseBranch: `main;touch ${marker}` }),
        store: { setFeatureFields: () => {} } as unknown as LegacyStorePort,
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

describe("legacyBuiltins: worktree.remove / git.push argv safety", () => {
  it("git.push validates the branch via check-ref-format and never touches the shell", async () => {
    const process = new FakeProcessRunner()
    const result = await legacyBuiltins["git.push"]!({
      feature: feature({ branch: "feat/f; rm -rf /" }),
      stepId: "push",
      config: config(),
      store: new FakeStore() as unknown as LegacyStorePort,
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
    const result = await legacyBuiltins["git.push"]!({
      feature: feature({ branch: "feat/f; touch /tmp/conductor-pwn-test", projectDir: "/tmp" }),
      stepId: "push",
      config: config(),
      store: new FakeStore() as unknown as LegacyStorePort,
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
    const result = await legacyBuiltins["worktree.remove"]!({
      feature: feature({ worktree: "/tmp/proj-f; rm -rf /" }),
      stepId: "cleanup",
      config: config(),
      store: new FakeStore() as unknown as LegacyStorePort,
      gh: fakeGh(),
      process,
      params: {},
    })
    expect(result.kind).toBe("succeeded")
    expect(process.calls.every(c => c.kind === "exec")).toBe(true)
  })
})

describe("legacyBuiltins: pr.await_checks", () => {
  it("returns pending while checks have not all concluded", async () => {
    const outcome = await legacyBuiltins["pr.await_checks"]!({
      feature: feature({ pr: 7 }),
      stepId: "await_ci",
      config: config({ repo: "o/r" }),
      store: new FakeStore() as unknown as LegacyStorePort,
      gh: fakeGh({ prChecks: async () => ({ allConcluded: false, anyFailed: false, failedNames: [] }) }),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("pending")
  })

  it("fails loudly on a conflicting PR instead of polling forever", async () => {
    const outcome = await legacyBuiltins["pr.await_checks"]!({
      feature: feature({ pr: 7 }),
      stepId: "await_ci",
      config: config({ repo: "o/r" }),
      store: new FakeStore() as unknown as LegacyStorePort,
      gh: fakeGh({ prView: async () => ({ number: 7, headSha: "sha", state: "OPEN", mergeable: "CONFLICTING" }) }),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.reason).toContain("merge conflicts")
  })
})

describe("legacyBuiltins: findings.check", () => {
  it("blocks on any open finding during the polish round", async () => {
    const store = new FakeStore()
    store.findings = [{ id: "F1", stepId: "review", path: "a.ts", line: 1, severity: "nit", tags: [], body: "x", status: "new", resolution: null, threadId: null, synced: false }]
    const outcome = await legacyBuiltins["findings.check"]!({
      feature: feature({ attempts: {} }),
      stepId: "gate",
      config: config(),
      store: store as unknown as LegacyStorePort,
      gh: fakeGh(),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("failed")
  })

  it("after polish, only blocking severities count", async () => {
    const store = new FakeStore()
    store.findings = [{ id: "F1", stepId: "review", path: "a.ts", line: 1, severity: "nit", tags: [], body: "x", status: "new", resolution: null, threadId: null, synced: false }]
    const outcome = await legacyBuiltins["findings.check"]!({
      feature: feature({ attempts: { gate: 1 } }),
      stepId: "gate",
      config: config(),
      store: store as unknown as LegacyStorePort,
      gh: fakeGh(),
      process: new FakeProcessRunner(),
      params: {},
    })
    expect(outcome.kind).toBe("succeeded")
  })
})
