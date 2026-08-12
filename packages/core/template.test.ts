import { describe, expect, it } from "bun:test"
import { buildEvalContext, extractExpressions, renderTemplate, resolveJobOutputs } from "./src/template.ts"
import type { EvalContext } from "./src/expression.ts"
import { agentStep, commandStep, featureState, job, jobRuntime, workflow } from "./testing.ts"
import type { WorkflowDef } from "./src/types.ts"

const context: EvalContext = {
  inputs: { feature: "auth" },
  steps: { design: { outputs: { report: "DESIGN" } } },
  needs: { "arch-a": { outputs: { design: "A" } } },
}

describe("renderTemplate", () => {
  it("renders a simple placeholder", () => {
    expect(renderTemplate("hello {{ 'world' }}", context).text).toBe("hello world")
  })

  it("renders context values through expressions", () => {
    expect(renderTemplate("feature={{ inputs.feature }}", context).text).toBe("feature=auth")
    expect(renderTemplate("{{ steps.design.outputs.report }}", context).text).toBe("DESIGN")
    expect(renderTemplate("{{ needs['arch-a'].outputs.design }}", context).text).toBe("A")
  })

  it("leaves text without placeholders untouched", () => {
    expect(renderTemplate("plain text", context).text).toBe("plain text")
  })

  it("renders a hard miss as an error, not silently empty", () => {
    const r = renderTemplate("a={{ steps.nope.outputs.report }}", context)
    expect(r.text).toBe("a=")
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain("steps.nope.outputs.report")
  })

  it("renders soft feedback misses as the empty string", () => {
    const r = renderTemplate("prev={{ feedback.message }}", context)
    expect(r.errors).toEqual([])
    expect(r.text).toBe("prev=")
  })

  it("renders feedback values when the snapshot is present", () => {
    const ctx: EvalContext = {
      ...context,
      feedback: { message: "redo", jobs: { "arch-a": { design: { report: "OLD" } } } },
    }
    expect(renderTemplate("{{ feedback.message }} / {{ feedback.jobs['arch-a']['design']['report'] }}", ctx).text)
      .toBe("redo / OLD")
  })

  it("reports a parse error in a placeholder", () => {
    const r = renderTemplate("{{ inputs.feature }}", { ...context })
    expect(r.text).toBe("auth")
    const bad = renderTemplate("{{ inputs.feature + 1 }}", context)
    expect(bad.errors).toHaveLength(1)
  })

  it("renders booleans and numbers as text", () => {
    expect(renderTemplate("{{ 1 == 1 }}", context).text).toBe("true")
    expect(renderTemplate("{{ inputs.feature == 'auth' }}", context).text).toBe("true")
  })
})

describe("extractExpressions", () => {
  it("returns the raw expression sources", () => {
    expect(extractExpressions("{{ a }} and {{ b.c }}")).toEqual([" a ", " b.c "])
  })

  it("returns nothing for a plain string", () => {
    expect(extractExpressions("no templates")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildEvalContext + resolveJobOutputs over the full IR
// ---------------------------------------------------------------------------

const roles: WorkflowDef["roles"] = {
  architect: { agent: "build" },
  judge: { agent: "review" },
}

const workflowDef = workflow(
  {
    "arch-a": job(
      [agentStep("design", "architect", "design")],
      [],
      undefined,
      { design: "{{ steps.design.outputs.report }}" },
    ),
    consensus: job(
      [agentStep("agree", "judge", "compare")],
      ["arch-a"],
      undefined,
      { decision: "{{ steps.agree.outputs.report }}" },
    ),
  },
  roles,
  "ctx",
)

describe("buildEvalContext", () => {
  it("exposes inputs, own steps and declared dependency outputs", () => {
    const state = featureState(
      {
        "arch-a": jobRuntime({
          status: "succeeded",
          outputs: { design: "DESIGN" },
          steps: { design: { status: "succeeded", outputs: { report: "DESIGN" } } },
        }),
        consensus: jobRuntime({ status: "running", steps: { agree: { status: "running", outputs: {} } } }),
      },
      { input: { feature: "auth" } },
    )

    const ctx = buildEvalContext(workflowDef, state, "consensus")
    expect(renderTemplate("{{ inputs.feature }}", ctx).text).toBe("auth")
    expect(renderTemplate("{{ needs['arch-a'].outputs.design }}", ctx).text).toBe("DESIGN")
    expect(renderTemplate("{{ steps.agree.outputs.report }}", ctx).text).toBe("")
  })

  it("attaches the feedback snapshot to the context", () => {
    const state = featureState(
      {
        "arch-a": jobRuntime({ status: "running", steps: { design: { status: "running", outputs: {} } } }),
      },
      { input: {} },
    )
    const feedback = { message: "redo", jobs: { "arch-a": { design: { report: "OLD" } } } }
    const ctx = buildEvalContext(workflowDef, state, "arch-a", feedback)
    expect(renderTemplate("{{ feedback.jobs['arch-a']['design']['report'] }}", ctx).text).toBe("OLD")
  })

  it("exposes the feature's own fields; missing description renders empty", () => {
    const state = featureState({ "arch-a": jobRuntime({ status: "running" }) }, { description: null, pr: 7 })
    const ctx = buildEvalContext(workflowDef, state, "arch-a")
    expect(renderTemplate("{{ feature.title }}|{{ feature.slug }}|{{ feature.description }}|{{ feature.pr }}", ctx).text).toBe(
      "test feature|test-feature||7",
    )
    const described = buildEvalContext(workflowDef, featureState({ "arch-a": jobRuntime({ status: "running" }) }, { description: "Do the thing" }), "arch-a")
    expect(renderTemplate("Task: {{ feature.description }}", described).text).toBe("Task: Do the thing")
  })
})

describe("resolveJobOutputs", () => {
  it("resolves declared outputs against live step outputs on completion", () => {
    const state = featureState(
      {
        "arch-a": jobRuntime({
          status: "running",
          currentStep: "design",
          steps: { design: { status: "running", outputs: {} } },
        }),
        consensus: jobRuntime({ status: "pending" }),
      },
      { input: {} },
    )

    const outputs = resolveJobOutputs(workflowDef, state, "arch-a", "design", { report: "DESIGN" })
    expect(outputs).toEqual({ design: "DESIGN" })
  })

  it("evaluates a job output that references an earlier step too", () => {
    const def = workflow(
      {
        main: job(
          [agentStep("design", "architect", "d"), agentStep("detail", "architect", "t")],
          [],
          undefined,
          { combined: "{{ steps.design.outputs.report }}/{{ steps.detail.outputs.report }}" },
        ),
      },
      roles,
    )
    const state = featureState({
      main: jobRuntime({
        status: "running",
        steps: { design: { status: "succeeded", outputs: { report: "D" } } },
      }),
    })
    const outputs = resolveJobOutputs(def, state, "main", "detail", { report: "T" })
    expect(outputs.combined).toBe("D/T")
  })

  it("resolves an unresolved declared output to null", () => {
    const def = workflow(
      {
        main: job(
          [commandStep("gate", ["true"])],
          [],
          undefined,
          { branch: "{{ steps.worktree.outputs.branch }}" },
        ),
      },
      roles,
    )
    const state = featureState({
      main: jobRuntime({ status: "running", steps: { gate: { status: "running", outputs: {} } } }),
    })
    const outputs = resolveJobOutputs(def, state, "main", "gate", {})
    expect(outputs.branch).toBeNull()
  })
})
