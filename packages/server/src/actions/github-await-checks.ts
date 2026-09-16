import type { ActionHandler } from "../action-host.ts"

interface Observation {
  readonly name: string
  readonly state: "pass" | "fail" | "pending"
}

const PASS = new Set(["success", "neutral", "skipped"])
const FAIL = new Set(["failure", "error", "action_required", "timed_out", "cancelled", "startup_failure", "stale"])
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export const githubAwaitChecks: ActionHandler = async (ctx, deps) => {
  const pr = Number(ctx.inputs.pr)
  const sha = ctx.inputs.expected_sha
  const required = ctx.inputs.required_checks
  const timeoutMinutes = Number(ctx.inputs.timeout_minutes ?? 30)
  const pollSeconds = Number(ctx.inputs.poll_seconds ?? 60)
  if (!Number.isSafeInteger(pr) || pr <= 0 || typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)
    || !Array.isArray(required) || required.length === 0 || required.some(name => typeof name !== "string" || name.trim() === "")
    || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || !Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    return { status: "failed", error: "expected positive pr/timeouts, expected_sha (full SHA), and nonempty required_checks names" }
  }
  const deadline = typeof ctx.resume?.deadline === "number" ? ctx.resume.deadline : deps.now() + timeoutMinutes * 60_000
  if (ctx.resume?.sha !== undefined && ctx.resume.sha !== sha) {
    return { status: "failed", error: "expected SHA changed while awaiting checks" }
  }
  const read = async (args: string[]): Promise<unknown> => {
    const result = await deps.process.exec(["gh", ...args], { cwd: ctx.workdir })
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${result.code}: ${result.output.slice(-2000)}`)
    return JSON.parse(result.stdout) as unknown
  }
  const verifyHead = async (): Promise<void> => {
    const head = await read(["pr", "view", String(pr), "--json", "headRefOid"])
    if (!object(head) || typeof head.headRefOid !== "string") throw new Error("invalid PR head response")
    if (head.headRefOid !== sha) throw new Error(`PR #${pr} head moved: expected ${sha}, observed ${head.headRefOid}`)
  }
  try {
    await verifyHead()
    const prefix = `repos/{owner}/{repo}/commits/${sha}`
    const checkPages = await read(["api", `${prefix}/check-runs?filter=latest&per_page=100`, "--paginate", "--slurp"])
    const statusPages = await read(["api", `${prefix}/status?per_page=100`, "--paginate", "--slurp"])
    const observations = parseObservations(checkPages, statusPages, sha)
    await verifyHead()
    const relevant = observations.filter(row => required.includes(row.name))
    const failed = relevant.filter(row => row.state === "fail")
    if (failed.length > 0) return { status: "failed", error: `checks failed for ${sha}: ${failed.map(row => row.name).join(", ")}` }
    const missing = required.filter(name => !relevant.some(row => row.name === name))
    const pending = relevant.filter(row => row.state === "pending").map(row => row.name)
    if (missing.length === 0 && pending.length === 0) {
      return { status: "succeeded", outputs: { conclusion: "success", sha } }
    }
    if (deps.now() >= deadline) {
      return { status: "failed", error: `timed out after ${timeoutMinutes} minute(s) waiting for checks on PR #${pr} at ${sha}: ${[...missing, ...pending].join(", ")}` }
    }
    return { status: "pending", nextPollMs: pollSeconds * 1000, state: { deadline, sha } }
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) }
  }
}

function parseObservations(checkPages: unknown, statusPages: unknown, sha: string): Observation[] {
  if (!Array.isArray(checkPages) || checkPages.length === 0 || !Array.isArray(statusPages) || statusPages.length === 0) {
    throw new Error("invalid paginated check response")
  }
  const observations: Observation[] = []
  for (const page of checkPages) {
    if (!object(page) || !Array.isArray(page.check_runs)) throw new Error("invalid check-runs response")
    for (const row of page.check_runs) {
      if (!object(row) || typeof row.name !== "string" || typeof row.head_sha !== "string"
        || typeof row.status !== "string" || (row.conclusion !== null && typeof row.conclusion !== "string")) {
        throw new Error("invalid check run")
      }
      if (row.head_sha !== sha) continue
      const conclusion = row.conclusion ?? ""
      observations.push({ name: row.name, state: row.status !== "completed" ? "pending" : PASS.has(conclusion) ? "pass" : FAIL.has(conclusion) ? "fail" : "pending" })
    }
  }
  for (const page of statusPages) {
    if (!object(page) || page.sha !== sha || !Array.isArray(page.statuses)) throw new Error("invalid or mismatched commit status response")
    for (const row of page.statuses) {
      if (!object(row) || typeof row.context !== "string" || typeof row.state !== "string") throw new Error("invalid commit status")
      observations.push({ name: row.context, state: row.state === "success" ? "pass" : FAIL.has(row.state) ? "fail" : "pending" })
    }
  }
  return observations
}
