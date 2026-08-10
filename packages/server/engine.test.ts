import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { Engine, type EngineDeps, type EngineOptions } from "./src/engine.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner, SessionClient } from "./src/ports.ts"
import type { WorkflowSnapshot } from "./src/workflow-registry.ts"
import {
  agentStep,
  commandStep,
  humanStep,
  job,
  next,
  rerunSteps,
  backoff,
  workflow,
} from "@conductor/core/testing.ts"
import type { WorkflowDef } from "@conductor/core"

// ---------------------------------------------------------------- fakes

class FakeSessions implements SessionClient {
  prompts: Array<{ sessionID: string; text: string; agent?: string; model?: string }> = []
  created: string[] = []
  parents = new Map<string, string>()
  liveSessions = new Set<string>()
  statuses = new Map<string, "busy" | "idle" | "retry">()
  notes: Array<{ sessionID: string; text: string }> = []
  private counter = 0
  nextCreatePause: Promise<void> | null = null
  onCreatePause?: () => void

  async createSession(input: { title: string; directory: string; parentID?: string }): Promise<{ id: string }> {
    if (this.nextCreatePause) {
      const pause = this.nextCreatePause
      this.nextCreatePause = null
      this.onCreatePause?.()
      await pause
    }
    const id = `ses-${++this.counter}`
    this.created.push(id)
    this.liveSessions.add(id)
    if (input.parentID !== undefined) this.parents.set(id, input.parentID)
    return { id }
  }
  async prompt(input: { sessionID: string; text: string; agent?: string; model?: string }): Promise<void> {
    this.prompts.push(input)
  }
  async note(input: { sessionID: string; text: string }): Promise<void> {
    this.notes.push(input)
  }
  async sessionExists(sessionID: string): Promise<boolean> {
    return this.liveSessions.has(sessionID)
  }
  async status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing"> {
    if (!this.liveSessions.has(sessionID)) return "missing"
    return this.statuses.get(sessionID) ?? "busy"
  }
}

class FakeProcess implements ProcessRunner {
  handler: ((command: string, options: ProcessExecOptions) => ProcessExecResult) | null = null
  async exec(): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
  async shell(command: string, options: ProcessExecOptions): Promise<ProcessExecResult> {
    if (this.handler) return this.handler(command, options)
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
}

class FakeClock {
  current = Date.now()
  now(): number {
    return this.current
  }
  advance(ms: number): void {
    this.current += ms
  }
}

// ---------------------------------------------------------- test workflows

const roles: WorkflowDef["roles"] = {
  implementer: { agent: "build", model: "prov/impl" },
  reviewer: { agent: "review", model: "prov/review" },
  fixer: { agent: "build", model: "prov/impl" },
}

/** implement (agent) → verify (command) → gate (human: approved→next, rejected→rerun implement) */
const linearWorkflow: WorkflowDef = workflow(
  {
    main: job([
      agentStep("implement", "implementer", "Implement {{ inputs.feature }}."),
      commandStep("verify", ["bun test"]),
      humanStep("gate", { outcomes: { approved: next, rejected: rerunSteps(["implement"], 3) } }),
    ]),
  },
  roles,
  "linear",
)

/** review (agent, outcomes: approved→next, changes_requested→rerun[implement,review] maxRounds 2) */
const reviewLoopWorkflow: WorkflowDef = workflow(
  {
    main: job([
      agentStep("implement", "implementer", "Implement {{ inputs.feature }}.\nFeedback: {{ feedback.jobs[\"main\"][\"review\"][\"report\"] }}"),
      agentStep("review", "reviewer", "Review it.", {
        outcomes: { approved: next, changes_requested: rerunSteps(["implement", "review"], 2) },
      }),
    ]),
  },
  roles,
  "review-loop",
)

/** onFail retry: implement has retry budget of 2, onFail goes nowhere (job fails → escalates, single job workflow) */
const retryWorkflow: WorkflowDef = workflow(
  {
    main: job([agentStep("implement", "implementer", "go", { retry: backoff(2, 10) })]),
  },
  roles,
  "retry",
)

/** unmapped outcome escalates */
const unmappedOutcomeWorkflow: WorkflowDef = workflow(
  {
    main: job([agentStep("review", "reviewer", "review", { outcomes: { approved: next } })]),
  },
  roles,
  "unmapped",
)

/** two parallel jobs fan into a third */
const fanInWorkflow: WorkflowDef = workflow(
  {
    a: job([agentStep("work", "implementer", "work a")], [], undefined, { result: "{{ steps.work.outputs.report }}" }),
    b: job([agentStep("work", "implementer", "work b")], [], undefined, { result: "{{ steps.work.outputs.report }}" }),
    join: job([agentStep("combine", "reviewer", "combine {{ needs[\"a\"].outputs.result }} {{ needs[\"b\"].outputs.result }}")], ["a", "b"]),
  },
  roles,
  "fan-in",
)

function snapshotOf(def: WorkflowDef): WorkflowSnapshot {
  return {
    projectDir: "/tmp/project",
    workflow: def,
    source: "/tmp/project/conductor.yaml",
    warnings: [],
    loadedAt: Date.now(),
    actionBindings: {},
  }
}

let directory: string
let connection: DatabaseConnection
let store: Store
let sessions: FakeSessions
let process_: FakeProcess
let clock: FakeClock

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-engine-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
  sessions = new FakeSessions()
  process_ = new FakeProcess()
  clock = new FakeClock()
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function makeEngine(def: WorkflowDef, options: EngineOptions = {}, overrides: Partial<EngineDeps> = {}): Engine {
  const snapshot = snapshotOf(def)
  return new Engine(
    {
      store,
      workflows: () => snapshot,
      sessions,
      process: process_,
      clock,
      log: { log: () => {} },
      ...overrides,
    },
    options,
  )
}

async function startedFeature(engine: Engine, projectDir = "/tmp/project") {
  const result = await engine.startFeature(projectDir, { title: "Ship it" })
  if (!result.ok) throw new Error(result.message)
  return result.feature
}

// ---------------------------------------------------------------------------

describe("Engine: linear happy path", () => {
  it("agent → command → human gate → approve → done", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
    expect(sessions.prompts).toHaveLength(1)

    const implementRun = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: implementRun.id, outcome: "succeeded", notes: "implemented" })
    // the command step ran synchronously within report()'s dispatch, so
    // the feature has already advanced past "verify" to the human gate.
    expect(store.listRuns(feature.id).some(r => r.stepId === "verify" && r.status === "succeeded")).toBe(true)
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("gate")
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")

    const result = await engine.approve(feature.id, "ship it")
    expect(result).toContain("Approved")
    const after = store.getFeature(feature.id)!
    expect(after.status).toBe("done")
    expect(after.jobs["main"]?.steps["gate"]?.outputs).toEqual({ notes: "ship it" })
  })

  it("command step failure fails the job and escalates (single job, no onFail)", async () => {
    process_.handler = () => ({ code: 1, stdout: "", stderr: "boom", output: "boom" })
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    const after = store.getFeature(feature.id)!
    expect(after.status).toBe("escalated")
    expect(after.jobs["main"]?.steps["verify"]?.status).toBe("failed")
  })

  it("command step publishes $CONDUCTOR_OUTPUT name=value lines as outputs", async () => {
    process_.handler = (_command, options) => {
      const fs = require("node:fs") as typeof import("node:fs")
      fs.writeFileSync(options.env!["CONDUCTOR_OUTPUT"]!, "branch=feature-x\npath=/work\n")
      return { code: 0, stdout: "", stderr: "", output: "" }
    }
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    const verifyRun = store.listRuns(feature.id).find(r => r.stepId === "verify")!
    expect(verifyRun.outputs).toEqual({ branch: "feature-x", path: "/work" })
  })
})

describe("Engine: outcome routing", () => {
  it("a verdict routes through the outcomes map", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "impl v1" })
    run = store.getActiveRunForStep(feature.id, "main", "review")!
    const result = await engine.report({ runId: run.id, verdict: "approved", notes: "lgtm" })
    expect(result).toContain('Verdict "approved"')
    expect(store.getFeature(feature.id)?.status).toBe("done")
  })

  it("an unmapped outcome escalates", async () => {
    const engine = makeEngine(unmappedOutcomeWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "review")!
    await engine.report({ runId: run.id, verdict: "rejected" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("Engine: retry budget", () => {
  it("onFail retry budget exhausted escalates the feature", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 1 failed" })
    // retry: attempt 2 dispatched automatically
    expect(store.getFeature(feature.id)?.status).toBe("running")
    run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 2 failed" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("Engine: rerun loop with feedback", () => {
  it("a rerun scope=steps loop surfaces feedback in the round-2 prompt", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "impl v1" })
    run = store.getActiveRunForStep(feature.id, "main", "review")!
    await engine.report({ runId: run.id, verdict: "changes_requested", notes: "needs tests" })

    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
    expect(store.getFeature(feature.id)?.jobs["main"]?.reruns["review"]).toBe(1)
    const round2Prompt = sessions.prompts.at(-1)!
    expect(round2Prompt.text).toContain("needs tests")
  })

  it("exhausting maxRounds escalates", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    // rerunSteps(["implement","review"], 2): round 1 and 2 loop back;
    // round 3 exceeds maxRounds and escalates.
    for (let round = 0; round < 3; round++) {
      let run = store.getActiveRunForStep(feature.id, "main", "implement")!
      await engine.report({ runId: run.id, outcome: "succeeded", notes: `impl v${round + 1}` })
      run = store.getActiveRunForStep(feature.id, "main", "review")!
      await engine.report({ runId: run.id, verdict: "changes_requested", notes: "again" })
    }
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("Engine: human reject re-runs", () => {
  it("request-changes reruns the mapped steps with notes as feedback", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    run = store.getActiveRunForStep(feature.id, "main", "verify")
      ?? store.getActiveRunForStep(feature.id, "main", "implement")!
    // verify runs synchronously (command), so feature should now be at gate
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")

    const result = await engine.requestChanges(feature.id, "please add tests")
    expect(result).toContain("Changes requested")
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
    expect(store.getFeature(feature.id)?.status).toBe("running")
  })
})

describe("Engine: nudge/reap", () => {
  it("idle debounce then nudge, then reap on exhausted nudges", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "idle")

    await engine.reconcile()
    expect(sessions.prompts.length).toBe(2) // initial dispatch + nudge
    expect(store.getRunById(run.id)?.status).toBe("running")

    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    // "implement" has no retry policy (default: one attempt) and no
    // onFail route, so the reap's step.failed fails the job outright —
    // the feature escalates rather than retrying.
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })

  it("a missing session is reaped immediately, no nudge", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 5, maxNudges: 5 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.liveSessions.delete(run.sessionId!)

    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(sessions.prompts.length).toBe(1) // only the original dispatch, no nudge
  })

  it("runTtlMs exceeded reaps regardless of session status", async () => {
    const engine = makeEngine(linearWorkflow, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")
    clock.advance(2000)

    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
  })

  it("busy and retry sessions are never nudged", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")
    await engine.reconcile()
    await engine.reconcile()
    sessions.statuses.set(run.sessionId!, "retry")
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("running")
    expect(sessions.prompts.length).toBe(1)
  })
})

describe("Engine: duplicate report", () => {
  it("a second report on the same run is rejected idempotently", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    const first = await engine.report({ runId: run.id, outcome: "succeeded" })
    expect(first).not.toContain("already concluded")
    const second = await engine.report({ runId: run.id, outcome: "failed" })
    expect(second).toContain(`Run ${run.id} already concluded`)
  })
})

describe("Engine: multi-job fan-out/fan-in", () => {
  it("feature.start dispatches both independent jobs; completion of both dispatches the join", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    expect(sessions.prompts.length).toBe(2)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "succeeded", notes: "A" })
    expect(store.getActiveRunForStep(feature.id, "join", "combine")).toBeNull()
    await engine.report({ runId: runB.id, outcome: "succeeded", notes: "B" })
    const joinRun = store.getActiveRunForStep(feature.id, "join", "combine")
    expect(joinRun).not.toBeNull()
    expect(sessions.prompts.at(-1)!.text).toContain("A")
    expect(sessions.prompts.at(-1)!.text).toContain("B")
  })
})

describe("Engine: pause/resume/abandon", () => {
  it("pause then resume returns to running at the same step", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    await engine.pause(feature.id)
    expect(store.getFeature(feature.id)?.status).toBe("paused")
    await engine.resume(feature.id)
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
  })

  it("abandon terminates the feature", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    await engine.abandon(feature.id)
    expect(store.getFeature(feature.id)?.status).toBe("abandoned")
  })
})

describe("Engine: per-feature error isolation", () => {
  it("one feature's reconcile error never blocks another feature's reconciliation", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const featureA = await startedFeature(engine)
    const featureB = await startedFeature(engine)
    const runA = store.getActiveRunForStep(featureA.id, "main", "implement")!
    const runB = store.getActiveRunForStep(featureB.id, "main", "implement")!

    let calls = 0
    const originalStatus = sessions.status.bind(sessions)
    sessions.status = async (sessionID: string) => {
      calls += 1
      if (sessionID === runA.sessionId) throw new Error("boom")
      return originalStatus(sessionID)
    }
    sessions.statuses.set(runB.sessionId!, "idle")

    await engine.reconcile()
    expect(calls).toBeGreaterThan(0)
    // feature B's run still got its nudge despite A's blowup
    expect(store.getRunById(runB.id)?.status).toBe("running")
    expect(store.getRunById(runA.id)?.status).toBe("running")
  })
})

describe("Engine: restart recovery", () => {
  it("a new engine constructed on the same store resumes a feature mid-flight", async () => {
    const engine1 = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine1)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    const engine2 = makeEngine(linearWorkflow)
    // no run for a fresh engine instance but the same DB: reconcile should
    // see the existing active run and not double-dispatch.
    await engine2.reconcile()
    expect(store.listRuns(feature.id).filter(r => r.stepId === "implement")).toHaveLength(1)

    await engine2.report({ runId: run.id, outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("gate")
  })

  it("recovers a pending decision that was never dispatched before a crash", async () => {
    const engine1 = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine1)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    // Conclude the run directly through the store (simulating concludeRun
    // committing but the process crashing before dispatchDecisions ran).
    const { interpret } = await import("@conductor/core")
    const state = store.getFeature(feature.id)!
    const event = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done", outputs: { report: "x" } } as const
    const transition = interpret(linearWorkflow, state, event)
    store.concludeRun(run.id, "succeeded", { outputs: { report: "x" } }, event, transition)
    expect(store.getPendingRunAction(feature.id)).not.toBeNull()

    const engine2 = makeEngine(linearWorkflow)
    await engine2.reconcile()
    expect(store.getPendingRunAction(feature.id)).toBeNull()
    // the recovered decision (execute verify, a command step) ran synchronously
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("gate")
  })
})

describe("Engine: startFeature", () => {
  it("returns project_not_configured when no workflow is registered", async () => {
    const engine = new Engine({
      store,
      workflows: () => null,
      sessions,
      process: process_,
      clock,
      log: { log: () => {} },
    })
    const result = await engine.startFeature("/tmp/nowhere", { title: "T" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("project_not_configured")
  })

  it("returns unknown_workflow when the requested workflow name does not match", async () => {
    const engine = makeEngine(linearWorkflow)
    const result = await engine.startFeature("/tmp/project", { title: "T", workflow: "nope" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("unknown_workflow")
  })
})
