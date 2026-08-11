import type { ActionHandler } from "../action-host.ts"

export const gitPush: ActionHandler = async (ctx, deps) => {
  const remote = String(ctx.inputs.remote ?? "origin")
  const branch = String(ctx.inputs.branch)
  const setUpstream = Boolean(ctx.inputs.set_upstream ?? true)

  const args = ["git", "push", ...(setUpstream ? ["-u"] : []), remote, branch]
  const push = await deps.process.exec(args, { cwd: ctx.workdir })
  if (push.code !== 0) {
    return { status: "failed", error: `git push exited ${push.code}: ${push.output.slice(-2000)}` }
  }

  const rev = await deps.process.exec(["git", "rev-parse", "HEAD"], { cwd: ctx.workdir })
  if (rev.code !== 0) {
    return { status: "failed", error: `git rev-parse HEAD exited ${rev.code}: ${rev.output.slice(-2000)}` }
  }
  return { status: "succeeded", outputs: { sha: rev.stdout.trim() } }
}
