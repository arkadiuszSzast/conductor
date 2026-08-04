import { describe, expect, it } from "bun:test"
import { interpret } from "./src/interpret.ts"
import {
  actionStep,
  agentStep,
  backoff,
  commandStep,
  featureState,
  goto,
  humanStep,
  next,
  job as defineJob,
  jobRuntime,
  rerunSteps,
  workflow as mkWorkflow,
} from "./testing.ts"
import type { FeatureState, JobRuntime, PipelineEvent, StepDef, WorkflowDef } from "./src/types.ts"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const roles: WorkflowDef["roles"] = {
  implementer: { agent: "build", model: "prov/impl" },
  reviewer: { agent: "review", model: "prov/review" },
  fixer: { agent: "build", model: "prov/impl" },
}

const steps: StepDef[] = [
  agentStep("implement", "implementer", "implement {{feature}}"),
  commandStep("gate", ["./gradlew check"], { retry: backoff(2), onFail: goto("fix_gate") }),
  agentStep("fix_gate", "fixer", "fix the gate", { outcomes: { done: goto("gate") } }),
  agentStep("review", "reviewer", "review the diff", {
    outcomes: {
      approved: goto("approve-merge"),
      changes_requested: rerunSteps(["fix_review"], 3),
    },
  }),
  agentStep("fix_review", "fixer", "fix the review findings", { outcomes: { done: goto("review") } }),
  humanStep("approve-merge", { outcomes: { approved: next, rejected: goto("fix_review") } }),
  actionStep("merge", "git/pr-merge@v1"),
]

const workflow = mkWorkflow({ main: defineJob(steps) }, roles)

function job(over: Partial<JobRuntime> = {}): JobRuntime {
  return jobRuntime({ status: "running", ...over })
}

function state(over: Partial<FeatureState> = {}): FeatureState {
  return featureState({ main: job() }, over)
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
// step.completed (plain advance)
// ---------------------------------------------------------------------------

describe("step.completed", () => {
  it("advances to the next step in list order", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "implement" }) } }),
      evt({ kind: "step.completed", stepId: "implement" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "gate" }])
  })

  it("honours explicit then", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "fix_gate" }) } }),
      evt({ kind: "step.completed", stepId: "fix_gate" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "gate" }])
  })

  it("finishes after the last step", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "merge" }) } }),
      evt({ kind: "step.completed", stepId: "merge" }),
    )
    expect(t.decisions).toEqual([{ kind: "finish" }])
    expect(t.patch.status).toBe("done")
  })

  it("ignores stale success from a step that is no longer current", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "review" }) } }),
      evt({ kind: "step.completed", stepId: "implement" }),
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
      evt({ kind: "step.completed", stepId: "review", outcome: "approved" }),
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
    const localWorkflow = mkWorkflow(
      { main: defineJob([commandStep("flaky", ["true"], { retry: backoff(2) })]) },
      roles,
    )
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
    const localWorkflow = mkWorkflow(
      { main: defineJob([commandStep("flaky", ["true"], { retry: backoff(3) })]) },
      roles,
    )
    const t = interpret(
      localWorkflow,
      state({ jobs: { main: job({ currentStep: "flaky" }) } }),
      evt({ kind: "step.failed", stepId: "flaky", reason: "network" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "flaky" }])
    expect(t.patch.jobs?.main?.attempts).toEqual({ flaky: 1 })
  })

  it("escalates on the first failure when there is no retry and no onFail route", () => {
    const localWorkflow = mkWorkflow(
      { main: defineJob([commandStep("critical", ["true"])]) },
      roles,
    )
    const t = interpret(
      localWorkflow,
      state({ jobs: { main: job({ currentStep: "critical" }) } }),
      evt({ kind: "step.failed", stepId: "critical", reason: "boom" }),
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
  })

  it("treats maxAttempts as total executions including the first", () => {
    const localWorkflow = mkWorkflow(
      { main: defineJob([commandStep("solo", ["true"], { retry: backoff(3) })]) },
      roles,
    )
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
// step.completed outcomes (review loops)
// ---------------------------------------------------------------------------

describe("step.completed outcomes", () => {
  it("routes changes_requested to the fix step and counts the rerun round", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "review" }) } }),
      evt({ kind: "step.completed", stepId: "review", outcome: "changes_requested" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "fix_review" }])
    expect(t.patch.jobs?.main?.reruns).toEqual({ review: 1 })
  })

  it("escalates after maxRounds without approval", () => {
    const t = interpret(
      workflow,
      state({
        jobs: { main: job({ currentStep: "review", reruns: { review: 3 } }) },
      }),
      evt({ kind: "step.completed", stepId: "review", outcome: "changes_requested" }),
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
  })

  it("approved outcome proceeds past the loop to the human gate", () => {
    const t = interpret(
      workflow,
      state({
        jobs: { main: job({ currentStep: "review", reruns: { review: 2 } }) },
      }),
      evt({ kind: "step.completed", stepId: "review", outcome: "approved" }),
    )
    expect(t.decisions).toEqual([{ kind: "wait_human", jobId: "main", stepId: "approve-merge" }])
  })

  it("escalates on an unmapped outcome", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "review" }) } }),
      evt({ kind: "step.completed", stepId: "review", outcome: "wat" }),
    )
    expect(t.decisions[0]?.kind).toBe("escalate")
  })

  it("ignores a stale outcome", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "gate" }) } }),
      evt({ kind: "step.completed", stepId: "review", outcome: "approved" }),
    )
    expect(t.decisions[0]?.kind).toBe("noop")
  })
})

// ---------------------------------------------------------------------------
// Human interactions
// ---------------------------------------------------------------------------

describe("human gates", () => {
  const atGate = () => state({
    status: "waiting_human",
    jobs: {
      main: job({
        currentStep: "approve-merge",
        steps: { "approve-merge": { status: "waiting_human", output: null } },
      }),
    },
  })

  it("an approving outcome advances past the gate", () => {
    const t = interpret(
      workflow,
      atGate(),
      evt({ kind: "step.completed", stepId: "approve-merge", outcome: "approved" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "merge" }])
    expect(t.patch.jobs?.main?.steps?.["approve-merge"]?.status).toBe("succeeded")
  })

  it("is a noop when nothing awaits the gate", () => {
    const t = interpret(
      workflow,
      state({ jobs: { main: job({ currentStep: "gate" }) } }),
      evt({ kind: "step.completed", stepId: "approve-merge", outcome: "approved" }),
    )
    expect(t.decisions[0]?.kind).toBe("noop")
  })

  it("a rejecting outcome routes back to the fixer", () => {
    const t = interpret(
      workflow,
      atGate(),
      evt({ kind: "step.completed", stepId: "approve-merge", outcome: "rejected" }),
    )
    expect(t.decisions).toEqual([{ kind: "execute_step", jobId: "main", stepId: "fix_review" }])
  })

  it("carries the reviewer's note as the gate output", () => {
    const t = interpret(
      workflow,
      atGate(),
      evt({ kind: "step.completed", stepId: "approve-merge", outcome: "rejected", output: "needs tests" }),
    )
    expect(t.patch.jobs?.main?.steps?.["approve-merge"]?.output).toBe("needs tests")
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
    expect(t.patch.jobs?.main?.reruns).toEqual({ gate: 0 })
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
  const dagWorkflow = mkWorkflow(
    {
      build: defineJob([commandStep("compile", ["make"])]),
      "test-a": defineJob([commandStep("test", ["make test-a"])], ["build"]),
      "test-b": defineJob([commandStep("test", ["make test-b"])], ["build"]),
      review: defineJob(
        [
          humanStep("approve"),
          actionStep("merge", "git/pr-merge@v1", { onFail: goto("approve") }),
        ],
        ["test-a", "test-b"],
      ),
    },
    roles,
    "dag-test",
  )

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
      { kind: "step.completed", jobId: "build", stepId: "compile" },
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
      { kind: "step.completed", jobId: "review", stepId: "merge" },
    )
    expect(t.decisions).toEqual([{ kind: "finish" }])
    expect(t.patch.status).toBe("done")
  })
})
