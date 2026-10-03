import { describe, expect, it } from "bun:test"
import { prepareReview, renderFixPack, validateReview, type ReviewFinding } from "./src/review.ts"
import type { FindingView } from "./src/store.ts"

const head = "a".repeat(40)
const finding: ReviewFinding = { path: "src/a.ts", line: 2, severity: "major", blocking: true, body: "bug", acceptanceTests: ["test/a.ts: expected behavior"], status: "new" }
const source = { runId: "run", jobId: "review", stepId: "gate" }
const previous: FindingView = { ...finding, id: "F1", status: "fixed", resolution: "verified", sourceJobId: "review", stepId: "gate", sourceRunId: "old", reviewedHead: head, tags: [], threadId: null, synced: false }

describe("structured review schema and lifecycle", () => {
  it.each([
    { extra: true }, { head: "short" }, { findings: null },
    { findings: [{ ...finding, blocking: "true" }] },
    { findings: [{ ...finding, line: 0 }] },
    { findings: [{ ...finding, path: "../secret" }] },
    { findings: [{ ...finding, acceptanceTests: [] }] },
    { findings: [{ ...finding, status: "fixed" }] },
    { findings: [{ ...finding, id: "F1" }, { ...finding, id: "F1" }] },
  ])("rejects invalid shape %j", patch => {
    expect(validateReview({ head, findings: [finding], ...patch })).not.toBeNull()
  })

  it.each([
    [undefined, "review argument is missing"],
    [JSON.stringify({ head, findings: [finding] }), "not a string"],
    [{ head, findings: [{ ...finding, acceptanceTests: "replace the cast" }] }, 'review.findings[0].acceptanceTests must be an ARRAY of strings (e.g. ["Foo rejects empty input"]), got a string ("replace the cast")'],
    [{ head, findings: [finding, { ...finding, acceptanceTests: ["ok", ""] }] }, "review.findings[1].acceptanceTests[1] must be a non-empty string"],
    [{ head, findings: [{ ...finding, id: "gate-1-1" }] }, 'review.findings[0].id must match F<number> (an id from a previous round), got a string ("gate-1-1") — omit id for new findings'],
    [{ head, findings: [{ ...finding, line: "12" }] }, 'review.findings[0].line must be a positive integer, got a string ("12")'],
    [{ head, findings: [{ ...finding, file: "x" }] }, "review.findings[0]: unknown field(s) file"],
    [{ head: "short", findings: [] }, 'review.head must be the full lowercase Git SHA (40 or 64 hex chars), got a string ("short")'],
  ])("names the offending field and what actually arrived (%#)", (review, message) => {
    expect(validateReview(review)).toContain(message)
  })

  it("reuses resolved and dismissed IDs only with explicit reopening and preserves severity", () => {
    for (const status of ["fixed", "dismissed"] as const) {
      expect(() => prepareReview({ head, findings: [{ ...finding, id: "F1" }] }, [{ ...previous, status }], source, "changes_requested")).toThrow("reopened")
      const report = { head, findings: [{ ...finding, id: "F1", status: "reopened" as const, resolution: "reachable regression" }] }
      expect(validateReview(report)).toBeNull()
      expect(prepareReview(report, [{ ...previous, status }], source, "changes_requested").findings[0]).toMatchObject({ id: "F1", severity: "major", blocking: true })
    }
  })

  it("rejects another gate's ID and missing carry-forward", () => {
    expect(() => prepareReview({ head, findings: [{ ...finding, id: "F1" }] }, [{ ...previous, sourceJobId: "other" }], source, "changes_requested")).toThrow("not owned")
    expect(() => prepareReview({ head, findings: [] }, [previous], source, "approved")).toThrow("every previous")
  })

  it("renders no blockers without optional or resolved narratives", () => {
    const pack = renderFixPack(prepareReview({ head, findings: [{ ...finding, blocking: false, body: "optional" }] }, [], source, "approved"))
    expect(pack).toContain("No blocking review work remains")
    expect(pack).toContain(head)
    expect(pack).not.toContain("optional")
  })
})
