/**
 * Board movement diffing — pure, DOM-free.
 *
 * The workflow board re-renders on every SSE-driven feature-list refetch;
 * a card whose feature moved to a different job column unmounts from its
 * old column and remounts in the new one (different `cardId`), which
 * silently drops any focus a keyboard/AT user had on it and gives no
 * indication anything changed. `diffBoardMovements` compares two board
 * snapshots and reports which features arrived, moved between job
 * columns, or left the board entirely, so a caller can announce the
 * change through a polite live region and attempt focus recovery.
 */

import type { WorkflowBoardModel } from "./workflow-board.ts"

export type BoardMovementKind = "arrived" | "moved" | "left"

export interface BoardMovement {
  readonly featureId: string
  readonly title: string
  readonly kind: BoardMovementKind
  readonly fromJobIds: readonly string[]
  readonly toJobIds: readonly string[]
}

interface FeatureJobs {
  readonly title: string
  readonly jobIds: string[]
}

function collectFeatureJobs(board: WorkflowBoardModel): Map<string, FeatureJobs> {
  const map = new Map<string, FeatureJobs>()
  for (const column of board.columns) {
    for (const card of column.cards) {
      let entry = map.get(card.id)
      if (entry === undefined) {
        entry = { title: card.title, jobIds: [] }
        map.set(card.id, entry)
      }
      entry.jobIds.push(column.jobId)
    }
  }
  return map
}

function sameJobSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every(id => setA.has(id))
}

/**
 * Diff two board snapshots for the *same scope* (same job column set).
 * `previous === null` (first render / scope switch) always yields no
 * movements — there is nothing meaningful to announce about a change
 * from nothing to the initial state.
 */
export function diffBoardMovements(
  previous: WorkflowBoardModel | null,
  next: WorkflowBoardModel,
): readonly BoardMovement[] {
  if (previous === null) return []
  const prevByFeature = collectFeatureJobs(previous)
  const nextByFeature = collectFeatureJobs(next)
  const movements: BoardMovement[] = []

  for (const [featureId, info] of nextByFeature) {
    const prevInfo = prevByFeature.get(featureId)
    if (prevInfo === undefined) {
      movements.push({ featureId, title: info.title, kind: "arrived", fromJobIds: [], toJobIds: info.jobIds })
    } else if (!sameJobSet(prevInfo.jobIds, info.jobIds)) {
      movements.push({ featureId, title: info.title, kind: "moved", fromJobIds: prevInfo.jobIds, toJobIds: info.jobIds })
    }
  }
  for (const [featureId, info] of prevByFeature) {
    if (!nextByFeature.has(featureId)) {
      movements.push({ featureId, title: info.title, kind: "left", fromJobIds: info.jobIds, toJobIds: [] })
    }
  }
  return movements
}

const ANNOUNCE_LIMIT = 3

/** Render movements into one polite-live-region sentence, capped so a
 *  large reshuffle announces a summary instead of a wall of text. */
export function describeBoardMovements(movements: readonly BoardMovement[], limit = ANNOUNCE_LIMIT): string | null {
  if (movements.length === 0) return null
  const parts = movements.slice(0, limit).map(m => {
    if (m.kind === "arrived") return `${m.title} is now active at ${m.toJobIds.join(", ")}`
    if (m.kind === "left") return `${m.title} left the board`
    return `${m.title} moved to ${m.toJobIds.join(", ")}`
  })
  const remaining = movements.length - limit
  const suffix = remaining > 0 ? `, and ${remaining} more update${remaining === 1 ? "" : "s"}` : ""
  return parts.join("; ") + suffix
}
