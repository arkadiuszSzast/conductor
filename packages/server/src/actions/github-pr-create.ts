import type { ActionHandler } from "../action-host.ts"

interface PrView {
  readonly number: number
  readonly url: string
}

export const githubPrCreate: ActionHandler = async (ctx, deps) => {
  const title = String(ctx.inputs.title)
  const body = String(ctx.inputs.body ?? "")
  const base = String(ctx.inputs.base ?? "main")
  const head = String(ctx.inputs.head)
  const draft = Boolean(ctx.inputs.draft ?? false)

  const args = ["gh", "pr", "create", "--title", title, "--body", body, "--base", base, "--head", head, ...(draft ? ["--draft"] : [])]
  const create = await deps.process.exec(args, { cwd: ctx.workdir })
  if (create.code === 0) {
    const match = /\/pull\/(\d+)/.exec(create.stdout)
    if (!match?.[1]) {
      return { status: "failed", error: `gh pr create: cannot parse PR number from: ${create.stdout.trim()}` }
    }
    return { status: "succeeded", outputs: { number: Number(match[1]), url: create.stdout.trim() } }
  }

  if (/already exists/i.test(create.output)) {
    const view = await deps.process.exec(["gh", "pr", "view", head, "--json", "number,url"], { cwd: ctx.workdir })
    if (view.code !== 0) {
      return { status: "failed", error: `gh pr create failed (${create.output.slice(-1000)}) and recovery gh pr view exited ${view.code}: ${view.output.slice(-1000)}` }
    }
    let parsed: PrView
    try {
      parsed = JSON.parse(view.stdout) as PrView
    } catch {
      return { status: "failed", error: `gh pr view: cannot parse JSON: ${view.stdout.slice(0, 500)}` }
    }
    return { status: "succeeded", outputs: { number: parsed.number, url: parsed.url } }
  }

  return { status: "failed", error: `gh pr create exited ${create.code}: ${create.output.slice(-2000)}` }
}
