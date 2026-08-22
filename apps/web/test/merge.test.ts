/**
 * Structure+runtime merge and the loop-edge predicate — the core of the
 * variant-A graph semantics. Loop-edge follows the feedback lifecycle
 * from docs/http-api.md: the snapshot's presence alone never means an
 * active loop.
 */
import { describe, expect, it } from "bun:test"
import { loopEdgeOf, mergeGraph, projectBasename, stepGlyph, workflowCompatible } from "../src/graph/merge.ts"
import type { FeatureDetail, JobRuntimeProjection, WorkflowProjection } from "../src/api/types.ts"

function workflow(): WorkflowProjection {
  return {
    name: "default",
    stale: false,
    jobs: {
      design: { needs: [], steps: [{ id: "draft", kind: "agent" }] },
      implement: { needs: ["design"], steps: [{ id: "code", kind: "agent" }, { id: "review", kind: "agent" }] },
      gate: { needs: ["implement"], steps: [{ id: "approve", kind: "human" }] },
    },
    inputs: {},
    diagnostics: [],
  }
}

function jobRuntime(partial: Partial<JobRuntimeProjection>): JobRuntimeProjection {
  return {
    status: "pending",
    currentStep: null,
    attempts: {},
    reruns: {},
    outputs: {},
    steps: {},
    ...partial,
  }
}

function detail(partial: Partial<FeatureDetail>): FeatureDetail {
  return {
    id: "f-1",
    title: "t",
    slug: "t",
    projectDir: "/proj/app",
    workflow: "default",
    description: null,
    status: "running",
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

describe("mergeGraph", () => {
  it("joins step kinds from structure with live status from runtime", () => {
    const model = mergeGraph({
      workflow: workflow(),
      detail: detail({
        jobs: {
          design: jobRuntime({ status: "succeeded", steps: { draft: { status: "succeeded", outputs: {} } } }),
          implement: jobRuntime({
            status: "running",
            currentStep: "review",
            attempts: { code: 1, review: 2 },
            steps: {
              code: { status: "succeeded", outputs: {} },
              review: { status: "running", outputs: {} },
            },
          }),
        },
      }),
    })
    const implement = model.jobs.find(j => j.id === "implement")!
    expect(implement.isCurrent).toBe(true)
    expect(implement.currentStep).toBe("review")
    const review = implement.steps.find(s => s.id === "review")!
    expect(review.status).toBe("running")
    expect(review.kind).toBe("agent")
    expect(review.attempts).toBe(2)
    const gate = model.jobs.find(j => j.id === "gate")!
    expect(gate.status).toBe("pending")
    expect(gate.steps[0]!.kind).toBe("human")
  })

  it("a job missing from runtime renders as pending structure", () => {
    const model = mergeGraph({ workflow: workflow(), detail: detail({}) })
    expect(model.jobs.every(j => j.status === "pending")).toBe(true)
    expect(model.jobs.map(j => j.id)).toEqual(["design", "implement", "gate"])
  })

  it("stale from either the endpoint or workflowRef sets the model flag", () => {
    const staleWorkflow = { ...workflow(), stale: true }
    expect(mergeGraph({ workflow: staleWorkflow, detail: detail({}) }).stale).toBe(true)
    const staleRef = detail({ workflowRef: { name: "default", stale: true } })
    expect(mergeGraph({ workflow: workflow(), detail: staleRef }).stale).toBe(true)
    expect(mergeGraph({ workflow: workflow(), detail: detail({}) }).stale).toBe(false)
  })

  it("the round chip carries the job's highest rerun counter", () => {
    const model = mergeGraph({
      workflow: workflow(),
      detail: detail({
        jobs: { gate: jobRuntime({ reruns: { approve: 2 } }) },
      }),
    })
    expect(model.jobs.find(j => j.id === "gate")!.round).toBe(2)
  })

  it("truncated steps carry their runId pointer", () => {
    const model = mergeGraph({
      workflow: workflow(),
      detail: detail({
        jobs: {
          design: jobRuntime({
            steps: { draft: { status: "succeeded", outputs: { report: "x" }, truncated: true, runId: "run-9" } },
          }),
        },
      }),
    })
    const draft = model.jobs.find(j => j.id === "design")!.steps[0]!
    expect(draft.truncated).toBe(true)
    expect(draft.runId).toBe("run-9")
  })
})

describe("loop-edge predicate", () => {
  const jobIds = new Set(["design", "implement", "gate"])

  it("no feedback snapshot → no edge", () => {
    expect(loopEdgeOf(detail({}), jobIds)).toBeNull()
  })

  it("snapshot present but rerun target completed → no edge (history, not an active loop)", () => {
    const d = detail({
      status: "waiting_human",
      feedback: { jobs: { implement: { code: { report: "old" } } }, message: "needs fixes" },
      jobs: {
        implement: jobRuntime({ status: "succeeded" }),
        gate: jobRuntime({ status: "running", currentStep: "approve", reruns: { approve: 1 } }),
      },
    })
    // The jobs-scope round is over: implement completed and the routing
    // gate is waiting again. The edge disappears; what remains is the
    // ⟲ chip and the timeline (variant-a semantics).
    expect(loopEdgeOf(d, jobIds)).toBeNull()
  })

  it("steps-scope rerun draws a self-loop while the routing job re-runs", () => {
    const d = detail({
      feedback: { jobs: { implement: { review: { verdict: "rejected" } } }, message: "fix the tests" },
      jobs: {
        implement: jobRuntime({ status: "running", currentStep: "code", reruns: { review: 1 } }),
      },
    })
    const edge = loopEdgeOf(d, new Set(["implement"]))
    expect(edge).toEqual({ from: "implement", to: "implement", message: "fix the tests" })
  })

  it("rerun target active again → edge from the routing job to the target", () => {
    const d = detail({
      feedback: { jobs: { implement: { code: { report: "old" } } }, message: "review rejected: fix the tests" },
      jobs: {
        implement: jobRuntime({ status: "running", currentStep: "code" }),
        gate: jobRuntime({ status: "pending", reruns: { approve: 1 } }),
      },
    })
    const edge = loopEdgeOf(d, jobIds)
    expect(edge).toEqual({ from: "gate", to: "implement", message: "review rejected: fix the tests" })
  })

  it("round completed, everything settled → no edge, history only", () => {
    const d = detail({
      status: "done",
      feedback: { jobs: { implement: { code: { report: "old" } } }, message: "was rejected once" },
      jobs: {
        implement: jobRuntime({ status: "succeeded" }),
        gate: jobRuntime({ status: "succeeded", reruns: { approve: 1 } }),
      },
    })
    expect(loopEdgeOf(d, jobIds)).toBeNull()
  })

  it("feedback naming a job unknown to the current workflow draws nothing for it", () => {
    const d = detail({
      feedback: { jobs: { ghost: { code: { x: "y" } } }, message: "stale graph" },
      jobs: {
        gate: jobRuntime({ status: "succeeded", reruns: { approve: 1 } }),
      },
    })
    expect(loopEdgeOf(d, jobIds)).toBeNull()
  })
})

describe("workflowCompatible", () => {
  it("matches when the feature's workflow name equals the current projection's name", () => {
    expect(workflowCompatible("default", "default")).toBe(true)
    expect(workflowCompatible("release", "release")).toBe(true)
  })

  it("a null feature workflow is treated as the implicit default name", () => {
    expect(workflowCompatible(null, "default")).toBe(true)
    expect(workflowCompatible(null, "release")).toBe(false)
  })

  it("rejects a feature whose workflow name no longer matches the registered projection", () => {
    expect(workflowCompatible("release-old", "release-new")).toBe(false)
  })
})

describe("presentation helpers", () => {
  it("projectBasename takes the last path segment", () => {
    expect(projectBasename("/home/user/projects/webapp")).toBe("webapp")
    expect(projectBasename("/webapp/")).toBe("webapp")
  })

  it("step glyphs follow the variant-a legend", () => {
    expect(stepGlyph("succeeded")).toBe("✓")
    expect(stepGlyph("running")).toBe("●")
    expect(stepGlyph("waiting_human")).toBe("◐")
    expect(stepGlyph("pending")).toBe("○")
    expect(stepGlyph("skipped")).toBe("⤼")
  })
})
