/**
 * Step-inspector log tail — pure cursor logic.
 *
 * The inspector tails one run through `GET /v1/runs/:id/logs?after=<seq>`
 * and appends pages. Lines are deduplicated by seq so a refetch racing a
 * prior page never renders duplicates, and the cursor always advances to
 * the highest seq seen.
 */

import type { FeatureDetail, RunLogLine, RunLogPage, WorkflowProjection } from "../api/types.ts"

export interface LogCursor {
  readonly lines: readonly RunLogLine[]
  /** `after=` value for the next page: the highest seq the caller has. */
  readonly nextSeq: number
}

export const EMPTY_LOG_CURSOR: LogCursor = { lines: [], nextSeq: 0 }

export function resolveInspectorStepId(
  workflow: WorkflowProjection | null | undefined,
  feature: FeatureDetail | null | undefined,
  jobId: string,
  stepId: string | null,
): string | null {
  if (stepId !== null) return stepId
  const currentStep = feature?.jobs[jobId]?.currentStep
  if (currentStep !== null && currentStep !== undefined) return currentStep
  const steps = workflow?.jobs[jobId]?.steps
  return steps?.length === 1 ? steps[0]!.id : null
}

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

/** Safety cap on chained page fetches — a misbehaving server that always
 *  reports `truncated: true` without advancing the cursor must not hang
 *  the inspector in an infinite fetch loop. */
const MAX_CHAINED_PAGES = 200

/**
 * Drive a fetch loop until every currently-available page is loaded:
 * follows the returned cursor while `truncated` holds, deduping through
 * `applyLogPage` so a page overlapping the previous one never duplicates
 * lines. Stops early if a page stops advancing the cursor (defensive
 * against a server bug) or after `MAX_CHAINED_PAGES` fetches.
 */
export async function loadAllLogPages(
  cursor: LogCursor,
  fetchPage: (afterSeq: number) => Promise<RunLogPage>,
): Promise<LogCursor> {
  let current = cursor
  for (let i = 0; i < MAX_CHAINED_PAGES; i++) {
    const beforeSeq = current.nextSeq
    const page = await fetchPage(current.nextSeq)
    current = applyLogPage(current, page)
    if (!page.truncated || current.nextSeq <= beforeSeq) break
  }
  return current
}

// ------------------------------------------------------------ log display

/** A rendered log row: a narrative line, or a collapsed run of tool lines. */
export type DisplayLogLine =
  | { readonly kind: "line"; readonly line: RunLogLine }
  | {
      /** Consecutive `source: "tool"` lines collapsed into one dimmed
       *  status row — OpenChamber-style: the latest invocation is the
       *  visible text, earlier ones in the run are summarised by count. */
      readonly kind: "tools"
      readonly latest: RunLogLine
      readonly count: number
      /** Collapsed history, newest last (excludes `latest`). */
      readonly earlier: readonly RunLogLine[]
    }

/**
 * Collapse consecutive tool lines into single status rows. While the run
 * is still streaming, the trailing tool group reads as "what is it doing
 * right now" — one dim line that keeps replacing itself — instead of a
 * wall of ⚙ rows drowning the narrative.
 */
export function collapseToolLines(lines: readonly RunLogLine[]): readonly DisplayLogLine[] {
  const out: DisplayLogLine[] = []
  for (const line of lines) {
    if (line.source !== "tool") {
      out.push({ kind: "line", line })
      continue
    }
    const last = out[out.length - 1]
    if (last?.kind === "tools") {
      out[out.length - 1] = { kind: "tools", latest: line, count: last.count + 1, earlier: [...last.earlier, last.latest] }
    } else {
      out.push({ kind: "tools", latest: line, count: 1, earlier: [] })
    }
  }
  return out
}
