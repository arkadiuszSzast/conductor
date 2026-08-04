import { describe, expect, it } from "bun:test"
import { interpret } from "./src/interpret.ts"
import { validateWorkflow } from "./src/validate.ts"
import {
  actionStep,
  agentStep,
  backoff,
  commandStep,
  featureState,
  goto,
  humanStep,
  job,
  jobRuntime,
  next,
  rerunJobs,
  rerunSteps,
  workflow as mkWorkflow,
} from "./testing.ts"
import type { FeatureState, JobRuntime, WorkflowDef } from "./src/types.ts"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const roles: WorkflowDef["roles"] = {
  architect: { agent: "build", model: "prov/arch" },
  adjudicator: { agent: "review", model: "prov/adj" },
  planner: { agent: "build", model: "prov/plan" },
}

const mkJob = jobRuntime

function mkState(jobs: Record<string, JobRuntime>, status: FeatureState["status"] = "running"): FeatureState {
  return featureState(jobs, { status })
}

// ---------------------------------------------------------------------------
// Two-architect parallel consensus workflow (the motivating example)
// ---------------------------------------------------------------------------

const twoArchitectsWorkflow = mkWorkflow(
  {
    "arch-a": job([agentStep("design", "architect", "Design {{feature}}.")]),
    "arch-b": job([agentStep("design", "architect", "Design independently.")]),
    consensus: job(
      [
        agentStep("check", "adjudicator", "Compare designs.", {
          outcomes: {
            agree: next,
            disagree: rerunJobs(["arch-a", "arch-b"], 3),
          },
        }),
        agentStep("breakdown", "planner", "Split into tasks."),
      ],
      ["arch-a", "arch-b"],
    ),
  },
  roles,
  "parallel-design",
)

describe("cross-job rerun", () => {
  it("validates the two-architects workflow cleanly", () => {
    const v = validateWorkflow(twoArchitectsWorkflow)
    expect(v.errors).toEqual([])
  })

  it("feature.start dispatches both architects in parallel", () => {
    const state = mkState({
      "arch-a": mkJob(),
      "arch-b": mkJob(),
      consensus: mkJob(),
    })
    const t = interpret(twoArchitectsWorkflow, state, { kind: "feature.start" })
    expect(t.decisions).toHaveLength(2)
    const jobIds = (t.decisions as { jobId: string }[]).map(d => d.jobId)
    expect(jobIds).toContain("arch-a")
    expect(jobIds).toContain("arch-b")
  })

  it("disagree triggers rerun with feedback snapshot", () => {
    const state = mkState({
      "arch-a": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "DESIGN_A" } } }),
      "arch-b": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "DESIGN_B" } } }),
      consensus: mkJob({ status: "running", currentStep: "check", steps: { check: { status: "running", output: "they disagree" } } }),
    })
    const t = interpret(twoArchitectsWorkflow, state, {
      kind: "step.completed",
      jobId: "consensus",
      stepId: "check",
      outcome: "disagree",
      output: "They disagree about X.",
    })

    expect(t.decisions).toHaveLength(2)
    const jobIds = (t.decisions as { jobId: string }[]).map(d => d.jobId)
    expect(jobIds).toContain("arch-a")
    expect(jobIds).toContain("arch-b")

    const consensusJob = t.patch.jobs?.consensus
    expect(consensusJob?.status).toBe("pending")
    expect(consensusJob?.reruns?.check).toBe(1)

    const archAJob = t.patch.jobs?.["arch-a"]
    expect(archAJob?.status).toBe("running")
    expect(archAJob?.currentStep).toBe("design")

    expect(t.feedback).toBeDefined()
    expect(t.feedback?.jobs["arch-a"]?.design).toBe("DESIGN_A")
    expect(t.feedback?.jobs["arch-b"]?.design).toBe("DESIGN_B")
    expect(t.feedback?.jobs?.consensus?.check).toBe("They disagree about X.")
    expect(t.feedback?.message).toContain("disagree")
  })

  it("agree proceeds to breakdown without rerun", () => {
    const state = mkState({
      "arch-a": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "DESIGN_A" } } }),
      "arch-b": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "DESIGN_B" } } }),
      consensus: mkJob({ status: "running", currentStep: "check" }),
    })
    const t = interpret(twoArchitectsWorkflow, state, {
      kind: "step.completed",
      jobId: "consensus",
      stepId: "check",
      outcome: "agree",
    })
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "consensus", stepId: "breakdown" }])
    expect(t.feedback).toBeUndefined()
  })

  it("escalates after maxRounds (non-converging)", () => {
    const state = mkState({
      "arch-a": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "v3" } } }),
      "arch-b": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "v3" } } }),
      consensus: mkJob({ status: "running", currentStep: "check", reruns: { check: 3 } }),
    })
    const t = interpret(twoArchitectsWorkflow, state, {
      kind: "step.completed",
      jobId: "consensus",
      stepId: "check",
      outcome: "disagree",
    })
    expect(t.decisions[0]?.kind).toBe("escalate")
    expect(t.patch.status).toBe("escalated")
    expect(t.feedback).toBeUndefined()
  })

  it("downstream jobs are reset in the closure", () => {
    const state = mkState({
      "arch-a": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "D1" } } }),
      "arch-b": mkJob({ status: "succeeded", currentStep: null, steps: { design: { status: "succeeded", output: "D2" } } }),
      consensus: mkJob({ status: "running", currentStep: "check" }),
    })
    const t = interpret(twoArchitectsWorkflow, state, {
      kind: "step.completed",
      jobId: "consensus",
      stepId: "check",
      outcome: "disagree",
    })

    expect(t.patch.jobs?.consensus?.status).toBe("pending")
    expect(t.patch.jobs?.consensus?.reruns?.check).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// onFail rerun
// ---------------------------------------------------------------------------

describe("onFail rerun", () => {
  const failRerunWorkflow = mkWorkflow(
    {
      implement: job([agentStep("code", "implementer", "Code it.")]),
      gate: job(
        [commandStep("check", ["./gradlew check"], {
          retry: backoff(2),
          onFail: rerunJobs(["implement"], 2),
        })],
        ["implement"],
      ),
    },
    { implementer: { agent: "build" } },
    "gate-rerun",
  )

  it("validates cleanly", () => {
    expect(validateWorkflow(failRerunWorkflow).errors).toEqual([])
  })

  it("reruns implement when gate exhausts retries", () => {
    const state = mkState({
      implement: mkJob({ status: "succeeded", currentStep: null, steps: { code: { status: "succeeded", output: "v1" } } }),
      gate: mkJob({ status: "running", currentStep: "check", attempts: { check: 2 } }),
    })
    const t = interpret(failRerunWorkflow, state, {
      kind: "step.failed",
      jobId: "gate",
      stepId: "check",
      reason: "test failed",
    })
    expect(t.decisions[0]?.kind).toBe("execute_step")
    expect((t.decisions[0] as { jobId: string }).jobId).toBe("implement")
    expect(t.patch.jobs?.gate?.status).toBe("pending")
    expect(t.patch.jobs?.gate?.reruns?.check).toBe(1)
    expect(t.feedback?.jobs?.implement?.code).toBe("v1")
    expect(t.feedback?.message).toContain("exhausted 2 attempt")
  })

  it("escalates on rerun exhaustion", () => {
    const state = mkState({
      implement: mkJob({ status: "succeeded", currentStep: null, steps: { code: { status: "succeeded", output: "v2" } } }),
      gate: mkJob({ status: "running", currentStep: "check", attempts: { check: 2 }, reruns: { check: 2 } }),
    })
    const t = interpret(failRerunWorkflow, state, {
      kind: "step.failed",
      jobId: "gate",
      stepId: "check",
      reason: "still broken",
    })
    expect(t.decisions[0]?.kind).toBe("escalate")
  })
})

// ---------------------------------------------------------------------------
// Human gate rejection rerun
// ---------------------------------------------------------------------------

describe("human gate rejection rerun", () => {
  const rejectRerunWorkflow = mkWorkflow(
    {
      design: job([agentStep("draft", "designer", "Design.")]),
      approval: job(
        [humanStep("gate", { outcomes: { rejected: rerunJobs(["design"], 3) } })],
        ["design"],
      ),
    },
    { designer: { agent: "build" } },
    "design-loop",
  )

  it("reruns design on human rejection", () => {
    const state = mkState({
      design: mkJob({ status: "succeeded", currentStep: null, steps: { draft: { status: "succeeded", output: "draft" } } }),
      approval: mkJob({ status: "waiting_human", currentStep: "gate" }),
    })
    const t = interpret(rejectRerunWorkflow, state, {
      kind: "step.completed",
      jobId: "approval",
      stepId: "gate",
      outcome: "rejected",
      output: "not convinced",
    })
    expect(t.decisions[0]?.kind).toBe("execute_step")
    expect((t.decisions[0] as { jobId: string }).jobId).toBe("design")
    expect(t.patch.jobs?.approval?.status).toBe("pending")
    expect(t.patch.jobs?.approval?.reruns?.gate).toBe(1)
    expect(t.feedback?.jobs?.design?.draft).toBe("draft")
    expect(t.feedback?.message).toContain("rejected")
    expect(t.feedback?.jobs?.approval?.gate).toBe("not convinced")
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("rerun validation", () => {
  const roleSet = { a: { agent: "build" } }

  it("rejects rerun to a missing job", () => {
    const v = validateWorkflow(mkWorkflow(
      { src: job([agentStep("s", "a", "s", { outcomes: { ok: rerunJobs(["ghost"], 2) } })]) },
      roleSet,
    ))
    expect(v.errors.join("\n")).toContain('"ghost" does not exist')
  })

  it("rejects rerun to the routing job itself", () => {
    const v = validateWorkflow(mkWorkflow(
      { a: job([agentStep("s", "a", "s", { outcomes: { ok: rerunJobs(["a"], 2) } })]) },
      roleSet,
    ))
    expect(v.errors.join("\n")).toContain("must not be the routing job")
  })

  it("rejects rerun to a downstream job", () => {
    const v = validateWorkflow(mkWorkflow(
      {
        src: job([agentStep("s", "a", "s", { outcomes: { ok: rerunJobs(["downstream"], 2) } })]),
        downstream: job([commandStep("d", ["echo ok"])], ["src"]),
      },
      roleSet,
    ))
    expect(v.errors.join("\n")).toContain("downstream")
  })

  it("rejects maxRounds below 1", () => {
    const v = validateWorkflow(mkWorkflow(
      {
        upstream: job([commandStep("s", ["echo"])]),
        src: job([agentStep("s", "a", "s", { outcomes: { ok: rerunJobs(["upstream"], 0) } })], ["upstream"]),
      },
      roleSet,
    ))
    expect(v.errors.join("\n")).toContain("maxRounds must be ≥ 1")
  })

  it("rejects a rerun naming no targets", () => {
    const v = validateWorkflow(mkWorkflow(
      { src: job([agentStep("s", "a", "s", { outcomes: { ok: rerunJobs([], 2) } })]) },
      roleSet,
    ))
    expect(v.errors.join("\n")).toContain("names no jobs")
  })
})

// ---------------------------------------------------------------------------
// Outcome semantics (unified completion)
// ---------------------------------------------------------------------------

describe("outcome semantics", () => {
  const linear = mkWorkflow(
    { main: job([agentStep("one", "a", "one"), agentStep("two", "a", "two")]) },
    { a: { agent: "build" } },
  )

  it("a step without outcomes advances regardless of the reported outcome", () => {
    const state = mkState({ main: mkJob({ status: "running", currentStep: "one" }) })
    const withDefault = interpret(linear, state, { kind: "step.completed", jobId: "main", stepId: "one" })
    const withName = interpret(linear, state, {
      kind: "step.completed", jobId: "main", stepId: "one", outcome: "anything",
    })
    expect(withDefault.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "two" }])
    expect(withName.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "two" }])
  })

  it("records the step output on completion", () => {
    const state = mkState({ main: mkJob({ status: "running", currentStep: "one" }) })
    const t = interpret(linear, state, {
      kind: "step.completed", jobId: "main", stepId: "one", output: "RESULT",
    })
    expect(t.patch.jobs?.main?.steps?.one).toEqual({ status: "succeeded", output: "RESULT" })
  })

  it("escalates on an outcome missing from a declared outcomes map", () => {
    const declared = mkWorkflow(
      {
        main: job([
          agentStep("classify", "a", "c", { outcomes: { cat: next } }),
          agentStep("after", "a", "a"),
        ]),
      },
      { a: { agent: "build" } },
    )
    const t = interpret(declared, mkState({ main: mkJob({ status: "running", currentStep: "classify" }) }), {
      kind: "step.completed", jobId: "main", stepId: "classify", outcome: "dog",
    })
    expect(t.decisions[0]?.kind).toBe("escalate")
    expect((t.decisions[0] as { reason: string }).reason).toContain("dog")
  })

  it("routes a multi-branch classifier to the matching branch", () => {
    const classifier = mkWorkflow(
      {
        main: job([
          agentStep("classify", "a", "c", {
            outcomes: { cat: goto("cat-branch"), dog: goto("dog-branch") },
          }),
          commandStep("cat-branch", ["echo cat"]),
          commandStep("dog-branch", ["echo dog"]),
        ]),
      },
      { a: { agent: "build" } },
    )
    const t = interpret(classifier, mkState({ main: mkJob({ status: "running", currentStep: "classify" }) }), {
      kind: "step.completed", jobId: "main", stepId: "classify", outcome: "dog",
    })
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "dog-branch" }])
  })

  it("an outcome does not consume the retry budget", () => {
    const state = mkState({ main: mkJob({ status: "running", currentStep: "one", attempts: { one: 1 } }) })
    const t = interpret(linear, state, {
      kind: "step.completed", jobId: "main", stepId: "one", outcome: "done",
    })
    expect(t.patch.jobs?.main?.attempts).toBeUndefined()
  })

  it("ignores a stale completion", () => {
    const state = mkState({ main: mkJob({ status: "running", currentStep: "two" }) })
    const t = interpret(linear, state, { kind: "step.completed", jobId: "main", stepId: "one" })
    expect(t.decisions[0]?.kind).toBe("noop")
  })
})

// ---------------------------------------------------------------------------
// Step-level rerun (the in-job review loop)
// ---------------------------------------------------------------------------

describe("step-level rerun", () => {
  const reviewLoop = mkWorkflow(
    {
      main: job([
        agentStep("review", "reviewer", "review", {
          outcomes: {
            approved: goto("merge"),
            changes_requested: rerunSteps(["fix"], 3),
          },
        }),
        agentStep("fix", "fixer", "fix", { outcomes: { done: goto("review") } }),
        actionStep("merge", "git/merge@v1"),
      ]),
    },
    { reviewer: { agent: "review" }, fixer: { agent: "build" } },
    "review-loop",
  )

  it("validates cleanly", () => {
    expect(validateWorkflow(reviewLoop).errors).toEqual([])
  })

  it("loops back to the fixer and counts the round", () => {
    const state = mkState({
      main: mkJob({
        status: "running",
        currentStep: "review",
        steps: { review: { status: "running", output: "findings" } },
      }),
    })
    const t = interpret(reviewLoop, state, {
      kind: "step.completed", jobId: "main", stepId: "review",
      outcome: "changes_requested", output: "findings",
    })
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "fix" }])
    expect(t.patch.jobs?.main?.reruns?.review).toBe(1)
    expect(t.patch.jobs?.main?.status).toBe("running")
    expect(t.feedback?.jobs?.main?.review).toBe("findings")
  })

  it("escalates when the round budget is exhausted", () => {
    const state = mkState({
      main: mkJob({ status: "running", currentStep: "review", reruns: { review: 3 } }),
    })
    const t = interpret(reviewLoop, state, {
      kind: "step.completed", jobId: "main", stepId: "review", outcome: "changes_requested",
    })
    expect(t.decisions[0]?.kind).toBe("escalate")
  })

  it("approved leaves the loop", () => {
    const state = mkState({ main: mkJob({ status: "running", currentStep: "review", reruns: { review: 2 } }) })
    const t = interpret(reviewLoop, state, {
      kind: "step.completed", jobId: "main", stepId: "review", outcome: "approved",
    })
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "merge" }])
  })

  it("rejects rerun to a step outside the job", () => {
    const v = validateWorkflow(mkWorkflow(
      { main: job([agentStep("s", "a", "s", { outcomes: { redo: rerunSteps(["ghost"], 2) } })]) },
      { a: { agent: "build" } },
    ))
    expect(v.errors.join("\n")).toContain('rerun step "ghost" does not exist')
  })
})
