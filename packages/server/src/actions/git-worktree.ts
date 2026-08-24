import { basename, isAbsolute, resolve } from "node:path"
import type { ActionHandler } from "../action-host.ts"
import { parseWorktreeList, slugifyBranch } from "./git-support.ts"

export const gitWorktree: ActionHandler = async (ctx, deps) => {
  const branch = String(ctx.inputs.branch)
  const base = String(ctx.inputs.base ?? "main")
  const dir = String(ctx.inputs.dir ?? "")

  const format = await deps.process.exec(["git", "check-ref-format", "--branch", branch], { cwd: ctx.workdir })
  if (format.code !== 0) {
    return { status: "failed", error: `invalid branch name "${branch}": ${format.output.trim()}` }
  }

  const target = dir !== ""
    ? (isAbsolute(dir) ? dir : resolve(ctx.workdir, dir))
    : resolve(ctx.workdir, "..", `${basename(ctx.workdir)}-worktrees`, slugifyBranch(branch))

  const list = await deps.process.exec(["git", "worktree", "list", "--porcelain"], { cwd: ctx.workdir })
  if (list.code === 0) {
    const entries = parseWorktreeList(list.output)
    const existing = entries.find(entry => entry.path === target)
    if (existing && existing.branch === branch) {
      return { status: "succeeded", outputs: { path: target, created: false } }
    }
    const elsewhere = entries.find(entry => entry.branch === branch)
    if (elsewhere !== undefined) {
      return {
        status: "failed",
        error: `branch "${branch}" is already checked out in another worktree at ${elsewhere.path}`,
      }
    }
  }

  // Idempotency spans the branch too: a previous (possibly abandoned)
  // feature may have created the branch without a surviving worktree.
  // `add -b` would refuse with "branch already exists" — attach to the
  // existing branch instead of failing the step.
  const branchExists = await deps.process.exec(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: ctx.workdir },
  )
  const add =
    branchExists.code === 0
      ? await deps.process.exec(["git", "worktree", "add", target, branch], { cwd: ctx.workdir })
      : await deps.process.exec(["git", "worktree", "add", target, "-b", branch, base], { cwd: ctx.workdir })
  if (add.code !== 0) {
    return { status: "failed", error: `git worktree add exited ${add.code}: ${add.output.slice(-2000)}` }
  }
  return { status: "succeeded", outputs: { path: target, created: true } }
}
