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
      () => fail(1, ""), // show-ref: branch does not exist yet
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
      ["git", "show-ref", "--verify", "--quiet", "refs/heads/feat/x"],
      ["git", "worktree", "add", "/repo-worktrees/feat-x", "-b", "feat/x", "main"],
    ])
  })

  it("attaches to an existing branch (no -b) when the branch survives from an earlier feature", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => ok(), // check-ref-format
      () => ok(""), // worktree list: no worktree for it
      () => ok(), // show-ref: branch exists
      () => ok(), // worktree add (attach)
    ]
    const result = await gitWorktree(ctx({ branch: "feat/x" }), deps(process_))

    expect(result.status).toBe("succeeded")
    if (result.status !== "succeeded") return
    expect(result.outputs.created).toBe(true)
    expect(process_.argv().at(-1)).toEqual(["git", "worktree", "add", "/repo-worktrees/feat-x", "feat/x"])
  })

  it("fails with a pointer when the branch is checked out in a different worktree path", async () => {
    const process_ = new FakeProcess()
    const porcelain = "worktree /elsewhere/feat-x\nHEAD abc123\nbranch refs/heads/feat/x\n"
    process_.handlers = [() => ok(), () => ok(porcelain)]
    const result = await gitWorktree(ctx({ branch: "feat/x" }), deps(process_))

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect(result.error).toContain("already checked out in another worktree at /elsewhere/feat-x")
    expect(process_.argv()).toHaveLength(2)
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
    process_.handlers = [() => ok(), () => ok(""), () => fail(1, ""), () => ok()]
    const result = await gitWorktree(ctx({ branch: "feat/x", dir: "../custom-wt" }), deps(process_))

    expect(result.status).toBe("succeeded")
    if (result.status !== "succeeded") return
    expect(result.outputs.path).toBe("/custom-wt")
  })

  it("branches from the given base", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok(""), () => fail(1, ""), () => ok()]
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
  const sha = "a".repeat(40)

  it("pins the requested branch despite a different checkout and movement during push", async () => {
    const process_ = new FakeProcess()
    let branchSha = sha
    const ambientHead = "b".repeat(40)
    process_.handlers = [
      () => ok(),
      command => ok(command.includes("HEAD") ? ambientHead : branchSha),
      command => {
        branchSha = "c".repeat(40)
        expect(command).toEqual(["git", "push", "--", "origin", `${sha}:refs/heads/feat/x`])
        return ok()
      },
      () => ok(),
    ]
    const result = await gitPush(ctx({ branch: "feat/x" }), deps(process_))
    expect(result).toEqual({ status: "succeeded", outputs: { sha } })
    expect(branchSha).not.toBe(sha)
    expect(process_.argv()).toEqual([
      ["git", "check-ref-format", "refs/heads/feat/x"],
      ["git", "rev-parse", "--verify", "refs/heads/feat/x^{commit}"],
      ["git", "push", "--", "origin", `${sha}:refs/heads/feat/x`],
      ["git", "branch", "--set-upstream-to=origin/feat/x", "--", "feat/x"],
    ])
  })

  it("omits upstream setup when disabled and honours a custom remote", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok(sha), () => ok()]
    const result = await gitPush(ctx({ branch: "feat/x", remote: "upstream", set_upstream: false }), deps(process_))
    expect(result.status).toBe("succeeded")
    expect(process_.argv().at(-1)).toEqual(["git", "push", "--", "upstream", `${sha}:refs/heads/feat/x`])
    expect(process_.calls).toHaveLength(3)
  })

  it.each(["invalid", "missing", "malformed", "rejected", "upstream"])("fails explicitly for %s", async failure => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => failure === "invalid" ? fail(1, failure) : ok(),
      () => failure === "missing" ? fail(1, failure) : ok(failure === "malformed" ? "not-a-sha" : sha),
      () => failure === "rejected" ? fail(1, failure) : ok(),
      () => fail(1, "upstream"),
    ]
    const result = await gitPush(ctx({ branch: "feat/x" }), deps(process_))
    expect(result.status).toBe("failed")
    expect(process_.calls).toHaveLength(failure === "invalid" ? 1 : ["missing", "malformed"].includes(failure) ? 2 : failure === "rejected" ? 3 : 4)
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
  const sha = "a".repeat(40)
  const old = "b".repeat(40)
  const inputs = { pr: 5, expected_sha: sha, required_checks: ["build", "test"], timeout_minutes: 1, poll_seconds: 15 }
  const check = (name: string, conclusion: string | null = "success", status = "completed", head_sha = sha) => ({ name, conclusion, status, head_sha })
  function observation(checks: unknown[] = [], statuses: unknown[] = [], firstHead = sha, lastHead = sha): FakeProcess {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => ok(JSON.stringify({ headRefOid: firstHead })),
      () => ok(JSON.stringify([{ check_runs: checks }])),
      () => ok(JSON.stringify([{ sha, statuses }])),
      () => ok(JSON.stringify({ headRefOid: lastHead })),
    ]
    return process_
  }

  it("succeeds for exact-head required checks and emits validated SHA", async () => {
    const process_ = observation([check("build"), check("test")])
    expect(await githubAwaitChecks(ctx(inputs), deps(process_))).toEqual({ status: "succeeded", outputs: { conclusion: "success", sha } })
    expect(process_.argv()).toEqual([
      ["gh", "pr", "view", "5", "--json", "headRefOid"],
      ["gh", "api", `repos/{owner}/{repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, "--paginate", "--slurp"],
      ["gh", "api", `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`, "--paginate", "--slurp"],
      ["gh", "pr", "view", "5", "--json", "headRefOid"],
    ])
  })

  it.each(["absent", "old", "partial", "pending", "unknown"])("keeps %s evidence pending without renewing the deadline", async kind => {
    const checks = kind === "absent" ? [] : kind === "old" ? [check("build", "success", "completed", old), check("test", "success", "completed", old)]
      : kind === "partial" ? [check("build")] : [check("build"), check("test", kind === "unknown" ? "new-state" : null, kind === "pending" ? "queued" : "completed")]
    const result = await githubAwaitChecks(ctx(inputs), deps(observation(checks), undefined, () => 0))
    expect(result).toEqual({ status: "pending", nextPollMs: 15000, state: { deadline: 60000, sha } })
    if (result.status !== "pending") return
    const resumed = await githubAwaitChecks(ctx(inputs, { resume: result.state }), deps(observation(checks), undefined, () => 60001))
    expect(resumed.status).toBe("failed")
    if (resumed.status === "failed") expect(resumed.error).toContain("timed out")
  })

  it.each(["failure", "timed_out", "cancelled", "action_required", "stale"])("fails on required %s", async conclusion => {
    const result = await githubAwaitChecks(ctx(inputs), deps(observation([check("build"), check("test", conclusion)])))
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.error).toContain("test")
  })

  it.each(["skipped", "neutral"])("accepts completed %s for required checks and ignores irrelevant failures", async conclusion => {
    const result = await githubAwaitChecks(ctx(inputs), deps(observation([check("build", conclusion), check("test"), check("optional", "failure")])))
    expect(result.status).toBe("succeeded")
  })

  it.each(["before", "during"])("fails when PR head moves %s observation", async when => {
    const result = await githubAwaitChecks(ctx(inputs), deps(observation([check("build"), check("test")], [], when === "before" ? old : sha, old)))
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.error).toContain("head moved")
  })

  it("accepts latest status contexts, but requires both producers when names collide", async () => {
    expect((await githubAwaitChecks(ctx(inputs), deps(observation([check("build")], [{ context: "test", state: "success" }])))).status).toBe("succeeded")
    expect((await githubAwaitChecks(ctx(inputs), deps(observation([check("build"), check("test")], [{ context: "test", state: "pending" }])))).status).toBe("pending")
    expect((await githubAwaitChecks(ctx(inputs), deps(observation([check("build")], [{ context: "test", state: "error" }])))).status).toBe("failed")
  })

  it("reads all paginated checks and status contexts", async () => {
    const process_ = observation()
    process_.handlers[1] = () => ok(JSON.stringify([{ check_runs: [check("optional")] }, { check_runs: [check("build")] }]))
    process_.handlers[2] = () => ok(JSON.stringify([{ sha, statuses: [] }, { sha, statuses: [{ context: "test", state: "success" }] }]))
    expect((await githubAwaitChecks(ctx(inputs), deps(process_))).status).toBe("succeeded")
  })

  it.each(["json", "shape", "row", "sha", "auth"])("fails closed on %s response", async kind => {
    const process_ = observation([check("build"), check("test")])
    if (kind === "sha") process_.handlers[2] = () => ok(JSON.stringify([{ sha: old, statuses: [] }]))
    else process_.handlers[1] = () => kind === "auth" ? fail(1, "denied") : ok(kind === "json" ? "{" : JSON.stringify(kind === "row" ? [{ check_runs: [{}] }] : {}))
    expect((await githubAwaitChecks(ctx(inputs), deps(process_))).status).toBe("failed")
  })

  it("rejects missing policy and changes to resumed identity", async () => {
    for (const bad of [{ ...inputs, required_checks: [] }, { ...inputs, expected_sha: "" }, { pr: 5 }]) {
      const process_ = new FakeProcess()
      expect((await githubAwaitChecks(ctx(bad), deps(process_))).status).toBe("failed")
      expect(process_.calls).toHaveLength(0)
    }
    expect((await githubAwaitChecks(ctx(inputs, { resume: { sha: old, deadline: 1000 } }), deps(new FakeProcess()))).status).toBe("failed")
  })

  it("resumes successfully when missing checks appear", async () => {
    expect((await githubAwaitChecks(ctx(inputs, { resume: { sha, deadline: 1000 } }), deps(observation([check("build"), check("test")]), undefined, () => 500))).status).toBe("succeeded")
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
    const result = await githubPrMerge(ctx({ pr: 9, resolve_threads: false }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { merged_sha: "deadbeef" } })
    expect(process_.argv()).toEqual([
      ["gh", "pr", "merge", "9", "--squash"],
      ["gh", "pr", "view", "9", "--json", "state,mergeCommit"],
      ["gh", "pr", "view", "9", "--json", "headRefName", "--jq", ".headRefName"],
      ["git", "push", "origin", "--delete", "feature/x"],
      ["git", "branch", "-D", "feature/x"],
    ])
  })

  it("resolves unresolved review threads before merging (merge policies require thread resolution)", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => ok("owner/repo\n"),
      () =>
        ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      { id: "PRRT_open", isResolved: false },
                      { id: "PRRT_done", isResolved: true },
                    ],
                  },
                },
              },
            },
          }),
        ),
      () => ok(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } })),
      () => ok(),
      () => ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "beefcafe" } })),
    ]
    const result = await githubPrMerge(ctx({ pr: 9, delete_branch: false }), deps(process_))

    expect(result).toEqual({ status: "succeeded", outputs: { merged_sha: "beefcafe" } })
    const argv = process_.argv()
    expect(argv[0]).toEqual(["gh", "repo", "view", "--json", "owner,name", "--jq", '.owner.login + "/" + .name'])
    expect(argv[1]?.[2]).toBe("graphql")
    expect(argv[1]?.[4]).toContain('pullRequest(number: 9)')
    // Only the UNRESOLVED thread gets a resolve mutation.
    expect(argv[2]?.[4]).toContain('resolveReviewThread(input: {threadId: "PRRT_open"})')
    expect(argv[3]).toEqual(["gh", "pr", "merge", "9", "--squash"])
  })

  it("a failed thread listing never blocks the merge itself", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [
      () => ok("owner/repo\n"),
      () => fail(1, "graphql unavailable"),
      () => ok(),
      () => ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "feedface" } })),
    ]
    const result = await githubPrMerge(ctx({ pr: 9, delete_branch: false }), deps(process_))
    expect(result).toEqual({ status: "succeeded", outputs: { merged_sha: "feedface" } })
  })

  it("honours method and delete_branch inputs", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => ok(), () => ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "sha" } }))]
    const result = await githubPrMerge(ctx({ pr: 9, method: "rebase", delete_branch: false, resolve_threads: false }), deps(process_))
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
    const result = await githubPrMerge(ctx({ pr: 9, delete_branch: false, resolve_threads: false }), deps(process_))
    expect(result).toEqual({ status: "succeeded", outputs: { merged_sha: "cafe" } })
  })

  it("fails when gh pr merge exits non-zero", async () => {
    const process_ = new FakeProcess()
    process_.handlers = [() => fail(1, "not mergeable")]
    const result = await githubPrMerge(ctx({ pr: 9, resolve_threads: false }), deps(process_))
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
