/**
 * Workflow-scoped board derivation — frontier resolution, parallel
 * markers, topological column order, and cross-scope overview grouping.
 */
import { describe, expect, it } from "bun:test"
import {
  deriveOverview,
  deriveStages,
  deriveWorkflowBoard,
  focusStageIndex,
  deriveWorkflowScopes,
  jobColumnOrder,
  pickStableDefaultScopeKey,
  resolveFrontierJobIds,
  scopeKey,
  scopeMatchesWorkflow,
  stageLabel,
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

  it("a quiet daemon (registered projects, no features) still yields a base scope per project", () => {
    const scopes = deriveWorkflowScopes([], [{ projectDir: "/p1", workflowName: "delivery" }])
    expect(scopes).toEqual([
      { key: scopeKey("/p1", "delivery"), projectDir: "/p1", workflow: "delivery", projectLabel: "p1", featureCount: 0, activeCount: 0 },
    ])
  })

  it("a feature-less registered project appears beside a busy one", () => {
    const scopes = deriveWorkflowScopes(
      [item({ id: "a", projectDir: "/busy", workflow: "delivery", status: "running" })],
      [
        { projectDir: "/busy", workflowName: "delivery" },
        { projectDir: "/quiet", workflowName: "hotfix" },
      ],
    )
    expect(scopes.map(s => s.key)).toEqual([scopeKey("/busy", "delivery"), scopeKey("/quiet", "hotfix")])
    expect(scopes[0]!.featureCount).toBe(1)
    expect(scopes[1]!.featureCount).toBe(0)
  })

  it("a registered project with an unregistered/invalid workflow surfaces as a 'default'-labelled scope", () => {
    const scopes = deriveWorkflowScopes([], [{ projectDir: "/broken", workflowName: null }])
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.workflow).toBe("default")
    expect(scopes[0]!.key).toBe(scopeKey("/broken", "default"))
  })

  it("no registered projects and no features yields no scopes", () => {
    expect(deriveWorkflowScopes([], [])).toEqual([])
    expect(deriveWorkflowScopes([])).toEqual([])
  })

  it("feature counts merge onto the registered project's base scope instead of duplicating it", () => {
    const scopes = deriveWorkflowScopes(
      [
        item({ id: "a", projectDir: "/p1", workflow: "delivery", status: "running" }),
        item({ id: "b", projectDir: "/p1", workflow: "delivery", status: "waiting_human" }),
      ],
      [{ projectDir: "/p1", workflowName: "delivery" }],
    )
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.key).toBe(scopeKey("/p1", "delivery"))
    expect(scopes[0]!.featureCount).toBe(2)
    expect(scopes[0]!.activeCount).toBe(2)
  })

  it("a feature on a workflow other than the project's registered one still gets its own scope", () => {
    const scopes = deriveWorkflowScopes(
      [item({ id: "a", projectDir: "/p1", workflow: "legacy", status: "running" })],
      [{ projectDir: "/p1", workflowName: "delivery" }],
    )
    expect(scopes.map(s => s.key).sort()).toEqual([scopeKey("/p1", "delivery"), scopeKey("/p1", "legacy")].sort())
    const base = scopes.find(s => s.workflow === "delivery")!
    const extra = scopes.find(s => s.workflow === "legacy")!
    expect(base.featureCount).toBe(0)
    expect(extra.featureCount).toBe(1)
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

const SCOPE = { projectDir: "/home/dev/projects/conductor", workflow: "delivery" }
const stageOf = (board: ReturnType<typeof deriveWorkflowBoard>, jobId: string) => board.stages.find(s => s.jobIds.includes(jobId))!

function fanOutWorkflow(): WorkflowProjection {
  return {
    name: "delivery",
    stale: false,
    diagnostics: [],
    inputs: {},
    jobs: {
      prepare: { needs: [], steps: [{ id: "sync", kind: "command" }] },
      impl: { needs: ["prepare"], steps: [{ id: "implement", kind: "agent" }, { id: "quality", kind: "command" }] },
      review_code_core: { needs: ["impl"], steps: [{ id: "review", kind: "agent" }] },
      review_code_web: { needs: ["impl"], steps: [{ id: "review", kind: "agent" }] },
      review_gpt: { needs: ["impl"], steps: [{ id: "review", kind: "agent" }] },
      gate: { needs: ["review_code_core", "review_code_web", "review_gpt"], steps: [{ id: "gate", kind: "human" }] },
    },
  }
}

describe("deriveStages / stageLabel", () => {
  it("groups jobs at the same dependency layer into one stage", () => {
    const stages = deriveStages(fanOutWorkflow())
    expect(stages.map(s => s.jobIds)).toEqual([["prepare"], ["impl"], ["review_code_core", "review_code_web", "review_gpt"], ["gate"]])
    expect(stages.map(s => s.index)).toEqual([0, 1, 2, 3])
  })

  it("labels a stage by its shared job-id stem", () => {
    expect(stageLabel(["impl"])).toBe("impl")
    expect(stageLabel(["review_code_core", "review_code_web", "review_gpt"])).toBe("review ×3")
    expect(stageLabel(["architect_system", "architect_ddd"])).toBe("architect ×2")
    expect(stageLabel(["lint", "test"])).toBe("lint +1")
  })
})

describe("deriveWorkflowBoard", () => {
  it("one card per stage, listing every active job there with its current step", () => {
    const board = deriveWorkflowBoard(
      [
        item({
          id: "f-1",
          jobs: {
            prepare: { status: "succeeded", currentStep: null },
            impl: { status: "succeeded", currentStep: null },
            review_code_core: { status: "running", currentStep: "review" },
            review_code_web: { status: "succeeded", currentStep: null },
            review_gpt: { status: "running", currentStep: "review" },
            gate: { status: "pending", currentStep: null },
          },
        }),
      ],
      fanOutWorkflow(),
      SCOPE,
      100_000,
    )
    const reviews = stageOf(board, "review_gpt")
    expect(reviews.cards).toHaveLength(1)
    expect(reviews.cards[0]!.cardId).toBe("f-1::2")
    expect(reviews.cards[0]!.activeJobs).toEqual([
      { jobId: "review_code_core", status: "running", stepId: "review" },
      { jobId: "review_gpt", status: "running", stepId: "review" },
    ])
    expect(reviews.cards[0]!.parallelCount).toBe(2)
    expect(board.stages.filter(s => s.cards.length > 0)).toHaveLength(1)
  })

  it("a frontier spanning two stages yields one card in each", () => {
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
      SCOPE,
      100_000,
    )
    expect(stageOf(board, "architect").cards.map(c => c.cardId)).toEqual(["f-1::0"])
    expect(stageOf(board, "implement").cards.map(c => c.cardId)).toEqual(["f-1::1"])
    expect(stageOf(board, "implement").cards[0]!.parallelCount).toBe(2)
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
      SCOPE,
      100_000,
    )
    expect(stageOf(board, "implement").cards).toHaveLength(1)
    expect(stageOf(board, "architect").cards).toHaveLength(0)
  })

  it("keeps every stage in pipeline order, occupied or not", () => {
    const board = deriveWorkflowBoard([], workflow(), { projectDir: "/x", workflow: "delivery" }, 0)
    expect(board.stages.map(s => s.label)).toEqual(["architect", "implement", "review"])
  })

  it("waiting_human cards sort before ordinary running cards in the same stage", () => {
    const board = deriveWorkflowBoard(
      [
        item({ id: "running-1", status: "running", updatedAt: 10, jobs: { implement: { status: "running", currentStep: "code" } } }),
        item({ id: "waiting-1", status: "waiting_human", updatedAt: 90, jobs: { implement: { status: "running", currentStep: "code" } } }),
      ],
      workflow(),
      SCOPE,
      100_000,
    )
    expect(stageOf(board, "implement").cards.map(c => c.id)).toEqual(["waiting-1", "running-1"])
  })

  it("escalated features with no running/ready job land in the failed job's stage", () => {
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
      SCOPE,
      100_000,
    )
    expect(stageOf(board, "implement").cards[0]!.frontierKind).toBe("escalated-fallback")
    expect(board.unresolved).toHaveLength(0)
  })

  it("an unresolvable frontier lands in the diagnostic tray, not a stage", () => {
    const board = deriveWorkflowBoard(
      [item({ id: "f-1", status: "waiting_human", jobs: { architect: { status: "succeeded", currentStep: null } } })],
      workflow(),
      SCOPE,
      100_000,
    )
    expect(board.unresolved.map(c => c.id)).toEqual(["f-1"])
    for (const stage of board.stages) expect(stage.cards).toHaveLength(0)
  })

  it("a runtime-only job (stale projection) gets a trailing stage instead of vanishing", () => {
    const board = deriveWorkflowBoard(
      [item({ id: "f-1", jobs: { ghost: { status: "running", currentStep: "x" } } })],
      workflow(),
      SCOPE,
      100_000,
    )
    expect(board.stages.at(-1)!.jobIds).toEqual(["ghost"])
    expect(board.stages.at(-1)!.cards).toHaveLength(1)
  })

  it("paused and terminal features never occupy a stage", () => {
    const board = deriveWorkflowBoard(
      [
        item({ id: "paused-1", status: "paused", jobs: { implement: { status: "running", currentStep: "code" } } }),
        item({ id: "done-1", status: "done", jobs: { implement: { status: "succeeded", currentStep: null } } }),
      ],
      workflow(),
      SCOPE,
      100_000,
    )
    for (const stage of board.stages) expect(stage.cards).toHaveLength(0)
    expect(board.unresolved).toHaveLength(0)
  })

  it("features from another scope are excluded", () => {
    const board = deriveWorkflowBoard(
      [item({ id: "other", projectDir: "/other", jobs: { implement: { status: "running", currentStep: "code" } } })],
      workflow(),
      SCOPE,
      100_000,
    )
    for (const stage of board.stages) expect(stage.cards).toHaveLength(0)
  })
})

describe("focusStageIndex", () => {
  it("prefers the earliest stage needing a human, else the earliest occupied one", () => {
    const running = item({ id: "r", status: "running", jobs: { architect: { status: "running", currentStep: "plan" } } })
    const waiting = item({ id: "w", status: "waiting_human", jobs: { review: { status: "running", currentStep: "approve" } } })
    expect(focusStageIndex(deriveWorkflowBoard([running, waiting], workflow(), SCOPE, 0))).toBe(2)
    expect(focusStageIndex(deriveWorkflowBoard([running], workflow(), SCOPE, 0))).toBe(0)
    expect(focusStageIndex(deriveWorkflowBoard([], workflow(), SCOPE, 0))).toBeNull()
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
