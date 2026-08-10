import type { ActionHandler } from "../action-host.ts"
import { parseWorktreeList } from "./git-support.ts"

export const gitWorktreeRemove: ActionHandler = async (ctx, deps) => {
  const path = String(ctx.inputs.path)
  const force = Boolean(ctx.inputs.force ?? false)

  const list = await deps.process.exec(["git", "worktree", "list", "--porcelain"], { cwd: ctx.workdir })
  const isWorktree = list.code === 0 && parseWorktreeList(list.output).some(entry => entry.path === path)
  if (!isWorktree) {
    return { status: "succeeded", outputs: { removed: false } }
  }

  const args = ["git", "worktree", "remove", ...(force ? ["--force"] : []), path]
  const result = await deps.process.exec(args, { cwd: ctx.workdir })
  if (result.code !== 0) {
    return { status: "failed", error: `git worktree remove exited ${result.code}: ${result.output.slice(-2000)}` }
  }
  return { status: "succeeded", outputs: { removed: true } }
}
