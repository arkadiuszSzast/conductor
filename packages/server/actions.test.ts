import { describe, expect, it } from "bun:test"
import { gitWorktree } from "./src/actions/git-worktree.ts"
import { gitWorktreeRemove } from "./src/actions/git-worktree-remove.ts"
import { gitPush } from "./src/actions/git-push.ts"
import { githubPrCreate } from "./src/actions/github-pr-create.ts"
import { githubAwaitChecks } from "./src/actions/github-await-checks.ts"
import { githubPrMerge } from "./src/actions/github-pr-merge.ts"
import { bundledHandlers } from "./src/actions/bundled.ts"
import type { ActionHostDeps } from "./src/action-host.ts"
import type { ActionRunContext } from "@conductor/core"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/ports.ts"

class FakeProcess implements ProcessRunner {
  calls: Array<{ command: readonly string[]; options: ProcessExecOptions }> = []
  handlers: Array<(command: readonly string[], options: ProcessExecOptions) => ProcessExecResult> = []
  default: ProcessExecResult = { code: 0, stdout: "", stderr: "", output: "" }

  async exec(command: readonly string[], options: ProcessExecOptions): Promise<ProcessExecResult> {
    this.calls.push({ command, options })
    const index = this.calls.length - 1
    return this.handlers[index]?.(command, options) ?? this.default
  }
  async shell(command: string, options: ProcessExecOptions): Promise<ProcessExecResult> {
    this.calls.push({ command: [command], options })
    return this.default
  }
  argv(): readonly (readonly string[])[] {
    return this.calls.map(call => call.command)
  }
}

function deps(process_: FakeProcess, sleep?: (ms: number) => Promise<void>, now?: () => number): ActionHostDeps {
  return { process: process_, log: { log: () => {} }, sleep: sleep ?? (async () => {}), now: now ?? Date.now, runLog: () => {} }
}

function ctx(inputs: Readonly<Record<string, unknown>>, overrides: Partial<ActionRunContext> = {}): ActionRunContext {
  return {
    featureId: "f1",
    jobId: "main",
    stepId: "step",
    workdir: "/repo",
    inputs,
    capabilities: ["filesystem", "process", "network", "git", "credentials"],
    ...overrides,
  }
}

const ok = (stdout = ""): ProcessExecResult => ({ code: 0, stdout, stderr: "", output: stdout })
const fail = (code = 1, output = "error"): ProcessExecResult => ({ code, stdout: "", stderr: output, output })

describe("git/worktree", () => {
  it("creates a worktree when none exists, with argv-only git calls and a default path relative to workdir", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => ok(), // check-ref-format
      () => ok(""), // worktree list --porcelain (empty)
      () => ok(), // worktree add
    ]
    const result = await gitWorktree(ctx({ branch: "feat/x" }), deps(process_))

    expect(result.status).toBe("succeeded")
    if (result.status !== "succeeded") return
    expect(result.outputs.created).toBe(true)
    expect(result.outputs.path).toBe("/repo-worktrees/feat-x")
    expect(process_.argv()).toEqual([
      ["git", "check-ref-format", "--branch", "feat/x"],
      ["git", "worktree", "list", "--porcelain"],
      ["git", "worktree", "add", "/repo-worktrees/feat-x", "-b", "feat/x", "main"],
    ])
  })

  it("is idempotent: an existing worktree for the same branch at the target path succeeds without mutation", async () => {
    const process_ = new FakeProcess()
    const porcelain = "worktree /repo-worktrees/feat-x\nHEAD abc123\nbranch refs/heads/feat/x\n"
    process_.handlers = [
      () => ok(),
      () => ok(porcelain),
    ]
    const result = await gitWorktree(ctx({ branch: "feat/x" }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { path: "/repo-worktrees/feat-x", created: false } })
    expect(process_.argv()).toEqual([
      ["git", "check-ref-format", "--branch", "feat/x"],
      ["git", "worktree", "list", "--porcelain"],
    ])
  })

  it("a bad branch ref fails at check-ref-format with no worktree list/add calls", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => fail(1, "fatal: not a valid ref name")]
    const result = await gitWorktree(ctx({ branch: "..bad..ref" }), deps(process_))

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect(result.error).toContain("invalid branch name")
    expect(process_.argv()).toEqual([["git", "check-ref-format", "--branch", "..bad..ref"]])
  })

  it("honours an explicit dir input, resolved relative to workdir", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok(""), () => ok()]
    const result = await gitWorktree(ctx({ branch: "feat/x", dir: "../custom-wt" }), deps(process_))

    expect(result.status).toBe("succeeded")
    if (result.status !== "succeeded") return
    expect(result.outputs.path).toBe("/custom-wt")
  })

  it("branches from the given base", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok(""), () => ok()]
    await gitWorktree(ctx({ branch: "feat/x", base: "develop" }), deps(process_))
    expect(process_.argv().at(-1)).toEqual(["git", "worktree", "add", "/repo-worktrees/feat-x", "-b", "feat/x", "develop"])
  })
})

describe("git/worktree-remove", () => {
  it("removes an existing worktree, argv-only, honouring force", async () => {
    const process_ = new FakeProcess()
    const porcelain = "worktree /repo-worktrees/feat-x\nHEAD abc\nbranch refs/heads/feat/x\n"
    process_.handlers = [() => ok(porcelain), () => ok()]
    const result = await gitWorktreeRemove(ctx({ path: "/repo-worktrees/feat-x", force: true }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { removed: true } })
    expect(process_.argv()).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "worktree", "remove", "--force", "/repo-worktrees/feat-x"],
    ])
  })

  it("is idempotent: a path that is not a worktree succeeds with removed: false", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok("")]
    const result = await gitWorktreeRemove(ctx({ path: "/not-a-worktree" }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { removed: false } })
    expect(process_.argv()).toEqual([["git", "worktree", "list", "--porcelain"]])
  })
})

describe("git/push", () => {
  it("pushes with -u by default and resolves HEAD's sha", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok("abc123def\n")]
    const result = await gitPush(ctx({ branch: "feat/x" }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { sha: "abc123def" } })
    expect(process_.argv()).toEqual([
      ["git", "push", "-u", "origin", "feat/x"],
      ["git", "rev-parse", "HEAD"],
    ])
  })

  it("omits -u when set_upstream is false and honours a custom remote", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok("sha1\n")]
    await gitPush(ctx({ branch: "feat/x", remote: "upstream", set_upstream: false }), deps(process_))

    expect(process_.argv()[0]).toEqual(["git", "push", "upstream", "feat/x"])
  })

  it("fails when git push exits non-zero", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => fail(1, "rejected")]
    const result = await gitPush(ctx({ branch: "feat/x" }), deps(process_))
    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect(result.error).toContain("rejected")
  })
})

describe("github/pr-create", () => {
  it("creates a PR and parses the number from the printed URL", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok("https://github.com/o/r/pull/42\n")]
    const result = await githubPrCreate(ctx({ title: "T", head: "feat/x" }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { number: 42, url: "https://github.com/o/r/pull/42" } })
    expect(process_.argv()).toEqual([
      ["gh", "pr", "create", "--title", "T", "--body", "", "--base", "main", "--head", "feat/x"],
    ])
  })

  it("recovers idempotently when a PR already exists via gh pr view", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => fail(1, "a pull request for branch \"feat/x\" into branch \"main\" already exists"),
      () => ok(JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7" })),
    ]
    const result = await githubPrCreate(ctx({ title: "T", head: "feat/x" }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { number: 7, url: "https://github.com/o/r/pull/7" } })
    expect(process_.argv()[1]).toEqual(["gh", "pr", "view", "feat/x", "--json", "number,url"])
  })

  it("includes --draft when requested", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok("https://github.com/o/r/pull/1\n")]
    await githubPrCreate(ctx({ title: "T", head: "feat/x", draft: true }), deps(process_))
    expect(process_.argv()[0]).toContain("--draft")
  })
})

describe("github/await-checks", () => {
  it("succeeds once all checks conclude with no failures", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(JSON.stringify([{ name: "build", state: "SUCCESS" }, { name: "test", state: "SUCCESS" }]))]
    const result = await githubAwaitChecks(ctx({ pr: 5 }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { conclusion: "success" } })
  })

  it("fails and lists the failing check names", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(JSON.stringify([
      { name: "build", state: "SUCCESS" },
      { name: "test", state: "FAILURE" },
    ]))]
    const result = await githubAwaitChecks(ctx({ pr: 5 }), deps(process_))

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect(result.error).toContain("test")
    expect(result.error).not.toContain("build")
  })

  it("returns a durable pending result on first observation with unconcluded checks, one exec per invocation", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(JSON.stringify([{ name: "build", state: "PENDING" }]))]
    const result = await githubAwaitChecks(ctx({ pr: 5, timeout_minutes: 1, poll_seconds: 15 }), deps(process_, undefined, () => 0))

    expect(result.status).toBe("pending")
    if (result.status !== "pending") return
    expect(result.nextPollMs).toBe(15000)
    expect(result.state?.deadline).toBe(60_000)
    expect(process_.calls).toHaveLength(1)
  })

  it("resuming with the deadline passed and checks still pending fails with a timeout, without a fresh exec loop", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(JSON.stringify([{ name: "build", state: "PENDING" }]))]
    const result = await githubAwaitChecks(
      ctx({ pr: 5, timeout_minutes: 1 }, { resume: { deadline: 1000 } }),
      deps(process_, undefined, () => 2000),
    )

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect(result.error).toContain("timed out")
    expect(process_.calls).toHaveLength(1)
  })

  it("resuming succeeds once checks conclude, using the deadline carried in ctx.resume", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(JSON.stringify([{ name: "build", state: "SUCCESS" }]))]
    const result = await githubAwaitChecks(
      ctx({ pr: 5 }, { resume: { deadline: 999_999 } }),
      deps(process_, undefined, () => 500),
    )

    expect(result).toEqual({ status: "succeeded", outputs: { conclusion: "success" } })
    expect(process_.calls).toHaveLength(1)
  })
})

describe("github/pr-merge", () => {
  it("merges with the requested method, resolves the sha, then deletes the branch best-effort", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => ok(),
      () => ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "deadbeef" } })),
      () => ok("feature/x\n"),
      () => ok(),
      () => fail(1, "cannot delete branch used by worktree"),
    ]
    const result = await githubPrMerge(ctx({ pr: 9 }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { merged_sha: "deadbeef" } })
    expect(process_.argv()).toEqual([
      ["gh", "pr", "merge", "9", "--squash"],
      ["gh", "pr", "view", "9", "--json", "state,mergeCommit"],
      ["gh", "pr", "view", "9", "--json", "headRefName", "--jq", ".headRefName"],
      ["git", "push", "origin", "--delete", "feature/x"],
      ["git", "branch", "-D", "feature/x"],
    ])
  })

  it("honours method and delete_branch inputs", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "sha" } }))]
    const result = await githubPrMerge(ctx({ pr: 9, method: "rebase", delete_branch: false }), deps(process_))
    expect(result.status).toBe("succeeded")
    expect(process_.argv()).toEqual([
      ["gh", "pr", "merge", "9", "--rebase"],
      ["gh", "pr", "view", "9", "--json", "state,mergeCommit"],
    ])
  })

  it("an already-merged PR is a success, not a failure — merge is idempotent", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => fail(1, "! Pull request #9 was already merged"),
      () => ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "cafe" } })),
    ]
    const result = await githubPrMerge(ctx({ pr: 9, delete_branch: false }), deps(process_))
    expect(result).toEqual({ status: "succeeded", outputs: { merged_sha: "cafe" } })
  })

  it("fails when gh pr merge exits non-zero", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => fail(1, "not mergeable")]
    const result = await githubPrMerge(ctx({ pr: 9 }), deps(process_))
    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect(result.error).toContain("not mergeable")
  })
})

describe("bundled handler registry", () => {
  it("registers exactly the six bundled handlers by name", () => {
    expect(Object.keys(bundledHandlers).sort()).toEqual([
      "git/push",
      "git/worktree",
      "git/worktree-remove",
      "github/await-checks",
      "github/pr-create",
      "github/pr-merge",
    ])
  })
})
