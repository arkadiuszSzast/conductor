/**
 * Board card model — pure mapping from list payload to what a card renders.
 * Kept DOM-free so the mapping is directly testable; the `Feature` view and
 * `BoardCard` component render this model.
 */

import type { FeatureListItem, FeatureStatus, JobStatus } from "../api/types.ts"
import { projectBasename } from "../graph/merge.ts"
import { formatAge } from "../lib/time.ts"

export type ColumnZone = "needs-you" | "running" | "paused" | "terminal"

export interface BoardCardModel {
  readonly id: string
  readonly title: string
  readonly status: FeatureStatus
  readonly zone: ColumnZone
  readonly glyph: string
  /** Age from `updatedAt`, recomputed by the caller's 30 s ticker. */
  readonly age: string
  readonly project: string
  readonly workflow: string
  readonly currentStep: string | null
  readonly jobsDone: number
  readonly jobsTotal: number
  readonly findingsNew: number
  readonly escalation: string | null
  readonly pr: number | null
  readonly updatedAt: number
  /** True when the card should be visually loud (NEEDS YOU zone). */
  readonly attention: boolean
}

export function zoneOf(status: FeatureStatus): ColumnZone {
  switch (status) {
    case "waiting_human":
    case "escalated":
      return "needs-you"
    case "running":
      return "running"
    case "paused":
      return "paused"
    case "done":
    case "abandoned":
      return "terminal"
  }
}

export function statusGlyph(status: FeatureStatus): string {
  switch (status) {
    case "waiting_human":
      return "◐"
    case "escalated":
      return "✖"
    case "running":
      return "●"
    case "paused":
      return "❚❚"
    case "done":
      return "✓"
    case "abandoned":
      return "✕"
  }
}

function jobsProgress(jobs: Readonly<Record<string, { readonly status: JobStatus }>>): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const job of Object.values(jobs)) {
    total++
    if (job.status === "succeeded") done++
  }
  return { done, total }
}

export function cardModel(item: FeatureListItem, now: number): BoardCardModel {
  const zone = zoneOf(item.status)
  const progress = jobsProgress(item.jobs)
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    zone,
    glyph: statusGlyph(item.status),
    age: formatAge(now, item.updatedAt),
    project: projectBasename(item.projectDir),
    workflow: item.workflow ?? "default",
    currentStep: item.currentStep,
    jobsDone: progress.done,
    jobsTotal: progress.total,
    findingsNew: item.findingCounts.new,
    escalation: item.escalation,
    pr: item.pr,
    updatedAt: item.updatedAt,
    attention: zone === "needs-you",
  }
}

/** Group list items into column zones, NEEDS YOU first (brief F1). */
export function groupIntoZones(
  items: readonly FeatureListItem[],
  now: number,
): Readonly<Record<ColumnZone, readonly BoardCardModel[]>> {
  const groups: Record<ColumnZone, BoardCardModel[]> = { "needs-you": [], running: [], paused: [], terminal: [] }
  for (const item of items) {
    const model = cardModel(item, now)
    groups[model.zone].push(model)
  }
  for (const key of Object.keys(groups) as ColumnZone[]) {
    groups[key].sort((a, b) => a.updatedAt - b.updatedAt)
  }
  return groups
}
