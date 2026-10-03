import type { FindingView } from "./store.ts"

export interface ReviewFinding {
  readonly id?: string
  readonly path: string
  readonly line: number
  readonly severity: "blocker" | "major" | "minor" | "nit"
  readonly blocking: boolean
  readonly body: string
  readonly acceptanceTests: readonly string[]
  readonly status: "new" | "fixed" | "dismissed" | "reopened"
  readonly resolution?: string
}

export interface ReviewReport {
  readonly head: string
  readonly findings: readonly ReviewFinding[]
}

export interface AcceptedReview extends ReviewReport {
  readonly runId: string
  readonly jobId: string
  readonly stepId: string
  readonly findings: readonly (ReviewFinding & { readonly id: string })[]
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
export const activeBlocker = (finding: ReviewFinding): boolean => finding.blocking && (finding.status === "new" || finding.status === "reopened")

const REVIEW_KEYS = ["head", "findings"] as const
const FINDING_KEYS = ["id", "path", "line", "severity", "blocking", "body", "acceptanceTests", "status", "resolution"] as const

/** Names what actually arrived, so an agent can correct its payload instead
 *  of resending the same shape and concluding the tool is broken. */
function describe(value: unknown): string {
  if (value === undefined) return "missing"
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "string") return `a string (${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)})`
  if (typeof value === "object") return "an object"
  return `a ${typeof value} (${String(value)})`
}

export function validateReview(value: unknown): string | null {
  if (value === undefined) return "the review argument is missing — pass it as a separate JSON object argument {head, findings}, never inside notes"
  if (typeof value === "string") return "review must be a JSON object, not a string — pass {head, findings} as an object argument"
  if (!object(value)) return `review must be a JSON object {head, findings}, got ${describe(value)}`
  const unknownReviewKeys = Object.keys(value).filter(key => !(REVIEW_KEYS as readonly string[]).includes(key))
  if (unknownReviewKeys.length) return `review has unknown field(s) ${unknownReviewKeys.join(", ")}; allowed: ${REVIEW_KEYS.join(", ")}`
  if (typeof value.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head)) return `review.head must be the full lowercase Git SHA (40 or 64 hex chars), got ${describe(value.head)}`
  if (!Array.isArray(value.findings)) return `review.findings must be an array, got ${describe(value.findings)}`
  const ids = new Set<string>()
  for (const [index, finding] of value.findings.entries()) {
    const error = `review.findings[${index}]`
    if (!object(finding)) return `${error}: must be an object, got ${describe(finding)}`
    const unknownKeys = Object.keys(finding).filter(key => !(FINDING_KEYS as readonly string[]).includes(key))
    if (unknownKeys.length) return `${error}: unknown field(s) ${unknownKeys.join(", ")}; allowed: ${FINDING_KEYS.join(", ")}`
    if (!text(finding.path) || finding.path.startsWith("/") || finding.path.includes("\\") || finding.path.split("/").some(part => part === ".." || part === "")) return `${error}.path must be a repository-relative path (no leading /, no .., no empty segments), got ${describe(finding.path)}`
    if (!Number.isSafeInteger(finding.line) || (finding.line as number) < 1) return `${error}.line must be a positive integer, got ${describe(finding.line)}`
    if (!["blocker", "major", "minor", "nit"].includes(String(finding.severity))) return `${error}.severity must be one of blocker, major, minor, nit, got ${describe(finding.severity)}`
    if (typeof finding.blocking !== "boolean") return `${error}.blocking must be a boolean true/false, got ${describe(finding.blocking)}`
    if (!text(finding.body)) return `${error}.body must be a non-empty string, got ${describe(finding.body)}`
    if (!Array.isArray(finding.acceptanceTests)) return `${error}.acceptanceTests must be an ARRAY of strings (e.g. ["Foo rejects empty input"]), got ${describe(finding.acceptanceTests)}`
    const badTest = finding.acceptanceTests.findIndex(item => !text(item))
    if (badTest >= 0) return `${error}.acceptanceTests[${badTest}] must be a non-empty string, got ${describe(finding.acceptanceTests[badTest])}`
    if (finding.blocking && finding.acceptanceTests.length === 0) return `${error}.acceptanceTests must list at least one test for a blocking finding`
    if (!["new", "fixed", "dismissed", "reopened"].includes(String(finding.status))) return `${error}.status must be one of new, fixed, dismissed, reopened, got ${describe(finding.status)}`
    if (finding.resolution !== undefined && !text(finding.resolution)) return `${error}.resolution must be a non-empty string`
    if (finding.status !== "new" && !text(finding.resolution)) return `${error}: status ${String(finding.status)} requires a resolution`
    if (finding.id !== undefined) {
      if (typeof finding.id !== "string" || !/^F[1-9][0-9]*$/.test(finding.id)) return `${error}.id must match F<number> (an id from a previous round), got ${describe(finding.id)} — omit id for new findings`
      if (ids.has(finding.id)) return `${error}.id ${finding.id} is duplicated`
      ids.add(finding.id)
    } else if (finding.status !== "new") return `${error}: a finding without id is new and must have status new`
  }
  return null
}

export function prepareReview(report: ReviewReport, prior: readonly FindingView[], source: { runId: string; jobId: string; stepId: string }, verdict?: string): AcceptedReview {
  const owned = prior.filter(finding => finding.sourceJobId === source.jobId && finding.stepId === source.stepId)
  const seen = new Set(report.findings.map(finding => finding.id))
  if (owned.some(finding => !seen.has(finding.id))) throw new Error("every previous finding from this gate must be explicitly carried forward, fixed or dismissed")
  let seq = Math.max(0, ...prior.map(finding => Number(finding.id.slice(1))))
  const findings = report.findings.map(finding => {
    if (finding.id === undefined) return { ...finding, id: `F${++seq}` }
    const previous = owned.find(candidate => candidate.id === finding.id)
    if (!previous) throw new Error(`finding ${finding.id} is not owned by this gate`)
    if ((previous.status === "fixed" || previous.status === "dismissed") && finding.status === "new") throw new Error(`finding ${finding.id} must be explicitly reopened with a reason`)
    return { ...finding, id: finding.id }
  })
  const expected = findings.some(activeBlocker) ? "changes_requested" : "approved"
  if (verdict !== expected) throw new Error(`review requires verdict ${expected} for its explicit active blockers`)
  return { ...source, head: report.head, findings }
}

export function renderFixPack(review: AcceptedReview): string {
  const blockers = review.findings.filter(activeBlocker)
  return `Accepted work order: ${review.jobId}/${review.stepId}; source run ${review.runId}; previous reviewed head ${review.head}\n` +
    (blockers.length === 0 ? "No blocking review work remains." : JSON.stringify(blockers, null, 2))
}
