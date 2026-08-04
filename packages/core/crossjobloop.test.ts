import { describe, expect, it } from "bun:test"
import { interpret } from "./src/interpret.ts"
import { validateWorkflow } from "./src/validate.ts"
import type {
  FeatureState,
  JobRuntime,
  PipelineEvent,
  WorkflowDef,
} from "./src/types.ts"

// ---------------------------------------------------------------------------
// Shared state helpers
// ---------------------------------------------------------------------------

const roles: WorkflowDef["roles"] = {
  architect: { agent: "build", model: "prov/arch" },
  adjudicator: { agent: "review", model: "prov/adj" },
  planner: { agent: "build", model: "prov/plan" },
}

function mkJob(overrides: Partial<JobRuntime> = {}): JobRuntime {
  return {
    status: "pending",
    currentStep: null,
    attempts: {},
    rounds: {},
    reruns: {},
    outputs: {},
    steps: {},
    ...overrides,
  }
}

function mkState(jobs: Record<string, JobRuntime>, status: FeatureState["status"] = "running"): FeatureState {
  return {
    id: "f1", title: "t", slug: "t", projectDir: "/p",
    workflow: "w", description: null, status,
    trigger: null, input: {}, sessionId: null,
    worktree: null, branch: null, pr: null,
    jobs,
  }
}

// ---------------------------------------------------------------------------
// Two-architect parallel consensus workflow (the motivating example)
// ---------------------------------------------------------------------------

const twoArchitectsWorkflow: WorkflowDef = {
  name: "parallel-design",
  roles,
  jobs: {
    "arch-a": { steps: [{ id: "design", type: "agent", role: "architect", prompt: "Design {{feature}}." }] },
    "arch-b": { steps: [{ id: "design", type: "agent", role: "architect", prompt: "Design independently." }] },
    consensus: {
      needs: ["arch-a", "arch-b"],
      steps: [
        {
          id: "check",
          type: "agent",
          role: "adjudicator",
          prompt: "Compare designs.",
          onVerdict: {
            agree: { next: true },
            disagree: {
              rerun: { jobIds: ["arch-a", "arch-b"], maxRounds: 3 },
            },
          },
        },
        { id: "breakdown", type: "agent", role: "planner", prompt: "Split into tasks." },
      ],
    },
  },
}

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
      kind: "step.verdict",
      jobId: "consensus",
      stepId: "check",
      verdict: "disagree",
      output: "They disagree about X.",
    })

    expect(t.decisions).toHaveLength(2)
    const jobIds = (t.decisions as { jobId: string }[]).map(d => d.jobId)
    expect(jobIds).toContain("arch-a")
    expect(jobIds).toContain("arch-b")

    const consensusJob = t.patch.jobs?.consensus
    expect(consensusJob?.status).toBe("pending")
    expect(consensusJob?.reruns?.check).toBe(1)
    expect(consensusJob?.steps).toEqual({})

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
      kind: "step.verdict",
      jobId: "consensus",
      stepId: "check",
      verdict: "agree",
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
      kind: "step.verdict",
      jobId: "consensus",
      stepId: "check",
      verdict: "disagree",
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
      kind: "step.verdict",
      jobId: "consensus",
      stepId: "check",
      verdict: "disagree",
    })

    expect(t.patch.jobs?.consensus?.status).toBe("pending")
    expect(t.patch.jobs?.consensus?.reruns?.check).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// onFail rerun
// ---------------------------------------------------------------------------

describe("onFail rerun", () => {
  const failRerunWorkflow: WorkflowDef = {
    name: "gate-rerun",
    roles: { implementer: { agent: "build" } },
    jobs: {
      implement: { steps: [{ id: "code", type: "agent", role: "implementer", prompt: "Code it." }] },
      gate: {
        needs: ["implement"],
        steps: [{
          id: "check",
          type: "command",
          run: ["./gradlew check"],
          retry: { strategy: "backoff", maxAttempts: 2, backoff: { strategy: "constant", delay: 100 } },
          onFail: {
            rerun: { jobIds: ["implement"], maxRounds: 2 },
          },
        }],
      },
    },
  }

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
// onReject rerun
// ---------------------------------------------------------------------------

describe("onReject rerun", () => {
  const rejectRerunWorkflow: WorkflowDef = {
    name: "design-loop",
    roles: { designer: { agent: "build" } },
    jobs: {
      design: { steps: [{ id: "draft", type: "agent", role: "designer", prompt: "Design." }] },
      approval: {
        needs: ["design"],
        steps: [
          {
            id: "gate",
            type: "human",
            onReject: {
              rerun: { jobIds: ["design"], maxRounds: 3 },
            },
          },
        ],
      },
    },
  }

  it("reruns design on human rejection", () => {
    const state = mkState({
      design: mkJob({ status: "succeeded", currentStep: null, steps: { draft: { status: "succeeded", output: "draft" } } }),
      approval: mkJob({ status: "waiting_human", currentStep: "gate" }),
    })
    const t = interpret(rejectRerunWorkflow, state, {
      kind: "human.rejected",
      jobId: "approval",
      stepId: "gate",
    })
    expect(t.decisions[0]?.kind).toBe("execute_step")
    expect((t.decisions[0] as { jobId: string }).jobId).toBe("design")
    expect(t.patch.jobs?.approval?.status).toBe("pending")
    expect(t.patch.jobs?.approval?.reruns?.gate).toBe(1)
    expect(t.feedback?.jobs?.design?.draft).toBe("draft")
    expect(t.feedback?.message).toContain("rejected")
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("rerun validation", () => {
  it("rejects rerun to a missing job", () => {
    const v = validateWorkflow({
      name: "x",
      roles: { a: { agent: "build" } },
      jobs: {
        src: { steps: [{ id: "s", type: "agent", role: "a", prompt: "s", onVerdict: { ok: { rerun: { jobIds: ["ghost"], maxRounds: 2 } } } }] },
      },
    })
    expect(v.errors.join("\n")).toContain('"ghost" does not exist')
  })

  it("rejects rerun to the routing job itself", () => {
    const v = validateWorkflow({
      name: "x",
      roles: { a: { agent: "build" } },
      jobs: {
        a: { steps: [{ id: "s", type: "agent", role: "a", prompt: "s", onVerdict: { ok: { rerun: { jobIds: ["a"], maxRounds: 2 } } } }] },
      },
    })
    expect(v.errors.join("\n")).toContain("must not be the routing job")
  })

  it("rejects rerun to a downstream job", () => {
    const v = validateWorkflow({
      name: "x",
      roles: { a: { agent: "build" } },
      jobs: {
        src: { steps: [{ id: "s", type: "agent", role: "a", prompt: "s", onVerdict: { ok: { rerun: { jobIds: ["downstream"], maxRounds: 2 } } } }] },
        downstream: { needs: ["src"], steps: [{ id: "d", type: "command", run: ["echo ok"] }] },
      },
    })
    expect(v.errors.join("\n")).toContain("downstream")
  })

  it("rejects maxRounds below 1", () => {
    const v = validateWorkflow({
      name: "x",
      roles: { a: { agent: "build" } },
      jobs: {
        upstream: { steps: [{ id: "s", type: "command", run: ["echo"] }] },
        src: {
          needs: ["upstream"],
          steps: [{ id: "s", type: "agent", role: "a", prompt: "s", onVerdict: { ok: { rerun: { jobIds: ["upstream"], maxRounds: 0 } } } }],
        },
      },
    })
    expect(v.errors.join("\n")).toContain("maxRounds must be ≥ 1")
  })

  it("rejects goto combined with rerun", () => {
    const v = validateWorkflow({
      name: "x",
      roles: { a: { agent: "build" } },
      jobs: {
        src: { steps: [{ id: "s", type: "agent", role: "a", prompt: "s", onVerdict: { ok: { goto: "s", rerun: { jobIds: ["x"], maxRounds: 2 } } } }] },
      },
    })
    expect(v.errors.join("\n")).toContain("must not be combined")
  })
})
