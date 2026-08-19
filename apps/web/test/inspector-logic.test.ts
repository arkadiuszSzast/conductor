/**
 * Log-tail cursor logic — `after=nextSeq` pagination with dedupe.
 */
import { describe, expect, it } from "bun:test"
import { applyLogPage, EMPTY_LOG_CURSOR, loadAllLogPages, pageAdvances, resolveInspectorStepId } from "../src/feature/inspector-logic.ts"
import type { FeatureDetail, RunLogLine, RunLogPage, WorkflowProjection } from "../src/api/types.ts"

function line(seq: number, text = `line ${seq}`): RunLogLine {
  return { seq, time: 1_000 + seq, source: "process", text }
}

function page(lines: RunLogLine[], truncated = false): RunLogPage {
  const nextSeq = lines.reduce((max, l) => Math.max(max, l.seq), 0)
  return { lines, nextSeq, truncated }
}

describe("log cursor", () => {
  it("the first page seeds the cursor at the highest seq", () => {
    const cursor = applyLogPage(EMPTY_LOG_CURSOR, page([line(1), line(2), line(3)]))
    expect(cursor.lines.map(l => l.seq)).toEqual([1, 2, 3])
    expect(cursor.nextSeq).toBe(3)
  })

  it("a subsequent page appends only new lines and advances the cursor", () => {
    const first = applyLogPage(EMPTY_LOG_CURSOR, page([line(1), line(2)]))
    const second = applyLogPage(first, page([line(3), line(4)]))
    expect(second.lines.map(l => l.seq)).toEqual([1, 2, 3, 4])
    expect(second.nextSeq).toBe(4)
  })

  it("a racing refetch that re-delivers old lines never duplicates them", () => {
    const first = applyLogPage(EMPTY_LOG_CURSOR, page([line(1), line(2)]))
    const replay = applyLogPage(first, page([line(1), line(2), line(3)]))
    expect(replay.lines.map(l => l.seq)).toEqual([1, 2, 3])
  })

  it("an empty page keeps the cursor unchanged", () => {
    const first = applyLogPage(EMPTY_LOG_CURSOR, page([line(5)]))
    const after = applyLogPage(first, { lines: [], nextSeq: 5, truncated: false })
    expect(after.lines.length).toBe(1)
    expect(after.nextSeq).toBe(5)
  })

  it("pageAdvances flags pages that carry new lines or promise more", () => {
    const cursor = applyLogPage(EMPTY_LOG_CURSOR, page([line(1)]))
    expect(pageAdvances(cursor, page([line(2)]))).toBe(true)
    expect(pageAdvances(cursor, { lines: [], nextSeq: 1, truncated: true })).toBe(true)
    expect(pageAdvances(cursor, { lines: [], nextSeq: 1, truncated: false })).toBe(false)
  })
})

describe("loadAllLogPages", () => {
  it("follows the cursor through every truncated page until one page is not truncated", async () => {
    const pages = [
      { lines: [line(1), line(2)], nextSeq: 2, truncated: true },
      { lines: [line(3), line(4)], nextSeq: 4, truncated: true },
      { lines: [line(5)], nextSeq: 5, truncated: false },
    ]
    const requested: number[] = []
    const fetchPage = async (after: number): Promise<RunLogPage> => {
      requested.push(after)
      return pages[requested.length - 1]!
    }
    const cursor = await loadAllLogPages(EMPTY_LOG_CURSOR, fetchPage)
    expect(requested).toEqual([0, 2, 4])
    expect(cursor.lines.map(l => l.seq)).toEqual([1, 2, 3, 4, 5])
    expect(cursor.nextSeq).toBe(5)
  })

  it("stops after a single page when it is not truncated", async () => {
    let calls = 0
    const fetchPage = async (): Promise<RunLogPage> => {
      calls++
      return page([line(1)])
    }
    await loadAllLogPages(EMPTY_LOG_CURSOR, fetchPage)
    expect(calls).toBe(1)
  })

  it("dedupes lines across pages that overlap the previous cursor", async () => {
    const pages = [
      { lines: [line(1), line(2)], nextSeq: 2, truncated: true },
      // A racing/overlapping page re-delivering seq 2 alongside new lines.
      { lines: [line(2), line(3)], nextSeq: 3, truncated: false },
    ]
    let call = 0
    const cursor = await loadAllLogPages(EMPTY_LOG_CURSOR, async () => pages[call++]!)
    expect(cursor.lines.map(l => l.seq)).toEqual([1, 2, 3])
  })

  it("stops the loop if a page fails to advance the cursor despite claiming truncation", async () => {
    let calls = 0
    const fetchPage = async (): Promise<RunLogPage> => {
      calls++
      return { lines: [], nextSeq: 0, truncated: true }
    }
    await loadAllLogPages(EMPTY_LOG_CURSOR, fetchPage)
    expect(calls).toBe(1)
  })
})

describe("inspector step selection", () => {
  const workflow: WorkflowProjection = {
    name: "delivery",
    stale: false,
    diagnostics: [],
    inputs: {},
    jobs: {
      architect: { needs: [], steps: [{ id: "review", kind: "agent" }] },
      deliver: {
        needs: ["architect"],
        steps: [{ id: "implement", kind: "agent" }, { id: "quality", kind: "command" }],
      },
    },
  }

  const feature = {
    jobs: {
      architect: { currentStep: null },
      deliver: { currentStep: "quality" },
    },
  } as unknown as FeatureDetail

  it("selects the only step when a job node is selected", () => {
    expect(resolveInspectorStepId(workflow, feature, "architect", null)).toBe("review")
  })

  it("keeps an explicitly selected step", () => {
    expect(resolveInspectorStepId(workflow, feature, "deliver", "implement")).toBe("implement")
  })

  it("uses the current step for a multi-step job", () => {
    expect(resolveInspectorStepId(workflow, feature, "deliver", null)).toBe("quality")
  })

  it("does not guess for an inactive multi-step job", () => {
    const completed = {
      jobs: { deliver: { currentStep: null } },
    } as unknown as FeatureDetail
    expect(resolveInspectorStepId(workflow, completed, "deliver", null)).toBeNull()
  })
})
