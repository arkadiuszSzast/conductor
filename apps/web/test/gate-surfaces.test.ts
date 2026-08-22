/**
 * Concurrent gate/question surface enumeration — pure.
 */
import { describe, expect, it } from "bun:test"
import { allSurfaceItems, deriveGateSurfaces, pickSurfaceItem, surfaceCount, surfaceItemKey } from "../src/gate/gate-surfaces.ts"
import type { FeatureDetail, JobRuntimeProjection, RunSummary } from "../src/api/types.ts"

function jobRuntime(partial: Partial<JobRuntimeProjection>): JobRuntimeProjection {
  return { status: "pending", currentStep: null, attempts: {}, reruns: {}, outputs: {}, steps: {}, ...partial }
}

function detail(partial: Partial<FeatureDetail>): FeatureDetail {
  return {
    id: "f-1",
    title: "t",
    slug: "t",
    projectDir: "/proj/app",
    workflow: "default",
    description: null,
    status: "waiting_human",
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    escalation: null,
    currentStep: null,
    createdAt: 1,
    updatedAt: 2,
    findingCounts: { new: 0, fixed: 0, dismissed: 0, reopened: 0 },
    workflowRef: { name: "default", stale: false },
    feedback: null,
    jobs: {},
    ...partial,
  }
}

function run(partial: Partial<RunSummary>): RunSummary {
  return {
    id: "run-1",
    featureId: "f-1",
    jobId: "job-a",
    stepId: "step-a",
    stepType: "agent",
    attempt: 1,
    status: "running",
    sessionId: "ses-1",
    outputs: {},
    reason: null,
    nudges: 0,
    timeStarted: 1,
    timeFinished: null,
    ...partial,
  }
}

describe("deriveGateSurfaces", () => {
  it("does not hide persisted attention when the scalar status has drifted", () => {
    const surfaces = deriveGateSurfaces(
      detail({
        status: "running",
        jobs: { review: jobRuntime({ steps: { approve: { status: "waiting_human", outputs: {}, prompt: "merge?" } } }) },
      }),
      [run({ pendingQuestion: "Which storage?" })],
    )
    expect(surfaces.gates).toEqual([{ jobId: "review", stepId: "approve", prompt: "merge?" }])
    expect(surfaces.askingRuns).toEqual([
      { runId: "run-1", jobId: "job-a", stepId: "step-a", prompt: "Which storage?" },
    ])
  })

  it("returns nothing for a null/undefined detail", () => {
    expect(deriveGateSurfaces(null, [])).toEqual({ gates: [], askingRuns: [] })
    expect(deriveGateSurfaces(undefined, [])).toEqual({ gates: [], askingRuns: [] })
  })

  it("enumerates a single waiting gate step with its prompt", () => {
    const d = detail({
      jobs: { review: jobRuntime({ status: "running", steps: { approve: { status: "waiting_human", outputs: {}, prompt: "merge?" } } }) },
    })
    const surfaces = deriveGateSurfaces(d, [])
    expect(surfaces.gates).toEqual([{ jobId: "review", stepId: "approve", prompt: "merge?" }])
    expect(surfaces.askingRuns).toEqual([])
  })

  it("enumerates every waiting_human step across multiple parallel jobs", () => {
    const d = detail({
      jobs: {
        docs: jobRuntime({ status: "running", steps: { review: { status: "waiting_human", outputs: {}, prompt: "docs ok?" } } }),
        infra: jobRuntime({ status: "running", steps: { approve: { status: "waiting_human", outputs: {}, prompt: "infra ok?" } } }),
      },
    })
    const surfaces = deriveGateSurfaces(d, [])
    expect(surfaces.gates).toEqual([
      { jobId: "docs", stepId: "review", prompt: "docs ok?" },
      { jobId: "infra", stepId: "approve", prompt: "infra ok?" },
    ])
  })

  it("enumerates steps within one job in stable stepId order", () => {
    const d = detail({
      jobs: {
        review: jobRuntime({
          status: "running",
          steps: {
            zzz: { status: "waiting_human", outputs: {}, prompt: "z" },
            aaa: { status: "waiting_human", outputs: {}, prompt: "a" },
          },
        }),
      },
    })
    const surfaces = deriveGateSurfaces(d, [])
    expect(surfaces.gates.map(g => g.stepId)).toEqual(["aaa", "zzz"])
  })

  it("a step without a rendered prompt carries a null prompt, not undefined leaking through", () => {
    const d = detail({
      jobs: { review: jobRuntime({ status: "running", steps: { approve: { status: "waiting_human", outputs: {} } } }) },
    })
    const surfaces = deriveGateSurfaces(d, [])
    expect(surfaces.gates).toEqual([{ jobId: "review", stepId: "approve", prompt: null }])
  })

  it("collects asking runs from activeRuns independent of gate steps", () => {
    const d = detail({ jobs: {} })
    const surfaces = deriveGateSurfaces(d, [
      run({ id: "run-1", jobId: "explore", stepId: "investigate", pendingQuestion: "Which storage?" }),
    ])
    expect(surfaces.askingRuns).toEqual([
      { runId: "run-1", jobId: "explore", stepId: "investigate", prompt: "Which storage?" },
    ])
    expect(surfaces.gates).toEqual([])
  })

  it("enumerates multiple concurrent asking runs, sorted by jobId then stepId", () => {
    const d = detail({ jobs: {} })
    const surfaces = deriveGateSurfaces(d, [
      run({ id: "run-2", jobId: "zzz", stepId: "a", pendingQuestion: "Q2" }),
      run({ id: "run-1", jobId: "aaa", stepId: "b", pendingQuestion: "Q1" }),
    ])
    expect(surfaces.askingRuns.map(a => a.runId)).toEqual(["run-1", "run-2"])
  })

  it("ignores active runs without a pending question", () => {
    const d = detail({ jobs: {} })
    const surfaces = deriveGateSurfaces(d, [run({ pendingQuestion: null }), run({ id: "run-2", pendingQuestion: undefined })])
    expect(surfaces.askingRuns).toEqual([])
  })

  it("carries answerDelivery through to the asking-run surface when accepted-pending (harden-interactive-answer-delivery 3.1)", () => {
    const d = detail({ jobs: {} })
    const surfaces = deriveGateSurfaces(d, [
      run({
        id: "run-1",
        jobId: "explore",
        stepId: "investigate",
        pendingQuestion: "Which storage?",
        answerDelivery: { status: "pending", acceptedAt: 100 },
      }),
    ])
    expect(surfaces.askingRuns).toEqual([
      { runId: "run-1", jobId: "explore", stepId: "investigate", prompt: "Which storage?", answerDelivery: { status: "pending", acceptedAt: 100 } },
    ])
  })

  it("omits answerDelivery on the surface when the run carries none", () => {
    const d = detail({ jobs: {} })
    const surfaces = deriveGateSurfaces(d, [
      run({ id: "run-1", jobId: "explore", stepId: "investigate", pendingQuestion: "Which storage?" }),
    ])
    expect(surfaces.askingRuns[0]!.answerDelivery).toBeUndefined()
  })

  it("mixed scenario: waiting gates and asking runs coexist independently", () => {
    const d = detail({
      jobs: { review: jobRuntime({ status: "running", steps: { approve: { status: "waiting_human", outputs: {}, prompt: "merge?" } } }) },
    })
    const surfaces = deriveGateSurfaces(d, [
      run({ id: "run-1", jobId: "explore", stepId: "investigate", pendingQuestion: "Which storage?" }),
    ])
    expect(surfaces.gates).toHaveLength(1)
    expect(surfaces.askingRuns).toHaveLength(1)
    expect(surfaceCount(surfaces)).toBe(2)
  })
})

describe("surfaceCount", () => {
  it("sums gates and asking runs", () => {
    expect(
      surfaceCount({
        gates: [{ jobId: "a", stepId: "b", prompt: null }],
        askingRuns: [{ runId: "r", jobId: "c", stepId: "d", prompt: "q" }],
      }),
    ).toBe(2)
  })

  it("is zero for empty surfaces", () => {
    expect(surfaceCount({ gates: [], askingRuns: [] })).toBe(0)
  })
})

describe("surfaceItemKey", () => {
  it("keys a gate by jobId+stepId", () => {
    expect(surfaceItemKey({ kind: "gate", jobId: "a", stepId: "b", prompt: null })).toBe("gate:a:b")
  })

  it("keys an asking run by runId alone", () => {
    expect(surfaceItemKey({ kind: "ask", runId: "run-1", jobId: "a", stepId: "b", prompt: "q" })).toBe("ask:run-1")
  })
})

describe("allSurfaceItems", () => {
  it("flattens gates before asking runs", () => {
    const items = allSurfaceItems({
      gates: [{ jobId: "docs", stepId: "review", prompt: "docs ok?" }],
      askingRuns: [{ runId: "run-1", jobId: "explore", stepId: "investigate", prompt: "storage?" }],
    })
    expect(items.map(surfaceItemKey)).toEqual(["gate:docs:review", "ask:run-1"])
  })

  it("a single gate is the only item — no navigator ceremony implied", () => {
    const items = allSurfaceItems({ gates: [{ jobId: "docs", stepId: "review", prompt: "ok?" }], askingRuns: [] })
    expect(items).toHaveLength(1)
  })
})

describe("pickSurfaceItem", () => {
  const items = allSurfaceItems({
    gates: [
      { jobId: "docs", stepId: "review", prompt: "docs?" },
      { jobId: "infra", stepId: "approve", prompt: "infra?" },
    ],
    askingRuns: [],
  })

  it("defaults to the first item when nothing is selected", () => {
    expect(pickSurfaceItem(items, null)).toEqual(items[0]!)
  })

  it("keeps the current selection when it still exists", () => {
    expect(pickSurfaceItem(items, "gate:infra:approve")).toEqual(items[1]!)
  })

  it("falls back to the first item once the current selection disappears", () => {
    expect(pickSurfaceItem(items, "gate:gone:gone")).toEqual(items[0]!)
  })

  it("returns null for an empty list regardless of the requested key", () => {
    expect(pickSurfaceItem([], "gate:a:b")).toBeNull()
  })
})
