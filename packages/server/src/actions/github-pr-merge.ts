import type { ActionHandler } from "../action-host.ts"

interface MergeCommitView {
  readonly mergeCommit: { readonly oid: string } | null
}

export const githubPrMerge: ActionHandler = async (ctx, deps) => {
  const pr = Number(ctx.inputs.pr)
  const method = String(ctx.inputs.method ?? "squash")
  const deleteBranch = Boolean(ctx.inputs.delete_branch ?? true)

  const merge = await deps.process.exec(
    ["gh", "pr", "merge", String(pr), `--${method}`, ...(deleteBranch ? ["--delete-branch"] : [])],
    { cwd: ctx.workdir },
  )
  if (merge.code !== 0) {
    return { status: "failed", error: `gh pr merge exited ${merge.code}: ${merge.output.slice(-2000)}` }
  }

  const view = await deps.process.exec(["gh", "pr", "view", String(pr), "--json", "mergeCommit"], { cwd: ctx.workdir })
  if (view.code !== 0) {
    return { status: "failed", error: `gh pr view exited ${view.code}: ${view.output.slice(-2000)}` }
  }
  let parsed: MergeCommitView
  try {
    parsed = JSON.parse(view.stdout) as MergeCommitView
  } catch {
    return { status: "failed", error: `gh pr view: cannot parse JSON: ${view.stdout.slice(0, 500)}` }
  }
  if (!parsed.mergeCommit?.oid) {
    return { status: "failed", error: `gh pr view: no merge commit reported for PR #${pr}` }
  }
  return { status: "succeeded", outputs: { merged_sha: parsed.mergeCommit.oid } }
}
