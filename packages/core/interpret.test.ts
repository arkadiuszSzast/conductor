import { describe, expect, it } from "bun:test"
import { interpret } from "./src/interpret.ts"
import type {
  FeatureState,
  JobRuntime,
  PipelineEvent,
  StepDef,
  WorkflowDef,
} from "./src/types.ts"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const roles: WorkflowDef["roles"] = {
  implementer: { agent: "build", model: "prov/impl" },
  reviewer: { agent: "review", model: "prov/review" },
  fixer: { agent: "build", model: "prov/impl" },
}

const steps: StepDef[] = [
  { id: "implement", type: "agent", role: "implementer", prompt: "implement {{feature}}" },
  {
    id: "gate",
    type: "command",
    run: ["./gradlew check"],
    retry: { strategy: "backoff", maxAttempts: 2, backoff: { strategy: "constant", delay: 100 } },
    onFail: { goto: "fix_gate" },
  },
  { id: "fix_gate", type: "agent", role: "fixer", prompt: "fix the gate", then: "gate" },
  {
    id: "review",
    type: "agent",
    role: "reviewer",
    prompt: "review the diff",
    roundsWith: "fix_review",
    maxRounds: 3,
    onVerdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
  },
  { id: "fix_review", type: "agent", role: "fixer", prompt: "fix the review findings", then: "review" },
  { id: "approve-merge", type: "human", onReject: { goto: "fix_review" } },
  { id: "merge", type: "action", uses: "git/pr-merge@v1" },
]

const workflow: WorkflowDef = {
  name: "test",
  roles,
  jobs: { main: { steps } },
}

function job(over: Partial<JobRuntime> = {}): JobRuntime {
  return {
    status: "running",
    currentStep: null,
    attempts: {},
    rounds: {},
    outputs: {},
    steps: {},
    ...over,
  }
}

function state(over: Partial<FeatureState> = {}): FeatureState {
  return {
    id: "f1",
    title: "Test feature",
    slug: "test-feature",
    projectDir: "/tmp/proj",
    workflow: null,
    description: null,
    status: "running",
    trigger: null,
    input: {},
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    jobs: { main: job() },
    ...over,
  }
}

function evt(e: Omit<PipelineEvent, "jobId"> & { jobId?: string }): PipelineEvent {
  return { jobId: "main", ...e } as PipelineEvent
}

// ---------------------------------------------------------------------------
// feature.start
// ---------------------------------------------------------------------------

describe("feature.start", () => {
  it("enters the first step", () => {
    const t = interpret(workflow, state(), { kind: "feature.start" })
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "implement" }])
    expect(t.patch.jobs?.main?.currentStep).toBe("implement")
    expect(t.patch.status).toBe("running")
  })
})

// ---------------------------------------------------------------------------
// step.succeeded
// ---------------------------------------------------------------------------

describe("step.succeeded", () => {
  it("advances to the next step in list order", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "implement" }) } }),
      evt({ kind: "step.succeeded", stepId: "implement" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "gate" }])
  })

  it("honours explicit then", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "fix_gate" }) } }),
      evt({ kind: "step.succeeded", stepId: "fix_gate" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "gate" }])
  })

  it("finishes after the last step", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "merge" }) } }),
      evt({ kind: "step.succeeded", stepId: "merge" }),
    )
    expect(t.decisions).toEqual([{ kind: "finish" }])
    expect(t.patch.status).toBe("done")
  })

  it("ignores stale success from a step that is no longer current", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "review" }) } }),
      evt({ kind: "step.succeeded", stepId: "implement" }),
    )
    expect(t.decisions[0]?.kind).toBe("noop")
  })

  it("pauses at a human gate step instead of executing it", () => {
    const t = interpret(
      workflow,
      state({
        jobs: {
          main: job({ currentStep: "review", rounds: { review: 1 } }),
        },
      }),
      evt({ kind: "step.verdict", stepId: "review", verdict: "approved" }),
    )
    expect(t.decisions).toEqual([{ kind: "wait_human", jobId: "main", stepId: "approve-merge" }])
    expect(t.patch.status).toBe("waiting_human")
  })
})

// ---------------------------------------------------------------------------
// step.failed
// ---------------------------------------------------------------------------

describe("step.failed", () => {
  it("retries the same step while the retry budget remains", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "gate" }) } }),
      evt({ kind: "step.failed", stepId: "gate", reason: "exit 1" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "gate" }])
    expect(t.patch.jobs?.main?.attempts).toEqual({ gate: 1 })
  })

  it("routes to onFail.goto once the retry budget is exhausted", () => {
    const t = interpret(
      workflow,
      state({
        jobs: { main: job({ currentStep: "gate", attempts: { gate: 2 } }) },
      }),
      evt({ kind: "step.failed", stepId: "gate", reason: "exit 1" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "fix_gate" }])
    expect(t.patch.jobs?.main?.attempts).toEqual({ gate: 3 })
  })

  it("escalates once retries are exhausted when there is no onFail route", () => {
    const localWorkflow: WorkflowDef = {
      name: "test",
      roles,
      jobs: {
        main: {
          steps: [
            { id: "flaky", type: "command", run: ["true"], retry: { strategy: "backoff", maxAttempts: 2, backoff: { strategy: "constant", delay: 100 } } },
          ],
        },
      },
    }
    const t = interpret(
      localWorkflow,
      state({
        jobs: { main: job({ currentStep: "flaky", attempts: { flaky: 2 } }) },
      }),
      evt({ kind: "step.failed", stepId: "flaky", reason: "network" }),
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
    expect(t.patch.status).toBe("escalated")
  })

  it("retries the same step when there is no goto", () => {
    const localWorkflow: WorkflowDef = {
      name: "test",
      roles,
      jobs: {
        main: {
          steps: [
            { id: "flaky", type: "command", run: ["true"], retry: { strategy: "backoff", maxAttempts: 3, backoff: { strategy: "constant", delay: 100 } } },
          ],
        },
      },
    }
    const t = interpret(
      localWorkflow,
      state({ jobs: { main: job({ currentStep: "flaky" }) } }),
      evt({ kind: "step.failed", stepId: "flaky", reason: "network" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "flaky" }])
    expect(t.patch.jobs?.main?.attempts).toEqual({ flaky: 1 })
  })

  it("escalates on the first failure when there is no retry and no onFail route", () => {
    const localWorkflow: WorkflowDef = {
      name: "test",
      roles,
      jobs: {
        main: {
          steps: [
            { id: "critical", type: "command", run: ["true"] },
          ],
        },
      },
    }
    const t = interpret(
      localWorkflow,
      state({ jobs: { main: job({ currentStep: "critical" }) } }),
      evt({ kind: "step.failed", stepId: "critical", reason: "boom" }),
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
  })

  it("treats maxAttempts as total executions including the first", () => {
    const localWorkflow: WorkflowDef = {
      name: "test",
      roles,
      jobs: {
        main: {
          steps: [
            { id: "solo", type: "command", run: ["true"], retry: { strategy: "backoff", maxAttempts: 3, backoff: { strategy: "constant", delay: 100 } } },
          ],
        },
      },
    }
    const first = interpret(
      localWorkflow,
      state({ jobs: { main: job({ currentStep: "solo" }) } }),
      evt({ kind: "step.failed", stepId: "solo", reason: "x" }),
    )
    expect(first.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "solo" }])

    const second = interpret(
      localWorkflow,
      state({ jobs: { main: job({ currentStep: "solo", attempts: { solo: 2 } }) } }),
      evt({ kind: "step.failed", stepId: "solo", reason: "x" }),
    )
    expect(second.decisions[0]?.kind).toBe("escalate")
  })
})

// ---------------------------------------------------------------------------
// step.verdict (review loops)
// ---------------------------------------------------------------------------

describe("step.verdict", () => {
  it("routes changes_requested to the fix step and counts the round", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "review" }) } }),
      evt({ kind: "step.verdict", stepId: "review", verdict: "changes_requested" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "fix_review" }])
    expect(t.patch.jobs?.main?.rounds).toEqual({ review: 1 })
  })

  it("escalates after maxRounds without approval", () => {
    const t = interpret(
      workflow,
      state({
        jobs: { main: job({ currentStep: "review", rounds: { review: 2 } }) },
      }),
      evt({ kind: "step.verdict", stepId: "review", verdict: "changes_requested" }),
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
    expect(t.patch.jobs?.main?.rounds).toEqual({ review: 3 })
  })

  it("approved verdict proceeds past the loop to the human gate", () => {
    const t = interpret(
      workflow,
      state({
        jobs: { main: job({ currentStep: "review", rounds: { review: 2 } }) },
      }),
      evt({ kind: "step.verdict", stepId: "review", verdict: "approved" }),
    )
    expect(t.decisions).toEqual([{ kind: "wait_human", jobId: "main", stepId: "approve-merge" }])
  })

  it("escalates on an unmapped verdict", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "review" }) } }),
      evt({ kind: "step.verdict", stepId: "review", verdict: "wat" }),
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
  })

  it("ignores a stale verdict", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "gate" }) } }),
      evt({ kind: "step.verdict", stepId: "review", verdict: "approved" }),
    )
    expect(t.decisions[0]?.kind).toBe("noop")
  })
})

// ---------------------------------------------------------------------------
// Human interactions
// ---------------------------------------------------------------------------

describe("human interactions", () => {
  it("human.approved advances past the gate to the next step", () => {
    const t = interpret(
      workflow,
      state({
        status: "waiting_human",
        jobs: {
          main: job({
            currentStep: "approve-merge",
            steps: { "approve-merge": { status: "waiting_human", output: null } },
          }),
        },
      }),
      evt({ kind: "human.approved", stepId: "approve-merge" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "merge" }])
    expect(t.patch.status).toBe("running")
  })

  it("human.approved is a noop when nothing awaits approval", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "gate" }) } }),
      evt({ kind: "human.approved", stepId: "approve-merge" }),
    )
    expect(t.decisions[0]?.kind).toBe("noop")
  })

  it("human.rejected routes to onReject.goto", () => {
    const t = interpret(
      workflow,
      state({
        status: "waiting_human",
        jobs: {
          main: job({
            currentStep: "approve-merge",
            steps: { "approve-merge": { status: "waiting_human", output: null } },
          }),
        },
      }),
      evt({ kind: "human.rejected", stepId: "approve-merge" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "fix_review" }])
  })

  it("pause and resume round-trip preserves the current step", () => {
    const paused = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "gate" }) } }),
      { kind: "human.paused" },
    )
    expect(paused.patch.status).toBe("paused")

    const resumed = interpret(
      workflow,
      state({
        status: "paused",
        jobs: { main: job({ currentStep: "gate" }) },
      }),
      { kind: "human.resumed" },
    )
    expect(resumed.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "gate" }])
  })

  it("resume at a human gate waits for the human again", () => {
    const t = interpret(
      workflow,
      state({
        status: "paused",
        jobs: {
          main: job({
            currentStep: "approve-merge",
            steps: { "approve-merge": { status: "waiting_human", output: null } },
          }),
        },
      }),
      { kind: "human.resumed" },
    )
    expect(t.decisions).toEqual([{ kind: "wait_human", jobId: "main", stepId: "approve-merge" }])
  })

  it("resume from ESCALATED re-executes the current step with its budget reset", () => {
    const t = interpret(
      workflow,
      state({
        status: "escalated",
        jobs: {
          main: job({
            currentStep: "gate",
            attempts: { gate: 2, other: 1 },
            rounds: { gate: 3 },
          }),
        },
      }),
      { kind: "human.resumed" },
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "gate" }])
    expect(t.patch.status).toBe("running")
    expect(t.patch.jobs?.main?.attempts).toEqual({ gate: 0, other: 1 })
    expect(t.patch.jobs?.main?.rounds).toEqual({ gate: 0 })
  })

  it("resume on a running feature stays a noop", () => {
    const t = interpret(
      workflow,
      state({ status: "running", jobs: { main: job({ currentStep: "gate" }) } }),
      { kind: "human.resumed" },
    )
    expect(t.decisions[0]?.kind).toBe("noop")
  })

  it("human.abandoned abandons from any state", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "review" }) } }),
      { kind: "human.abandoned" },
    )
    expect(t.decisions[0]?.kind).toBe("abandon")
    expect(t.patch.status).toBe("abandoned")
  })
})

// ---------------------------------------------------------------------------
// DAG: multi-job workflows
// ---------------------------------------------------------------------------

describe("DAG workflows", () => {
  const dagWorkflow: WorkflowDef = {
    name: "dag-test",
    roles,
    jobs: {
      build: {
        steps: [{ id: "compile", type: "command", run: ["make"] }],
      },
      "test-a": {
        needs: ["build"],
        steps: [{ id: "test", type: "command", run: ["make test-a"] }],
      },
      "test-b": {
        needs: ["build"],
        steps: [{ id: "test", type: "command", run: ["make test-b"] }],
      },
      review: {
        needs: ["test-a", "test-b"],
        steps: [
          { id: "approve", type: "human" },
          {
            id: "merge",
            type: "action",
            uses: "git/pr-merge@v1",
            onFail: { goto: "approve" },
          },
        ],
      },
    },
  }

  function dagState(over: Partial<FeatureState> = {}): FeatureState {
    const baseJobs: Record<string, JobRuntime> = {}
    for (const id of Object.keys(dagWorkflow.jobs)) {
      baseJobs[id] = job({ status: "pending" })
    }
    return { ...state({ jobs: baseJobs }), ...over }
  }

  it("starts all jobs with no needs at feature.start", () => {
    const t = interpret(dagWorkflow, dagState(), { kind: "feature.start" })
    expect(t.decisions).toContainEqual({ kind: "execute_step", jobId: "build", stepId: "compile" })
  })

  it("starts dependent jobs when their dependency succeeds", () => {
    const t = interpret(
      dagWorkflow,
      dagState({
        jobs: {
          build: job({ status: "running", currentStep: "compile" }),
          "test-a": job({ status: "pending" }),
          "test-b": job({ status: "pending" }),
          review: job({ status: "pending" }),
        },
      }),
      { kind: "step.succeeded", jobId: "build", stepId: "compile" },
    )
    expect(t.decisions).toContainEqual({ kind: "execute_step", jobId: "test-a", stepId: "test" })
    expect(t.decisions).toContainEqual({ kind: "execute_step", jobId: "test-b", stepId: "test" })
  })

  it("escalates when a step exhausts its retry budget", () => {
    const t = interpret(
      dagWorkflow,
      dagState({
        jobs: {
          build: job({ status: "running", currentStep: "compile", attempts: { compile: 1 } }),
          "test-a": job({ status: "pending" }),
          "test-b": job({ status: "pending" }),
          review: job({ status: "pending" }),
        },
      }),
      { kind: "step.failed", jobId: "build", stepId: "compile", reason: "exit 1" },
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
  })

  it("finishes when all jobs are terminal", () => {
    const t = interpret(
      dagWorkflow,
      dagState({
        jobs: {
          build: job({ status: "succeeded", currentStep: null }),
          "test-a": job({ status: "succeeded", currentStep: null }),
          "test-b": job({ status: "succeeded", currentStep: null }),
          review: job({ status: "running", currentStep: "merge" }),
        },
      }),
      { kind: "step.succeeded", jobId: "review", stepId: "merge" },
    )
    expect(t.decisions).toEqual([{ kind: "finish" }])
    expect(t.patch.status).toBe("done")
  })
})
