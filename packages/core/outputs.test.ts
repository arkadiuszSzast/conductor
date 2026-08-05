import { describe, expect, it } from "bun:test"
import { interpret } from "./src/interpret.ts"
import { agentStep, featureState, job, jobRuntime, workflow } from "./testing.ts"
import type { FeatureState, JobRuntime, WorkflowDef } from "./src/types.ts"

const roles: WorkflowDef["roles"] = {
  architect: { agent: "build" },
  planner: { agent: "build" },
}

const producer = job(
  [agentStep("design", "architect", "design")],
  [],
  undefined,
  { design: "{{ steps.design.outputs.report }}" },
)

const consumer = job(
  [agentStep("plan", "planner", "plan the work")],
  ["producer"],
)

const def = workflow(
  { producer, consumer },
  roles,
  "outputs",
)

function runtime(over: Partial<JobRuntime> = {}): JobRuntime {
  return jobRuntime({ status: "running", ...over })
}

function state(over: Partial<FeatureState> = {}): FeatureState {
  return featureState(
    {
      producer: runtime({ currentStep: "design" }),
      consumer: jobRuntime({ status: "pending" }),
    },
    over,
  )
}

describe("job output resolution", () => {
  it("publishes declared outputs when the last step completes", () => {
    const t = interpret(
      def,
      state(),
      { kind: "step.completed", jobId: "producer", stepId: "design", outputs: { report: "DESIGN" } },
    )
    expect(t.patch.jobs?.producer?.status).toBe("succeeded")
    expect(t.patch.jobs?.producer?.outputs).toEqual({ design: "DESIGN" })
  })

  it("unblocks the dependent after outputs are resolved", () => {
    const t = interpret(
      def,
      state(),
      { kind: "step.completed", jobId: "producer", stepId: "design", outputs: { report: "DESIGN" } },
    )
    expect(t.decisions).toContainEqual({ kind: "execute_step", jobId: "consumer", stepId: "plan" })
    expect(t.patch.jobs?.consumer?.status).toBe("running")
  })

  it("publishes outputs that reference earlier steps too", () => {
    const multiStep = job(
      [
        agentStep("design", "architect", "d"),
        agentStep("detail", "architect", "t"),
      ],
      [],
      undefined,
      { combined: "{{ steps.design.outputs.report }}/{{ steps.detail.outputs.report }}" },
    )
    const wf = workflow({ main: multiStep }, roles)
    const state2 = featureState({
      main: jobRuntime({
        status: "running",
        currentStep: "detail",
        steps: { design: { status: "succeeded", outputs: { report: "D" } } },
      }),
    })
    const t = interpret(wf, state2, {
      kind: "step.completed",
      jobId: "main",
      stepId: "detail",
      outputs: { report: "T" },
    })
    expect(t.patch.jobs?.main?.outputs).toEqual({ combined: "D/T" })
  })

  it("resolves an unresolvable declared output to null and still completes", () => {
    const broken = job(
      [agentStep("design", "architect", "d")],
      [],
      undefined,
      { branch: "{{ steps.worktree.outputs.branch }}" },
    )
    const wf = workflow({ main: broken }, roles)
    const state2 = featureState({ main: runtime({ currentStep: "design" }) })
    const t = interpret(wf, state2, {
      kind: "step.completed",
      jobId: "main",
      stepId: "design",
      outputs: { report: "DESIGN" },
    })
    expect(t.patch.jobs?.main?.status).toBe("succeeded")
    expect(t.patch.jobs?.main?.outputs).toEqual({ branch: null })
  })
})
