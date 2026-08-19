/**
 * Board movement diffing — arrived/moved/left detection and the polite
 * live-region summary text.
 */
import { describe, expect, it } from "bun:test"
import { describeBoardMovements, diffBoardMovements } from "../src/board/board-activity.ts"
import type { FrontierCardModel, JobColumnModel, WorkflowBoardModel } from "../src/board/workflow-board.ts"

function card(partial: Partial<FrontierCardModel> & { readonly id: string; readonly jobId: string }): FrontierCardModel {
  return {
    jobStatus: "running",
    frontierKind: "running",
    parallelCount: 1,
    title: partial.title ?? partial.id,
    status: "running",
    zone: "running",
    glyph: "●",
    age: "1m",
    project: "proj",
    workflow: "default",
    currentStep: null,
    jobsDone: 0,
    jobsTotal: 1,
    findingsNew: 0,
    escalation: null,
    pr: null,
    updatedAt: 0,
    attention: false,
    ...partial,
    id: partial.id,
    jobId: partial.jobId,
    cardId: `${partial.id}::${partial.jobId}`,
  }
}

function board(columns: readonly { readonly jobId: string; readonly cards: readonly FrontierCardModel[] }[]): WorkflowBoardModel {
  return { columns: columns as readonly JobColumnModel[], unresolved: [] }
}

describe("diffBoardMovements", () => {
  it("reports no movements against a null previous snapshot", () => {
    const next = board([{ jobId: "implement", cards: [card({ id: "f-1", jobId: "implement" })] }])
    expect(diffBoardMovements(null, next)).toEqual([])
  })

  it("detects a feature that moved from one job column to another", () => {
    const prev = board([
      { jobId: "implement", cards: [card({ id: "f-1", jobId: "implement", title: "pdf export" })] },
      { jobId: "review", cards: [] },
    ])
    const next = board([
      { jobId: "implement", cards: [] },
      { jobId: "review", cards: [card({ id: "f-1", jobId: "review", title: "pdf export" })] },
    ])
    const movements = diffBoardMovements(prev, next)
    expect(movements).toEqual([
      { featureId: "f-1", title: "pdf export", kind: "moved", fromJobIds: ["implement"], toJobIds: ["review"] },
    ])
  })

  it("detects a feature newly arriving on the board", () => {
    const prev = board([{ jobId: "implement", cards: [] }])
    const next = board([{ jobId: "implement", cards: [card({ id: "f-2", jobId: "implement" })] }])
    const movements = diffBoardMovements(prev, next)
    expect(movements).toEqual([{ featureId: "f-2", title: "f-2", kind: "arrived", fromJobIds: [], toJobIds: ["implement"] }])
  })

  it("detects a feature leaving the board (went terminal/paused/unresolved)", () => {
    const prev = board([{ jobId: "implement", cards: [card({ id: "f-3", jobId: "implement" })] }])
    const next = board([{ jobId: "implement", cards: [] }])
    const movements = diffBoardMovements(prev, next)
    expect(movements).toEqual([{ featureId: "f-3", title: "f-3", kind: "left", fromJobIds: ["implement"], toJobIds: [] }])
  })

  it("does not report a movement when a parallel feature keeps the same job set", () => {
    const prev = board([
      { jobId: "a", cards: [card({ id: "f-4", jobId: "a" })] },
      { jobId: "b", cards: [card({ id: "f-4", jobId: "b" })] },
    ])
    const next = board([
      { jobId: "a", cards: [card({ id: "f-4", jobId: "a" })] },
      { jobId: "b", cards: [card({ id: "f-4", jobId: "b" })] },
    ])
    expect(diffBoardMovements(prev, next)).toEqual([])
  })

  it("treats gaining or losing one parallel job as a move, not a no-op", () => {
    const prev = board([
      { jobId: "a", cards: [card({ id: "f-5", jobId: "a" })] },
      { jobId: "b", cards: [card({ id: "f-5", jobId: "b" })] },
    ])
    const next = board([
      { jobId: "a", cards: [card({ id: "f-5", jobId: "a" })] },
      { jobId: "b", cards: [] },
    ])
    const movements = diffBoardMovements(prev, next)
    expect(movements).toEqual([
      { featureId: "f-5", title: "f-5", kind: "moved", fromJobIds: ["a", "b"], toJobIds: ["a"] },
    ])
  })
})

describe("describeBoardMovements", () => {
  it("returns null for no movements", () => {
    expect(describeBoardMovements([])).toBeNull()
  })

  it("describes a single move", () => {
    const text = describeBoardMovements([
      { featureId: "f-1", title: "pdf export", kind: "moved", fromJobIds: ["implement"], toJobIds: ["review"] },
    ])
    expect(text).toBe("pdf export moved to review")
  })

  it("describes arrivals and departures distinctly", () => {
    expect(
      describeBoardMovements([{ featureId: "f-1", title: "x", kind: "arrived", fromJobIds: [], toJobIds: ["implement"] }]),
    ).toBe("x is now active at implement")
    expect(
      describeBoardMovements([{ featureId: "f-1", title: "x", kind: "left", fromJobIds: ["implement"], toJobIds: [] }]),
    ).toBe("x left the board")
  })

  it("caps the announcement and summarizes the remainder", () => {
    const movements = Array.from({ length: 5 }, (_, i) => ({
      featureId: `f-${i}`,
      title: `feature ${i}`,
      kind: "moved" as const,
      fromJobIds: ["a"],
      toJobIds: ["b"],
    }))
    const text = describeBoardMovements(movements, 3)
    expect(text).toContain("feature 0 moved to b")
    expect(text).toContain("feature 2 moved to b")
    expect(text).not.toContain("feature 3")
    expect(text).toContain("2 more updates")
  })
})
