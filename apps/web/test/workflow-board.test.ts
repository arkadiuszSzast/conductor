/**
 * Workflow-scoped board derivation — frontier resolution, parallel
 * markers, topological column order, and cross-scope overview grouping.
 */
import { describe, expect, it } from "bun:test"
import {
  deriveOverview,
  deriveWorkflowBoard,
  deriveWorkflowScopes,
  jobColumnOrder,
  pickStableDefaultScopeKey,
  resolveFrontierJobIds,
  scopeKey,
  scopeMatchesWorkflow,
} from "../src/board/workflow-board.ts"
import type { FeatureListItem, WorkflowProjection } from "../src/api/types.ts"

function item(partial: Partial<FeatureListItem>): FeatureListItem {
  return {
    id: "f-1",
    title: "pdf export",
    slug: "pdf-export",
    projectDir: "/home/dev/projects/conductor",
    workflow: "delivery",
    description: null,
    status: "running",
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    escalation: null,
    currentStep: "implement",
    createdAt: 1_000,
    updatedAt: 61_000,
    findingCounts: { new: 0, fixed: 0, dismissed: 0, reopened: 0 },
    jobs: {
      architect: { status: "succeeded", currentStep: null },
      implement: { status: "running", currentStep: "code" },
      review: { status: "pending", currentStep: null },
    },
    ...partial,
  }
}

function workflow(): WorkflowProjection {
  return {
    name: "delivery",
    stale: false,
    diagnostics: [],
    inputs: {},
    jobs: {
      architect: { needs: [], steps: [{ id: "plan", kind: "agent" }] },
      implement: { needs: ["architect"], steps: [{ id: "code", kind: "agent" }] },
      review: { needs: ["implement"], steps: [{ id: "approve", kind: "human" }] },
    },
  }
}

describe("resolveFrontierJobIds", () => {
  it("running jobs win over ready and failed", () => {
    const result = resolveFrontierJobIds(
      item({ jobs: { a: { status: "running", currentStep: null }, b: { status: "ready", currentStep: null } } }),
    )
    expect(result).toEqual({ jobIds: ["a"], kind: "running" })
  })

  it("falls back to ready jobs when nothing runs", () => {
    const result = resolveFrontierJobIds(
      item({ jobs: { a: { status: "succeeded", currentStep: null }, b: { status: "ready", currentStep: null } } }),
    )
    expect(result).toEqual({ jobIds: ["b"], kind: "ready" })
  })

  it("a feature with two running jobs is a parallel frontier", () => {
    const result = resolveFrontierJobIds(
      item({
        jobs: {
          a: { status: "running", currentStep: null },
          b: { status: "running", currentStep: null },
          c: { status: "pending", currentStep: null },
        },
      }),
    )
    expect(result.kind).toBe("running")
    expect([...result.jobIds].sort()).toEqual(["a", "b"])
  })

  it("escalated features fall back to their failed job when nothing runs or is ready", () => {
    const result = resolveFrontierJobIds(
      item({ status: "escalated", jobs: { a: { status: "failed", currentStep: null } } }),
    )
    expect(result).toEqual({ jobIds: ["a"], kind: "escalated-fallback" })
  })

  it("skipped jobs are never part of the frontier", () => {
    const result = resolveFrontierJobIds(
      item({
        status: "running",
        jobs: {
          a: { status: "skipped", currentStep: null },
          b: { status: "running", currentStep: null },
        },
      }),
    )
    expect(result).toEqual({ jobIds: ["b"], kind: "running" })
  })

  it("a feature with no running/ready/failed job has no frontier", () => {
    const result = resolveFrontierJobIds(
      item({ status: "waiting_human", jobs: { a: { status: "succeeded", currentStep: null } } }),
    )
    expect(result).toEqual({ jobIds: [], kind: null })
  })
})

describe("jobColumnOrder", () => {
  it("orders columns by dependency layer", () => {
    expect(jobColumnOrder(workflow())).toEqual(["architect", "implement", "review"])
  })

  it("a fan-in job sits after its deepest dependency", () => {
    const wf: WorkflowProjection = {
      name: "fan",
      stale: false,
      diagnostics: [],
      inputs: {},
      jobs: {
        a: { needs: [], steps: [] },
        b: { needs: [], steps: [] },
        merge: { needs: ["a", "b"], steps: [] },
      },
    }
    const order = jobColumnOrder(wf)
    expect(order.indexOf("merge")).toBeGreaterThan(order.indexOf("a"))
    expect(order.indexOf("merge")).toBeGreaterThan(order.indexOf("b"))
  })
})

describe("deriveWorkflowScopes", () => {
  it("groups non-terminal features by project+workflow and orders busiest-first", () => {
    const scopes = deriveWorkflowScopes([
      item({ id: "a", projectDir: "/p1", workflow: "delivery", status: "running" }),
      item({ id: "b", projectDir: "/p1", workflow: "delivery", status: "waiting_human" }),
      item({ id: "c", projectDir: "/p2", workflow: "hotfix", status: "paused" }),
    ])
    expect(scopes.map(s => s.key)).toEqual([scopeKey("/p1", "delivery"), scopeKey("/p2", "hotfix")])
    expect(scopes[0]!.activeCount).toBe(2)
    expect(scopes[0]!.featureCount).toBe(2)
    expect(scopes[1]!.activeCount).toBe(0)
  })

  it("keeps terminal history in the overview instead of creating empty scopes", () => {
    const scopes = deriveWorkflowScopes([
      item({ id: "done", projectDir: "/p1", workflow: "legacy", status: "done" }),
      item({ id: "abandoned", projectDir: "/p2", workflow: "legacy", status: "abandoned" }),
    ])
    expect(scopes).toEqual([])
  })

  it("defaults a null workflow to 'default'", () => {
    const scopes = deriveWorkflowScopes([item({ workflow: null })])
    expect(scopes[0]!.workflow).toBe("default")
  })
})

describe("scopeMatchesWorkflow", () => {
  it("matches when the projection's name equals the scope's workflow", () => {
    expect(scopeMatchesWorkflow({ projectDir: "/p", workflow: "delivery" }, { name: "delivery" })).toBe(true)
  })

  it("rejects a stale/renamed projection whose name no longer matches the scope", () => {
    expect(scopeMatchesWorkflow({ projectDir: "/p", workflow: "delivery" }, { name: "hotfix" })).toBe(false)
  })
})

describe("pickStableDefaultScopeKey", () => {
  const scopes = [
    { key: "a", projectDir: "/a", workflow: "default", projectLabel: "a", featureCount: 1, activeCount: 1 },
    { key: "b", projectDir: "/b", workflow: "default", projectLabel: "b", featureCount: 1, activeCount: 0 },
  ]

  it("picks the busiest scope when there is no current selection", () => {
    expect(pickStableDefaultScopeKey(null, scopes)).toBe("a")
  })

  it("freezes onto the current scope even if it is no longer busiest", () => {
    const reordered = [
      { key: "b", projectDir: "/b", workflow: "default", projectLabel: "b", featureCount: 1, activeCount: 5 },
      { key: "a", projectDir: "/a", workflow: "default", projectLabel: "a", featureCount: 1, activeCount: 0 },
    ]
    expect(pickStableDefaultScopeKey("a", reordered)).toBe("a")
  })

  it("falls back to busiest once the frozen scope disappears", () => {
    expect(pickStableDefaultScopeKey("gone", scopes)).toBe("a")
  })

  it("returns null when there are no scopes at all", () => {
    expect(pickStableDefaultScopeKey("a", [])).toBeNull()
  })
})

describe("deriveWorkflowBoard", () => {
  it("places a feature at each of its running jobs with a parallel marker", () => {
    const board = deriveWorkflowBoard(
      [
        item({
          id: "f-1",
          jobs: {
            architect: { status: "running", currentStep: "plan" },
            implement: { status: "running", currentStep: "code" },
            review: { status: "pending", currentStep: null },
          },
        }),
      ],
      workflow(),
      { projectDir: "/home/dev/projects/conductor", workflow: "delivery" },
      100_000,
    )
    const architectCol = board.columns.find(c => c.jobId === "architect")!
    const implementCol = board.columns.find(c => c.jobId === "implement")!
    expect(architectCol.cards.map(c => c.cardId)).toEqual(["f-1::architect"])
    expect(implementCol.cards.map(c => c.cardId)).toEqual(["f-1::implement"])
    expect(architectCol.cards[0]!.parallelCount).toBe(2)
    expect(implementCol.cards[0]!.parallelCount).toBe(2)
  })

  it("falls back to ready jobs when no job runs", () => {
    const board = deriveWorkflowBoard(
      [
        item({
          id: "f-1",
          status: "running",
          jobs: {
            architect: { status: "succeeded", currentStep: null },
            implement: { status: "ready", currentStep: null },
            review: { status: "pending", currentStep: null },
          },
        }),
      ],
      workflow(),
      { projectDir: "/home/dev/projects/conductor", workflow: "delivery" },
      100_000,
    )
    expect(board.columns.find(c => c.jobId === "implement")!.cards).toHaveLength(1)
    expect(board.columns.find(c => c.jobId === "architect")!.cards).toHaveLength(0)
  })

  it("orders columns topologically regardless of job declaration order in runtime", () => {
    const board = deriveWorkflowBoard([], workflow(), { projectDir: "/x", workflow: "delivery" }, 0)
    expect(board.columns.map(c => c.jobId)).toEqual(["architect", "implement", "review"])
  })

  it("waiting_human cards sort before ordinary running cards in the same column", () => {
    const board = deriveWorkflowBoard(
      [
        item({ id: "running-1", status: "running", updatedAt: 10, jobs: { implement: { status: "running", currentStep: "code" } } }),
        item({ id: "waiting-1", status: "waiting_human", updatedAt: 90, jobs: { implement: { status: "running", currentStep: "code" } } }),
      ],
      workflow(),
      { projectDir: "/home/dev/projects/conductor", workflow: "delivery" },
      100_000,
    )
    const col = board.columns.find(c => c.jobId === "implement")!
    expect(col.cards.map(c => c.id)).toEqual(["waiting-1", "running-1"])
  })

  it("escalated features with no running/ready job land in the failed job's column", () => {
    const board = deriveWorkflowBoard(
      [
        item({
          id: "f-1",
          status: "escalated",
          jobs: {
            architect: { status: "succeeded", currentStep: null },
            implement: { status: "failed", currentStep: "code" },
            review: { status: "pending", currentStep: null },
          },
        }),
      ],
      workflow(),
      { projectDir: "/home/dev/projects/conductor", workflow: "delivery" },
      100_000,
    )
    expect(board.columns.find(c => c.jobId === "implement")!.cards[0]!.frontierKind).toBe("escalated-fallback")
    expect(board.unresolved).toHaveLength(0)
  })

  it("an unresolvable frontier lands in the diagnostic tray, not a column", () => {
    const board = deriveWorkflowBoard(
      [
        item({
          id: "f-1",
          status: "waiting_human",
          jobs: { architect: { status: "succeeded", currentStep: null } },
        }),
      ],
      workflow(),
      { projectDir: "/home/dev/projects/conductor", workflow: "delivery" },
      100_000,
    )
    expect(board.unresolved.map(c => c.id)).toEqual(["f-1"])
    for (const column of board.columns) expect(column.cards).toHaveLength(0)
  })

  it("paused and terminal features never occupy a job column", () => {
    const board = deriveWorkflowBoard(
      [
        item({ id: "paused-1", status: "paused", jobs: { implement: { status: "running", currentStep: "code" } } }),
        item({ id: "done-1", status: "done", jobs: { implement: { status: "succeeded", currentStep: null } } }),
      ],
      workflow(),
      { projectDir: "/home/dev/projects/conductor", workflow: "delivery" },
      100_000,
    )
    for (const column of board.columns) expect(column.cards).toHaveLength(0)
    expect(board.unresolved).toHaveLength(0)
  })

  it("features from another scope are excluded", () => {
    const board = deriveWorkflowBoard(
      [item({ id: "other", projectDir: "/other", jobs: { implement: { status: "running", currentStep: "code" } } })],
      workflow(),
      { projectDir: "/home/dev/projects/conductor", workflow: "delivery" },
      100_000,
    )
    for (const column of board.columns) expect(column.cards).toHaveLength(0)
  })
})

describe("deriveOverview", () => {
  it("splits urgent, paused, and recent across all scopes", () => {
    const overview = deriveOverview(
      [
        item({ id: "a", status: "waiting_human", projectDir: "/p1" }),
        item({ id: "b", status: "escalated", projectDir: "/p2", workflow: "hotfix" }),
        item({ id: "c", status: "paused", projectDir: "/p1" }),
        item({ id: "d", status: "done", updatedAt: 500_000, projectDir: "/p2" }),
        item({ id: "e", status: "abandoned", updatedAt: 400_000, projectDir: "/p1" }),
      ],
      600_000,
    )
    expect(overview.urgent.map(c => c.id).sort()).toEqual(["a", "b"])
    expect(overview.paused.map(c => c.id)).toEqual(["c"])
    expect(overview.recent.map(c => c.id)).toEqual(["d", "e"])
  })

  it("caps the recent preview at 8 entries, most recent first", () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ id: `t-${i}`, status: "done", updatedAt: i * 10 }))
    const overview = deriveOverview(items, 1_000)
    expect(overview.recent).toHaveLength(8)
    expect(overview.recent[0]!.id).toBe("t-11")
  })

  it("recentAll keeps every terminal feature reachable beyond the preview cap", () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ id: `t-${i}`, status: "done", updatedAt: i * 10 }))
    const overview = deriveOverview(items, 1_000)
    expect(overview.recentAll).toHaveLength(12)
    expect(overview.recentAll.map(c => c.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `t-${11 - i}`),
    )
    // the preview is exactly a prefix of the full collection
    expect(overview.recent).toEqual(overview.recentAll.slice(0, 8))
  })
})
