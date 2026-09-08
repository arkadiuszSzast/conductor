import type { ActionHandler } from "../action-host.ts"

interface MergeStateView {
  readonly state: string
  readonly mergeCommit: { readonly oid: string } | null
}

interface ThreadQueryView {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly reviewThreads?: {
          readonly nodes?: ReadonlyArray<{ readonly id: string; readonly isResolved: boolean }>
        }
      }
    }
  }
}

export const githubPrMerge: ActionHandler = async (ctx, deps) => {
  const pr = Number(ctx.inputs.pr)
  const method = String(ctx.inputs.method ?? "squash")
  const deleteBranch = Boolean(ctx.inputs.delete_branch ?? true)
  const resolveThreads = Boolean(ctx.inputs.resolve_threads ?? true)

  // Merge policies commonly require every review conversation resolved
  // (rulesets: required_review_thread_resolution). This step runs after
  // the workflow's approval gates, so any thread still open has been
  // adjudicated — resolve them deterministically instead of relying on a
  // review agent to remember to. Best-effort: a resolve failure surfaces
  // through the merge error, not its own.
  if (resolveThreads) {
    const repoView = await deps.process.exec(
      ["gh", "repo", "view", "--json", "owner,name", "--jq", ".owner.login + \"/\" + .name"],
      { cwd: ctx.workdir },
    )
    const slug = repoView.code === 0 ? repoView.stdout.trim() : ""
    const [owner, name] = slug.includes("/") ? slug.split("/", 2) : ["", ""]
    if (owner !== "" && name !== "") {
      const threadQuery = await deps.process.exec(
        [
          "gh", "api", "graphql",
          "-f",
          `query=query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr}) { reviewThreads(first: 100) { nodes { id isResolved } } } } }`,
        ],
        { cwd: ctx.workdir },
      )
      if (threadQuery.code === 0) {
        let threads: ReadonlyArray<{ readonly id: string; readonly isResolved: boolean }> = []
        try {
          threads = (JSON.parse(threadQuery.stdout) as ThreadQueryView).data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
        } catch {
          // Unparseable thread listing — leave resolution to the merge error path.
        }
        for (const thread of threads) {
          if (thread.isResolved) continue
          await deps.process.exec(
            [
              "gh", "api", "graphql",
              "-f",
              `query=mutation { resolveReviewThread(input: {threadId: "${thread.id}"}) { thread { isResolved } } }`,
            ],
            { cwd: ctx.workdir },
          )
        }
      }
    }
  }

  // Merge without --delete-branch: gh reports failure when branch
  // deletion fails even though the merge itself landed, and a worktree
  // holding the branch makes deletion fail every time. Cleanup owns
  // branch removal; here it is best-effort after a confirmed merge.
  const merge = await deps.process.exec(
    ["gh", "pr", "merge", String(pr), `--${method}`],
    { cwd: ctx.workdir },
  )
  const alreadyMerged = merge.code !== 0 && /already merged/i.test(merge.output)
  if (merge.code !== 0 && !alreadyMerged) {
    return { status: "failed", error: `gh pr merge exited ${merge.code}: ${merge.output.slice(-2000)}` }
  }

  const view = await deps.process.exec(
    ["gh", "pr", "view", String(pr), "--json", "state,mergeCommit"],
    { cwd: ctx.workdir },
  )
  if (view.code !== 0) {
    return { status: "failed", error: `gh pr view exited ${view.code}: ${view.output.slice(-2000)}` }
  }
  let parsed: MergeStateView
  try {
    parsed = JSON.parse(view.stdout) as MergeStateView
  } catch {
    return { status: "failed", error: `gh pr view: cannot parse JSON: ${view.stdout.slice(0, 500)}` }
  }
  if (parsed.state !== "MERGED" || !parsed.mergeCommit?.oid) {
    return { status: "failed", error: `PR #${pr} is not merged (state: ${parsed.state})` }
  }

  if (deleteBranch) {
    const del = await deps.process.exec(["gh", "pr", "view", String(pr), "--json", "headRefName", "--jq", ".headRefName"], {
      cwd: ctx.workdir,
    })
    const branch = del.code === 0 ? del.stdout.trim() : ""
    if (branch !== "") {
      await deps.process.exec(["git", "push", "origin", "--delete", branch], { cwd: ctx.workdir })
      await deps.process.exec(["git", "branch", "-D", branch], { cwd: ctx.workdir })
    }
  }

  return { status: "succeeded", outputs: { merged_sha: parsed.mergeCommit.oid } }
}
