import type { ActionHandler } from "../action-host.ts"

interface MergeStateView {
  readonly state: string
  readonly mergeCommit: { readonly oid: string } | null
}

export const githubPrMerge: ActionHandler = async (ctx, deps) => {
  const pr = Number(ctx.inputs.pr)
  const method = String(ctx.inputs.method ?? "squash")
  const deleteBranch = Boolean(ctx.inputs.delete_branch ?? true)

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
