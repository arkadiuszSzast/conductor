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
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
export const activeBlocker = (finding: ReviewFinding): boolean => finding.blocking && (finding.status === "new" || finding.status === "reopened")

export function validateReview(value: unknown): string | null {
  if (!object(value) || !onlyKeys(value, ["head", "findings"]) || typeof value.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head)) return "review requires a full lowercase Git head SHA and findings array"
  if (!Array.isArray(value.findings)) return "review.findings must be an array"
  const ids = new Set<string>()
  for (const [index, finding] of value.findings.entries()) {
    const error = `review.findings[${index}]`
    if (!object(finding) || !onlyKeys(finding, ["id", "path", "line", "severity", "blocking", "body", "acceptanceTests", "status", "resolution"])) return `${error}: unknown fields or invalid object`
    if (!text(finding.path) || finding.path.startsWith("/") || finding.path.includes("\\") || finding.path.split("/").some(part => part === ".." || part === "")) return `${error}: path must be repository-relative`
    if (!Number.isSafeInteger(finding.line) || (finding.line as number) < 1) return `${error}: line must be a positive integer`
    if (!["blocker", "major", "minor", "nit"].includes(String(finding.severity)) || typeof finding.blocking !== "boolean" || !text(finding.body)) return `${error}: severity, explicit blocking boolean and body required`
    if (!Array.isArray(finding.acceptanceTests) || !finding.acceptanceTests.every(text) || (finding.blocking && finding.acceptanceTests.length === 0)) return `${error}: acceptanceTests must be strings, non-empty for blocking findings`
    if (!["new", "fixed", "dismissed", "reopened"].includes(String(finding.status))) return `${error}: invalid lifecycle status`
    if (finding.resolution !== undefined && !text(finding.resolution)) return `${error}: resolution must be non-empty`
    if (finding.status !== "new" && !text(finding.resolution)) return `${error}: lifecycle disposition requires resolution`
    if (finding.id !== undefined) {
      if (typeof finding.id !== "string" || !/^F[1-9][0-9]*$/.test(finding.id) || ids.has(finding.id)) return `${error}: invalid or duplicate ID`
      ids.add(finding.id)
    } else if (finding.status !== "new") return `${error}: new findings must have status new`
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
