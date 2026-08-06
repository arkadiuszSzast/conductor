/**
 * `gh` CLI implementation of the `LegacyGh` port. All GitHub interaction
 * goes through here so builtins stay declarative and the reconciler
 * stays testable (inject a fake `LegacyGh` in tests).
 *
 * Every `gh` invocation runs through the injected `ProcessRunner` — no
 * bare `spawn`, no `process.cwd()` fallback. The caller supplies `cwd`
 * for every call that needs one (PR creation runs inside the feature's
 * worktree); calls that only touch the GitHub API (checks, views,
 * GraphQL) run from an explicit neutral directory the caller provides.
 */

import type {
  LegacyCheckSummary,
  LegacyGh,
  LegacyPrView,
  LegacyReviewPayload,
  LegacyReviewThread,
  ProcessRunner,
} from "./ports.ts"

const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", ""])
const FAILED = new Set(["FAILURE", "ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"])

export class RealGh implements LegacyGh {
  constructor(
    private readonly process: ProcessRunner,
    /** Working directory for calls that do not carry their own `cwd`. */
    private readonly defaultCwd: string,
  ) {}

  private exec(
    args: readonly string[],
    cwd?: string,
    opts?: { stdin?: string; token?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.process.exec(["gh", ...args], {
      cwd: cwd ?? this.defaultCwd,
      ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts?.token !== undefined ? { env: { GH_TOKEN: opts.token } } : {}),
    })
  }

  async prChecks(repo: string, pr: number): Promise<LegacyCheckSummary> {
    const result = await this.exec(["pr", "checks", String(pr), "--repo", repo, "--json", "name,state"])
    if (result.code !== 0) {
      // No checks reported yet is not a failure state.
      if (result.stderr.includes("no checks")) {
        return { allConcluded: false, anyFailed: false, failedNames: [] }
      }
      throw new Error(`gh pr checks failed: ${result.stderr.trim()}`)
    }
    const checks = JSON.parse(result.stdout) as Array<{ name: string; state: string }>
    if (checks.length === 0) return { allConcluded: false, anyFailed: false, failedNames: [] }
    const allConcluded = checks.every(c => !PENDING.has(c.state.toUpperCase()))
    const failed = checks.filter(c => FAILED.has(c.state.toUpperCase()))
    return { allConcluded, anyFailed: failed.length > 0, failedNames: failed.map(c => c.name) }
  }

  async prView(repo: string, pr: number): Promise<LegacyPrView> {
    const result = await this.exec(["pr", "view", String(pr), "--repo", repo, "--json", "number,headRefOid,state,mergeable"])
    if (result.code !== 0) throw new Error(`gh pr view failed: ${result.stderr.trim()}`)
    const parsed = JSON.parse(result.stdout) as {
      number: number
      headRefOid: string
      state: LegacyPrView["state"]
      mergeable: string
    }
    return { number: parsed.number, headSha: parsed.headRefOid, state: parsed.state, mergeable: parsed.mergeable }
  }

  async prCreate(repo: string, opts: { title: string; body: string; base: string; head: string; cwd: string }): Promise<number> {
    const result = await this.exec(
      ["pr", "create", "--repo", repo, "--title", opts.title, "--body", opts.body, "--base", opts.base, "--head", opts.head],
      opts.cwd,
    )
    if (result.code !== 0) throw new Error(`gh pr create failed: ${result.stderr.trim()}`)
    const match = /\/pull\/(\d+)/.exec(result.stdout)
    if (!match?.[1]) throw new Error(`gh pr create: cannot parse PR number from: ${result.stdout.trim()}`)
    return Number(match[1])
  }

  async prMerge(repo: string, pr: number): Promise<void> {
    const result = await this.exec(["pr", "merge", String(pr), "--repo", repo, "--squash"])
    if (result.code !== 0) throw new Error(`gh pr merge failed: ${result.stderr.trim()}`)
  }

  async unresolvedThreadCount(repo: string, pr: number): Promise<number> {
    const [owner, name] = repo.split("/")
    const query = `
      query($owner: String!, $name: String!, $pr: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) { nodes { isResolved } }
          }
        }
      }`
    const result = await this.exec([
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner ?? ""}`, "-F", `name=${name ?? ""}`, "-F", `pr=${pr}`,
    ])
    if (result.code !== 0) throw new Error(`gh api graphql failed: ${result.stderr.trim()}`)
    const parsed = JSON.parse(result.stdout) as {
      data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ isResolved: boolean }> } } } }
    }
    return parsed.data.repository.pullRequest.reviewThreads.nodes.filter(n => !n.isResolved).length
  }

  async unresolvedThreads(repo: string, pr: number): Promise<readonly LegacyReviewThread[]> {
    const [owner, name] = repo.split("/")
    const query = `
      query($owner: String!, $name: String!, $pr: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                path
                comments(first: 50) { nodes { author { login } body } }
              }
            }
          }
        }
      }`
    const result = await this.exec([
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner ?? ""}`, "-F", `name=${name ?? ""}`, "-F", `pr=${pr}`,
    ])
    if (result.code !== 0) throw new Error(`gh api graphql failed: ${result.stderr.trim()}`)
    const parsed = JSON.parse(result.stdout) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string
                isResolved: boolean
                path: string | null
                comments: { nodes: Array<{ author: { login: string } | null; body: string }> }
              }>
            }
          }
        }
      }
    }
    return parsed.data.repository.pullRequest.reviewThreads.nodes
      .filter(n => !n.isResolved && n.comments.nodes.length > 0)
      .map(n => {
        const first = n.comments.nodes[0]
        const last = n.comments.nodes[n.comments.nodes.length - 1]
        return {
          id: n.id,
          openedBy: first?.author?.login ?? "",
          firstCommentBody: first?.body ?? "",
          lastReplyBy: last?.author?.login ?? "",
          lastReplyBody: last?.body ?? "",
          path: n.path ?? "",
        }
      })
  }

  async resolveThread(threadId: string): Promise<void> {
    const mutation = `
      mutation($id: ID!) {
        resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
      }`
    const result = await this.exec(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${threadId}`])
    if (result.code !== 0) throw new Error(`resolveReviewThread failed: ${result.stderr.trim()}`)
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    const mutation = `
      mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
          comment { id }
        }
      }`
    const result = await this.exec(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${threadId}`, "-f", `body=${body}`])
    if (result.code !== 0) throw new Error(`thread reply failed: ${result.stderr.trim()}`)
  }

  async reviewActivitySince(repo: string, pr: number, sinceMs: number): Promise<number> {
    const result = await this.exec(["pr", "view", String(pr), "--repo", repo, "--json", "comments,reviews"])
    if (result.code !== 0) throw new Error(`gh pr view failed: ${result.stderr.trim()}`)
    const parsed = JSON.parse(result.stdout) as {
      comments: Array<{ createdAt: string }>
      reviews: Array<{ submittedAt?: string }>
    }
    const count = [
      ...parsed.comments.map(c => c.createdAt),
      ...parsed.reviews.map(r => r.submittedAt ?? ""),
    ].filter(ts => ts !== "" && Date.parse(ts) > sinceMs).length
    return count
  }

  async postComment(
    repo: string,
    pr: number,
    body: string,
    opts: { cwd: string; token?: string },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await this.exec(
      ["pr", "comment", String(pr), "--repo", repo, "--body-file", "-"],
      opts.cwd,
      { stdin: body, ...(opts.token !== undefined ? { token: opts.token } : {}) },
    )
    return result.code === 0 ? { ok: true } : { ok: false, error: result.stdout.slice(-300) || result.stderr.slice(-300) }
  }

  async postReview(
    repo: string,
    pr: number,
    payload: LegacyReviewPayload,
    opts: { cwd: string; token?: string },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await this.exec(
      ["api", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
      opts.cwd,
      { stdin: JSON.stringify(payload), ...(opts.token !== undefined ? { token: opts.token } : {}) },
    )
    return result.code === 0 ? { ok: true } : { ok: false, error: result.stdout.slice(-300) || result.stderr.slice(-300) }
  }
}
