/**
 * Log-tail cursor logic — `after=nextSeq` pagination with dedupe.
 */
import { describe, expect, it } from "bun:test"
import { applyLogPage, EMPTY_LOG_CURSOR, pageAdvances } from "../src/feature/inspector-logic.ts"
import type { RunLogLine, RunLogPage } from "../src/api/types.ts"

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
