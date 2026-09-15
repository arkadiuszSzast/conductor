import type { ActionHandler } from "../action-host.ts"

export const gitPush: ActionHandler = async (ctx, deps) => {
  const remote = String(ctx.inputs.remote ?? "origin")
  const branch = String(ctx.inputs.branch)
  const setUpstream = Boolean(ctx.inputs.set_upstream ?? true)
  const ref = `refs/heads/${branch}`
  const valid = await deps.process.exec(["git", "check-ref-format", ref], { cwd: ctx.workdir })
  if (valid.code !== 0 || branch.startsWith("-")) {
    return { status: "failed", error: `invalid branch name: ${branch}` }
  }
  const rev = await deps.process.exec(["git", "rev-parse", "--verify", `${ref}^{commit}`], { cwd: ctx.workdir })
  const sha = rev.stdout.trim()
  if (rev.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    return { status: "failed", error: `git rev-parse ${ref} exited ${rev.code}: ${rev.output.slice(-2000)}` }
  }
  const push = await deps.process.exec(["git", "push", "--", remote, `${sha}:${ref}`], { cwd: ctx.workdir })
  if (push.code !== 0) {
    return { status: "failed", error: `git push exited ${push.code}: ${push.output.slice(-2000)}` }
  }
  if (setUpstream) {
    const upstream = await deps.process.exec(["git", "branch", `--set-upstream-to=${remote}/${branch}`, "--", branch], { cwd: ctx.workdir })
    if (upstream.code !== 0) {
      return { status: "failed", error: `pushed ${sha}, but setting upstream exited ${upstream.code}: ${upstream.output.slice(-2000)}` }
    }
  }
  return { status: "succeeded", outputs: { sha } }
}
