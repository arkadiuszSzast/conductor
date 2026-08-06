/**
 * `gh` CLI implementation of the `GhClient` port. All GitHub interaction
 * goes through here so builtins stay declarative and the reconciler
 * stays testable (inject a fake `GhClient` in tests).
 *
 * Every `gh` invocation runs through the injected `ProcessRunner` — no
 * bare `spawn`, no `process.cwd()` fallback. The caller supplies `cwd`
 * for every call that needs one (PR creation runs inside the feature's
 * worktree); calls that only touch the GitHub API (checks, views,
 * GraphQL) run from an explicit neutral directory the caller provides.
 *
 * `postComment`/`postReview` failure text is captured `gh` stdout/stderr
 * tail — this can echo the bot-identity token passed via `opts.token`
 * (`gh` sometimes reprints its own invocation/env on error) or another
 * credential the command happened to print. `sanitizeGhErrorOutput`
 * strips the exact token and common credential shapes before the error
 * ever reaches a returned status, a timeline note, or the daemon log.
 */

import type {
  CheckSummary,
  GhClient,
  PrView,
  ReviewPayload,
  ReviewThread,
  ProcessRunner,
} from "./ports.ts"

const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", ""])
const FAILED = new Set(["FAILURE", "ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"])

const ERROR_TAIL_MAX_CHARS = 300
const REDACTED = "[REDACTED]"

/**
 * Common GitHub/OAuth credential shapes that must never reach a pipeline
 * timeline note or the daemon log — neither is a secret store. Covers
 * classic PATs (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), fine-grained PATs
 * (`github_pat_`), and `Authorization: Bearer <token>`-style headers that
 * `gh` sometimes echoes back in verbose/curl-style error output.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
]

/**
 * Strips the exact token used for this call (if any) and any recognisable
 * credential pattern from `gh` output before it is ever returned as an
 * error string. Runs over the FULL captured text and only caps the length
 * afterwards, so a credential that straddles the cap boundary can never
 * leak a fragment.
 */
function sanitizeGhErrorOutput(text: string, token: string | undefined): string {
  let sanitized = token && token.length > 0 ? text.split(token).join(REDACTED) : text
  for (const pattern of CREDENTIAL_PATTERNS) sanitized = sanitized.replace(pattern, REDACTED)
  return sanitized.slice(-ERROR_TAIL_MAX_CHARS)
}

export class RealGh implements GhClient {
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

  async prChecks(repo: string, pr: number): Promise<CheckSummary> {
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

  async prView(repo: string, pr: number): Promise<PrView> {
    const result = await this.exec(["pr", "view", String(pr), "--repo", repo, "--json", "number,headRefOid,state,mergeable"])
    if (result.code !== 0) throw new Error(`gh pr view failed: ${result.stderr.trim()}`)
    const parsed = JSON.parse(result.stdout) as {
      number: number
      headRefOid: string
      state: PrView["state"]
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

  async unresolvedThreads(repo: string, pr: number): Promise<readonly ReviewThread[]> {
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
    if (result.code === 0) return { ok: true }
    const tail = result.stdout || result.stderr
    return { ok: false, error: sanitizeGhErrorOutput(tail, opts.token) }
  }

  async postReview(
    repo: string,
    pr: number,
    payload: ReviewPayload,
    opts: { cwd: string; token?: string },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await this.exec(
      ["api", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
      opts.cwd,
      { stdin: JSON.stringify(payload), ...(opts.token !== undefined ? { token: opts.token } : {}) },
    )
    if (result.code === 0) return { ok: true }
    const tail = result.stdout || result.stderr
    return { ok: false, error: sanitizeGhErrorOutput(tail, opts.token) }
  }
}
