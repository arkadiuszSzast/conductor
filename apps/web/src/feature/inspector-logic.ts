/**
 * Step-inspector log tail — pure cursor logic.
 *
 * The inspector tails one run through `GET /v1/runs/:id/logs?after=<seq>`
 * and appends pages. Lines are deduplicated by seq so a refetch racing a
 * prior page never renders duplicates, and the cursor always advances to
 * the highest seq seen.
 */

import type { RunLogLine, RunLogPage } from "../api/types.ts"

export interface LogCursor {
  readonly lines: readonly RunLogLine[]
  /** `after=` value for the next page: the highest seq the caller has. */
  readonly nextSeq: number
}

export const EMPTY_LOG_CURSOR: LogCursor = { lines: [], nextSeq: 0 }

export function applyLogPage(cursor: LogCursor, page: RunLogPage): LogCursor {
  const seen = new Set(cursor.lines.map(line => line.seq))
  const appended: RunLogLine[] = []
  let highest = cursor.nextSeq
  for (const line of page.lines) {
    if (seen.has(line.seq)) continue
    if (line.seq <= cursor.nextSeq && page.truncated) continue
    seen.add(line.seq)
    appended.push(line)
    if (line.seq > highest) highest = line.seq
  }
  const lines = [...cursor.lines, ...appended]
  return { lines, nextSeq: Math.max(highest, page.nextSeq) }
}

/** A page advances the tail when it carries new lines or promises more. */
export function pageAdvances(cursor: LogCursor, page: RunLogPage): boolean {
  return page.lines.some(line => line.seq > cursor.nextSeq) || page.truncated
}
