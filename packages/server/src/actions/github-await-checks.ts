import type { ActionHandler } from "../action-host.ts"

interface CheckRow {
  readonly name: string
  readonly state: string
}

const PENDING_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", ""])
const FAILED_STATES = new Set(["FAILURE", "ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"])

/** Durable-pending polling: one `gh pr checks` observation per invocation.
 *  Still-pending checks return `{ status: "pending" }` with the deadline
 *  carried in `state` instead of blocking the run for the whole window —
 *  the daemon re-invokes this handler with `ctx.resume` once the
 *  next-observation policy elapses. */
export const githubAwaitChecks: ActionHandler = async (ctx, deps) => {
  const pr = Number(ctx.inputs.pr)
  const timeoutMinutes = Number(ctx.inputs.timeout_minutes ?? 30)
  const pollSeconds = Number(ctx.inputs.poll_seconds ?? 60)
  const deadline = typeof ctx.resume?.deadline === "number" ? ctx.resume.deadline : deps.now() + timeoutMinutes * 60_000

  const result = await deps.process.exec(["gh", "pr", "checks", String(pr), "--json", "name,state"], { cwd: ctx.workdir })
  if (result.code !== 0) {
    if (!/no checks/i.test(result.output)) {
      return { status: "failed", error: `gh pr checks exited ${result.code}: ${result.output.slice(-2000)}` }
    }
  } else {
    const checks = parseChecks(result.stdout)
    if (checks.length > 0) {
      const failed = checks.filter(check => FAILED_STATES.has(check.state.toUpperCase()))
      const pending = checks.some(check => PENDING_STATES.has(check.state.toUpperCase()))
      if (failed.length > 0) {
        return { status: "failed", error: `checks failed: ${failed.map(check => check.name).join(", ")}` }
      }
      if (!pending) {
        return { status: "succeeded", outputs: { conclusion: "success" } }
      }
    }
  }

  if (deps.now() >= deadline) {
    return { status: "failed", error: `timed out after ${timeoutMinutes} minute(s) waiting for checks on PR #${pr}` }
  }
  return { status: "pending", nextPollMs: pollSeconds * 1000, state: { deadline } }
}

function parseChecks(stdout: string): readonly CheckRow[] {
  try {
    const parsed = JSON.parse(stdout) as unknown
    return Array.isArray(parsed) ? (parsed as CheckRow[]) : []
  } catch {
    return []
  }
}
