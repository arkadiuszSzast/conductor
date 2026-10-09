import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { Engine, type EngineDeps, type EngineOptions } from "./src/engine.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner, SessionClient, OperationObservation, PrepareInput, PrepareResult, SessionCapabilities } from "./src/ports.ts"
import { RunnerOperationError } from "./src/ports.ts"
import type { ActionExecutor, ActionExecuteEffects, ActionHostExecuteResult } from "./src/action-host.ts"
import type { ResolvedActionBinding } from "./src/workflow-reservation.ts"
import { agentStep, job, workflow } from "@conductor/core/testing.ts"
import type { ActionRunContext, WorkflowDef } from "@conductor/core"
import type { RunnersConfig } from "./src/acp/config.ts"

// ---------------------------------------------------------------------------
// A minimal fake ACP-like SessionClient exercising the engine's D4/D5/D6
// integration WITHOUT any real ACP SDK/process — the engine only ever
// talks to the SessionClient port.
// ---------------------------------------------------------------------------

class FakeAcpSessions implements SessionClient {
  prepareCalls: PrepareInput[] = []
  prepareResult: PrepareResult = { ok: true, reservationId: "res-1", capabilities: { parentSessions: false, nonInferentialNotes: false, promptConfirmation: "submitted" } }
  createSessionError: Error | null = null
  promptError: Error | null = null
  prompts: Array<{ sessionID: string; text: string; operationId?: string }> = []
  observations = new Map<string, OperationObservation>()
  /** Per-session status override for reconcile-loop (2.6) tests — every
   *  session defaults to "busy" unless a test sets one explicitly. */
  statuses = new Map<string, "busy" | "idle" | "retry" | "missing" | "unknown">()
  aborted: string[] = []
  private counter = 0

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    this.prepareCalls.push(input)
    return this.prepareResult
  }

  creates: Array<{ title: string; directory: string; parentID?: string }> = []

  async createSession(input: { title: string; directory: string; parentID?: string; reservationId?: string; operationId?: string }): Promise<{ id: string }> {
    this.creates.push(input)
    if (this.createSessionError) {
      const error = this.createSessionError
      this.createSessionError = null
      throw error
    }
    return { id: `acp-ses-${++this.counter}` }
  }

  async prompt(input: { sessionID: string; text: string; operationId?: string }): Promise<void | { readonly kind: "submitted"; readonly operationId: string }> {
    if (this.promptError) {
      const error = this.promptError
      this.promptError = null
      throw error
    }
    this.prompts.push(input)
    return { kind: "submitted", operationId: input.operationId ?? "op-x" }
  }

  async sessionExists(): Promise<boolean> {
    return true
  }

  async status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing" | "unknown"> {
    return this.statuses.get(sessionID) ?? "busy"
  }

  async note(): Promise<void> {
    throw new RunnerOperationError("notes unsupported", { delivery: "not_sent" })
  }

  async abort(sessionID: string): Promise<void> {
    this.aborted.push(sessionID)
  }

  async observeOperation(operationId: string): Promise<OperationObservation> {
    return this.observations.get(operationId) ?? { status: "unknown" }
  }

  capabilities(): SessionCapabilities {
    return { parentSessions: false, nonInferentialNotes: false, promptConfirmation: "submitted" }
  }
}

class FakeGroupingSessions extends FakeAcpSessions {
  parents: Array<{ featureId: string; title: string; directory: string }> = []
  parentError: Error | null = null

  async ensureParentSession(input: { featureId: string; title: string; directory: string }): Promise<{ id: string }> {
    this.parents.push(input)
    if (this.parentError) throw this.parentError
    return { id: `root-${input.featureId}` }
  }
}

class FakeNativeSessions implements SessionClient {
  async createSession(): Promise<{ id: string }> {
    return { id: "native-ses-1" }
  }
  async prompt(): Promise<void> {}
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(): Promise<"busy" | "idle" | "retry" | "missing"> {
    return "busy"
  }
  async note(): Promise<void> {}
  async abort(): Promise<void> {}
}

class FakeProcess implements ProcessRunner {
  async exec(): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
  async shell(_command: string, _options: ProcessExecOptions): Promise<ProcessExecResult> {
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

class FakeActionHost implements ActionExecutor {
  async execute(_binding: ResolvedActionBinding, _ctx: ActionRunContext, _effects?: ActionExecuteEffects): Promise<ActionHostExecuteResult> {
    return { ok: true, outputs: {} }
  }
}

const roles: WorkflowDef["roles"] = { implementer: { agent: "build" } }

function snapshotOf(def: WorkflowDef) {
  return { projectDir: "/tmp/acp-project", workflow: def, source: "/tmp/acp-project/conductor.yaml", warnings: [], loadedAt: Date.now(), actionBindings: {} }
}

function sampleRunnersConfig(overrides: Partial<RunnersConfig> = {}): RunnersConfig {
  return {
    default: "native",
    projects: { "/tmp/acp-project": "opencode-acp" },
    acp: {
      "opencode-acp": {
        command: "/usr/bin/true",
        args: ["acp"],
        allowedRoots: ["/tmp/acp-project"],
        maxConcurrent: 2,
        permissions: { allowKinds: [] },
        bindings: { build: { mode: "build" } },
      },
    },
    reportBridge: { command: "/usr/bin/true", args: ["report-mcp"] },
    ...overrides,
  }
}

let directory: string
let connection: DatabaseConnection
let store: Store
let nativeSessions: FakeNativeSessions
let acpSessions: FakeAcpSessions
let process_: FakeProcess
let clock: FakeClock
let actions: FakeActionHost
let engines: Engine[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-engine-acp-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  clock = new FakeClock()
  store = new Store(connection.db, clock)
  nativeSessions = new FakeNativeSessions()
  acpSessions = new FakeAcpSessions()
  process_ = new FakeProcess()
  actions = new FakeActionHost()
  engines = []
})

afterEach(async () => {
  await Promise.all(engines.map(engine => engine.settleActions()))
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function makeEngine(def: WorkflowDef, overrides: Partial<EngineDeps> = {}, options: EngineOptions = {}): Engine {
  const snapshot = snapshotOf(def)
  const engine = new Engine({
    store,
    workflows: () => snapshot,
    sessions: nativeSessions,
    process: process_,
    clock,
    log: { log: () => {} },
    actions,
    runners: sampleRunnersConfig(),
    acpSessions,
    releaseAcpReservation: async () => {},
    ...overrides,
  }, options)
  engines.push(engine)
  return engine
}

async function startedFeature(engine: Engine, projectDir = "/tmp/acp-project") {
  const result = await engine.startFeature(projectDir, { title: "Ship it" })
  if (!result.ok) throw new Error(result.message)
  return result.feature
}

const singleAgentWorkflow = workflow({ main: job([agentStep("implement", "implementer", "do the work")]) }, roles)

// ---------------------------------------------------------------------------
// 2.4: preparation/target guards, immutable routing, initial prompt observation
// ---------------------------------------------------------------------------

describe("2.4: engine ACP dispatch — routing and binding", () => {
  it("dispatches through ACP prepare/createSession/prompt when the project is configured for it", async () => {
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    expect(acpSessions.prepareCalls).toHaveLength(1)
    expect(acpSessions.prepareCalls[0]?.agent).toBe("build")
    expect(acpSessions.prompts).toHaveLength(1)
    expect(nativeSessions).toBeDefined() // native never touched

    const run = store.getActiveRun(feature.id)
    expect(run).not.toBeNull()
    const binding = store.getRunnerBinding(run!.id)
    expect(binding?.transport).toBe("acp")
    expect(binding?.profileId).toBe("opencode-acp")
  })

  it("routes to native when the project is NOT in the runners.projects map", async () => {
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await engine.startFeature("/tmp/other-project", { title: "Other" })
    if (!feature.ok) throw new Error("expected ok")
    expect(acpSessions.prepareCalls).toHaveLength(0)
  })

  it("immutable routing: a config change after dispatch never reroutes an existing run", async () => {
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    const bindingBefore = store.getRunnerBinding(run.id)
    expect(bindingBefore?.transport).toBe("acp")

    // Simulate an operator disabling ACP for this project entirely —
    // dispatching a SECOND engine with different runners config must
    // never touch the EXISTING run's binding (only future dispatches
    // read current config).
    const engine2 = makeEngine(singleAgentWorkflow, { runners: undefined })
    void engine2
    const bindingAfter = store.getRunnerBinding(run.id)
    expect(bindingAfter?.transport).toBe("acp")
  })
})

describe("2.4: incompatible binding fails closed, no prompt sent", () => {
  it("routes to step.failed when directory is outside allowedRoots (acp_misconfigured)", async () => {
    const engine = makeEngine(singleAgentWorkflow, {
      runners: sampleRunnersConfig({
        acp: {
          "opencode-acp": {
            command: "/usr/bin/true", args: ["acp"], allowedRoots: ["/somewhere/else"],
            maxConcurrent: 2, permissions: { allowKinds: [] }, bindings: { build: { mode: "build" } },
          },
        },
      }),
    })
    const feature = await startedFeature(engine)
    expect(acpSessions.prompts).toHaveLength(0)
    const after = store.getFeature(feature.id)
    expect(after?.status).toBe("escalated")
  })

  it("routes to step.failed (never a fence) when prepare() reports incompatible", async () => {
    acpSessions.prepareResult = { ok: false, reason: "incompatible", diagnostic: "unsupported protocol major" }
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    expect(acpSessions.prompts).toHaveLength(0)
    const run = store.getActiveRun(feature.id)
    // No downstream run left running/uncertain — it concluded failed.
    expect(run).toBeNull()
    const runs = store.listRuns(feature.id)
    expect(runs).toHaveLength(0)
  })

  it("routes to a durable resource wait (never a fence, never step.failed) when capacity is exhausted", async () => {
    acpSessions.prepareResult = { ok: false, reason: "unavailable", diagnostic: "no free ACP process slots" }
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await engine.startFeature("/tmp/acp-project", { title: "Wait for capacity" })
    if (!feature.ok) throw new Error("expected ok")
    const waits = store.listResourceWaits(feature.feature.id)
    expect(waits.length).toBeGreaterThan(0)
    expect(waits[0]?.reason).toBe("runner_unavailable")
  })

  it("review fix: an unsupported/unadvertised ACP mode or model selection classifies invalid_config, never the retryable message-regex default", async () => {
    for (const diagnostic of ["unsupported_mode", "unsupported_model"] as const) {
      acpSessions.createSessionError = new RunnerOperationError(
        `ACP requested ${diagnostic === "unsupported_mode" ? "mode" : "model"} is not advertised`,
        { delivery: "not_sent", diagnostic, failureClass: "invalid_config" },
      )
      const engine = makeEngine(singleAgentWorkflow)
      const feature = await startedFeature(engine)
      // not_sent (never fenced) AND classified invalid_config (never
      // "internal", which the bare message-regex classifier would
      // otherwise assign — internal is a BUDGETED, retryable class,
      // but a binding/config defect can never succeed by retrying the
      // exact same unsupported selection again).
      expect(acpSessions.prompts).toHaveLength(0)
      const runs = store.listRuns(feature.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe("failed")
      expect(runs[0]?.failure?.class).toBe("invalid_config")
      // invalid_config's default budget is a SINGLE immediate attempt
      // (retry-policy.ts DEFAULT_CLASS_BEHAVIOUR) — the feature must
      // already be terminal (escalated, no workflow onFail route
      // configured), never left "running" awaiting a scheduled retry.
      expect(store.getFeature(feature.id)?.status).toBe("escalated")
      expect(store.listRetryEpisodes(feature.id)).toHaveLength(0)
    }
  })
})

describe("2.4: lost create/prompt responses fence, never retry", () => {
  it("a lost session/new response (RunnerOperationError unknown) fences the run and escalates", async () => {
    acpSessions.createSessionError = new RunnerOperationError("session/new lost", { delivery: "unknown" })
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    const runs = store.listRuns(feature.id)
    expect(runs[0]?.status).toBe("uncertain")
    const after = store.getFeature(feature.id)
    expect(after?.status).toBe("escalated")
    // No prompt was ever sent — the fence happened before that call.
    expect(acpSessions.prompts).toHaveLength(0)
  })

  it("a lost session/prompt response fences the run and escalates, notes preserved on the run row", async () => {
    acpSessions.promptError = new RunnerOperationError("prompt lost", { delivery: "unknown" })
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    const runs = store.listRuns(feature.id)
    expect(runs[0]?.status).toBe("uncertain")
    const after = store.getFeature(feature.id)
    expect(after?.status).toBe("escalated")
    expect(after?.jobs.main?.status).toBe("failed")
  })

  it("review fix: propagates the SPECIFIC lost_create_response fence reason (not the generic lost_prompt_response) via observeRunnerOperation's diagnosticCode", async () => {
    const engine = makeEngine(singleAgentWorkflow, { daemonGeneration: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    // Simulate ManagedSessions.markUnknown's own create-path diagnostic
    // code (its "session/new failed or was lost" catch) directly on the
    // durable operation journal — this fixture's FakeAcpSessions never
    // touches the store itself, matching how the existing "fences
    // restarted ACP ownership" test below constructs its operation.
    const op = store.claimOperation({ runId: run.id, kind: "create", logicalKey: run.id, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "unknown", { diagnosticCode: "create_response_lost" })
    await engine.observeRunnerOperation(op.id)
    const fence = store.getFence(run.id)
    expect(fence?.reasonCode).toBe("lost_create_response")
  })

  it("carries the operation's concrete diagnostic and operation id into the fence instead of a generic message", async () => {
    const engine = makeEngine(singleAgentWorkflow, { daemonGeneration: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    const op = store.claimOperation({ runId: run.id, kind: "create", logicalKey: run.id, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "unknown", {
      diagnosticCode: "create_response_lost",
      diagnostic: "session/new exceeded 30000ms deadline (elapsed 774750ms)",
    })
    expect(store.getOperation(op.id)?.diagnostic).toBe("session/new exceeded 30000ms deadline (elapsed 774750ms)")
    await engine.observeRunnerOperation(op.id)
    expect(store.getFence(run.id)?.operationId).toBe(op.id)
    const concluded = store.getRunById(run.id)!
    expect(concluded.reason).toContain("[create_response_lost]")
    expect(concluded.reason).toContain("elapsed 774750ms")
  })

  it("review fix: propagates the SPECIFIC turn_deadline_exceeded fence reason via observeRunnerOperation's diagnosticCode", async () => {
    const engine = makeEngine(singleAgentWorkflow, { daemonGeneration: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    const op = store.claimOperation({ runId: run.id, kind: "prompt", logicalKey: run.id, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    store.transitionOperationPhase(op.id, "submitted", "unknown", { diagnosticCode: "turn_deadline_exceeded" })
    await engine.observeRunnerOperation(op.id)
    const fence = store.getFence(run.id)
    expect(fence?.reasonCode).toBe("turn_deadline_exceeded")
  })

  it("review fix: falls back to the generic lost_prompt_response/lost_answer_response reason when no diagnosticCode was ever recorded", async () => {
    const engine = makeEngine(singleAgentWorkflow, { daemonGeneration: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    const op = store.claimOperation({ runId: run.id, kind: "prompt", logicalKey: run.id, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    store.transitionOperationPhase(op.id, "submitted", "unknown")
    await engine.observeRunnerOperation(op.id)
    const fence = store.getFence(run.id)
    expect(fence?.reasonCode).toBe("lost_prompt_response")
  })

  it("unstructured prompt failures cannot assert no-write safety", async () => {
    acpSessions.promptError = new Error("unknown boundary error")
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    const runs = store.listRuns(feature.id)
    expect(runs[0]?.status).toBe("uncertain")
  })
})

describe("uncertainty recovery barriers", () => {
  it("requires cleanup evidence and deduplicates a new attempt; late callbacks stay old", async () => {
    acpSessions.promptError = new RunnerOperationError("lost", { delivery: "unknown" })
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    const old = store.listRuns(feature.id)[0]!
    await expect(engine.resume(feature.id)).rejects.toThrow("recover")
    expect((await engine.recover(feature.id, { notes: "checked" })).ok).toBe(false)
    const request = { notes: "verified orphan cleanup", expectedVersion: store.getFeatureRecord(feature.id)!.updatedAt,
      idempotencyKey: "recover-1", acknowledgeUncertain: true }
    expect((await engine.recover(feature.id, request)).ok).toBe(false)
    expect((await engine.recover(feature.id, { ...request, cleanupAttested: true })).ok).toBe(true)
    expect((await engine.recover(feature.id, { ...request, cleanupAttested: true })).duplicate).toBe(true)
    expect(store.listRuns(feature.id)).toHaveLength(2)
    expect(store.getRunById(old.id)?.status).toBe("uncertain")
    await engine.report({ runId: old.id, outcome: "succeeded" })
    expect(store.getActiveRun(feature.id)?.id).not.toBe(old.id)
  })

  it("F2: reconcile with an unresolved fence on one job does not reset feature to running while an unrelated sibling job keeps running", async () => {
    // Two INDEPENDENT jobs (no `needs` between them) both dispatch at
    // feature.start and both successfully reach an active ACP run —
    // exactly the "DAG A unknown, B active" shape (review F2). jobA is
    // THEN fenced out-of-band (an async unknown observation arriving
    // after both dispatches already completed — e.g. a late turn-outcome
    // callback), escalating the feature while jobB's run stays active
    // and untouched.
    const twoJobWorkflow = workflow(
      {
        jobA: job([agentStep("stepA", "implementer", "do A")]),
        jobB: job([agentStep("stepB", "implementer", "do B")]),
      },
      roles,
    )
    const engine = makeEngine(twoJobWorkflow)
    const feature = await startedFeature(engine)

    const runA = store.getActiveRunForStep(feature.id, "jobA", "stepA")!
    const runB = store.getActiveRunForStep(feature.id, "jobB", "stepB")!
    expect(runA).not.toBeNull()
    expect(runB).not.toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("running")

    // Fence jobA out-of-band (the async path a lost/late turn observation
    // takes — see `Engine.observeRunnerOperation`/`fenceOrFail`), leaving
    // jobB entirely alone.
    const fenceResult = store.fenceRunnerExecution(
      { runId: runA.id, jobId: "jobA", stepId: "stepA", reasonCode: "lost_prompt_response", diagnostic: "late unknown turn observation" },
      projectDir => (projectDir === "/tmp/acp-project" ? snapshotOf(twoJobWorkflow) : undefined),
    )
    expect(fenceResult.fenced).toBe(true)
    await engine.classifyFencedRun(runA.id, true)

    const afterFence = store.getFeature(feature.id)!
    expect(afterFence.status).toBe("escalated")
    expect(afterFence.jobs.jobA?.status).toBe("failed")
    // jobB's run is completely untouched by jobA's fence.
    expect(afterFence.jobs.jobB?.status).toBe("running")
    expect(store.getRunById(runB.id)?.status).toBe("running")
    expect(store.hasUnresolvedRunnerFence(feature.id, "jobA", "stepA")).toBe(true)

    // Reconcile must NOT reset the feature to "running" out from under
    // the unresolved fence (F2) — jobA's uncertainty is not
    // acknowledged, so an implicit whole-feature reset would erase the
    // fence's operator-recovery requirement. jobB's active run is
    // reconciled normally (still running) without the feature status
    // flipping.
    await engine.reconcile()
    const reconciled = store.getFeature(feature.id)!
    expect(reconciled.status).toBe("escalated")
    expect(store.getActiveRunForStep(feature.id, "jobB", "stepB")?.id).toBe(runB.id)
    expect(store.getRunById(runB.id)?.status).toBe("running")
    expect(store.hasUnresolvedRunnerFence(feature.id, "jobA", "stepA")).toBe(true)

    // A second reconcile pass changes nothing further — no flapping.
    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getRunById(runB.id)?.status).toBe("running")

    // jobA can still be explicitly recovered on its own — F2's "recover
    // A explicitly while B continues": acknowledged recovery re-arms
    // ONLY jobA; jobB's run is never disturbed by it.
    const record = store.getFeatureRecord(feature.id)!
    const recovered = await engine.recover(feature.id, {
      notes: "verified orphan cleanup",
      expectedVersion: record.updatedAt,
      idempotencyKey: "f2-recover-1",
      acknowledgeUncertain: true,
      cleanupAttested: true,
      target: { jobId: "jobA", stepId: "stepA" },
    })
    expect(recovered.ok).toBe(true)
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getRunById(runB.id)?.status).toBe("running")
    expect(store.hasUnresolvedRunnerFence(feature.id, "jobA", "stepA")).toBe(false)
  })

  it("fences restarted ACP ownership even after a durable completed turn", async () => {
    const engine = makeEngine(singleAgentWorkflow, { daemonGeneration: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    const op = store.claimOperation({ runId: run.id, kind: "prompt", logicalKey: run.id, payloadDigest: "d", ownerGeneration: 1 })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    store.transitionOperationPhase(op.id, "submitted", "completed")
    const restarted = makeEngine(singleAgentWorkflow, { daemonGeneration: 2 })
    await restarted.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("uncertain")
    expect(acpSessions.prompts).toHaveLength(1)
  })
})

describe("2.4: concurrent reconcile dispatch claims once", () => {
  it("prepares before insertion and releases a reservation invalidated by pause", async () => {
    let finish!: (value: PrepareResult) => void
    acpSessions.prepare = async input => {
      acpSessions.prepareCalls.push(input)
      return new Promise(resolve => { finish = resolve })
    }
    const released: string[] = []
    const engine = makeEngine(singleAgentWorkflow, { releaseAcpReservation: async id => { released.push(id) } })
    const starting = startedFeature(engine)
    while (!finish) await Promise.resolve()
    const feature = store.listFeatures({ activeOnly: true })[0]!
    expect(store.listRuns(feature.id)).toHaveLength(0)
    await engine.reconcile()
    expect(acpSessions.prepareCalls).toHaveLength(1)
    await engine.pause(feature.id)
    finish(acpSessions.prepareResult)
    await starting
    expect(released).toEqual(["res-1"])
    expect(store.listRuns(feature.id)).toHaveLength(0)
    expect(acpSessions.prompts).toHaveLength(0)
  })
  it("F1: a reconcile pass racing a blocked prepare() keeps the feature running (not escalated), then completes to exactly one run/binding/prompt", async () => {
    let finish!: (value: PrepareResult) => void
    acpSessions.prepare = async input => {
      acpSessions.prepareCalls.push(input)
      return new Promise(resolve => { finish = resolve })
    }
    const engine = makeEngine(singleAgentWorkflow)
    const starting = startedFeature(engine)
    while (!finish) await Promise.resolve()
    const feature = store.listFeatures({ activeOnly: true })[0]!
    // No durable run/resource_wait row exists yet — prepare() is still
    // in flight. Without the "preparing_target" anchor a reconcile pass
    // here would see NO anchor at all and wrongly mark the feature
    // escalated (F1), erasing the in-flight preparation's ability to
    // ever complete productively.
    expect(store.listRuns(feature.id)).toHaveLength(0)
    expect(store.listResourceWaits(feature.id)).toHaveLength(0)
    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("running")
    // A second reconcile pass while still blocked must also not escalate
    // and must not attempt a duplicate prepare() call.
    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(acpSessions.prepareCalls).toHaveLength(1)

    finish(acpSessions.prepareResult)
    await starting
    expect(store.listRuns(feature.id)).toHaveLength(1)
    const run = store.getActiveRun(feature.id)!
    expect(store.getRunnerBinding(run.id)?.transport).toBe("acp")
    expect(acpSessions.prompts).toHaveLength(1)
  })

  it("a step already actively running is never re-dispatched through ACP a second time", async () => {
    const engine = makeEngine(singleAgentWorkflow)
    const feature = await startedFeature(engine)
    expect(acpSessions.prepareCalls).toHaveLength(1)
    // Simulate a concurrent reconcile pass attempting the same step —
    // actDecision's existing active-run guard must reject the duplicate
    // BEFORE it ever reaches prepare()/executeAgent.
    await engine.reconcile()
    expect(acpSessions.prepareCalls).toHaveLength(1)
    void feature
  })
})

describe("2.4: acpSessions not wired is a config error, never a fence", () => {
  it("fails closed with step.failed (invalid_config) when runners is configured but acpSessions is undefined", async () => {
    const engine = makeEngine(singleAgentWorkflow, { acpSessions: undefined })
    const feature = await startedFeature(engine)
    const runs = store.listRuns(feature.id)
    expect(runs).toHaveLength(0)
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("self-healing: safe fences heal with backoff", () => {
  const reviewWorkflow = workflow({ main: job([agentStep("review", "implementer", "review it", { replaySafe: true })]) }, roles)
  const implementWorkflow = workflow({ main: job([agentStep("implement", "implementer", "build it")]) }, roles)
  const fixedRandom = { next: () => 0.999999 }

  function healingEngine(def: WorkflowDef, cleanup: "confirmed_terminated" | "unconfirmed" = "confirmed_terminated") {
    return makeEngine(def, { cleanupAcpRun: async () => cleanup }, { random: fixedRandom, healing: { attentionAfter: 3 } })
  }

  it("a lost session/new with confirmed cleanup is no_effect: no escalation, healed after ~1 minute", async () => {
    acpSessions.createSessionError = new RunnerOperationError("session/new exceeded 30000ms deadline", { delivery: "unknown" })
    const engine = healingEngine(implementWorkflow)
    const feature = await startedFeature(engine)
    await engine.drainRunnerCleanup()
    const [fenced] = store.listRuns(feature.id)
    expect(fenced?.status).toBe("uncertain")
    expect(store.getFence(fenced!.id)?.classification).toBe("no_effect")
    expect(store.getFeature(feature.id)?.status).toBe("running")
    const episode = store.getOpenHealingEpisode(feature.id, "main", "implement")!
    expect(episode.consecutiveFailures).toBe(1)
    expect(Math.round(episode.delayMs / 1000)).toBe(60)

    await engine.reconcile()
    expect(store.listRuns(feature.id)).toHaveLength(1)

    clock.advance(60_000)
    await engine.reconcile()
    const runs = store.listRuns(feature.id)
    expect(runs).toHaveLength(2)
    expect(runs.find(run => run.id !== fenced!.id)?.status).toBe("running")
    expect(store.getFence(fenced!.id)?.resolvedAt).not.toBeNull()
    expect(store.getTransitions(feature.id, 5).some(entry => (entry.event as { kind: string }).kind === "system.healed")).toBe(true)
    expect(acpSessions.prompts).toHaveLength(1)
  })

  it("a lost prompt on a non-replay-safe step with confirmed cleanup is unsafe and escalates", async () => {
    acpSessions.promptError = new RunnerOperationError("prompt lost", { delivery: "unknown" })
    const engine = healingEngine(implementWorkflow)
    const feature = await startedFeature(engine)
    await engine.drainRunnerCleanup()
    expect(store.getFence(store.listRuns(feature.id)[0]!.id)?.classification).toBe("unsafe")
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getOpenHealingEpisode(feature.id, "main", "implement")).toBeNull()
  })

  it("a lost prompt on a replaySafe step heals; unconfirmed cleanup never does", async () => {
    acpSessions.promptError = new RunnerOperationError("prompt lost", { delivery: "unknown" })
    const engine = healingEngine(reviewWorkflow)
    const feature = await startedFeature(engine)
    await engine.drainRunnerCleanup()
    expect(store.getFence(store.listRuns(feature.id)[0]!.id)?.classification).toBe("replay_safe")
    expect(store.getFeature(feature.id)?.status).toBe("running")
  })

  it("unconfirmed cleanup is unsafe even for a replaySafe step", async () => {
    acpSessions.promptError = new RunnerOperationError("prompt lost", { delivery: "unknown" })
    const engine = healingEngine(reviewWorkflow, "unconfirmed")
    const feature = await startedFeature(engine)
    await engine.drainRunnerCleanup()
    expect(store.getFence(store.listRuns(feature.id)[0]!.id)?.classification).toBe("unsafe")
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })

  it("backs off exponentially, enters attention at the third failure, keeps healing, and clears on success", async () => {
    const engine = healingEngine(reviewWorkflow)
    acpSessions.createSessionError = new RunnerOperationError("session/new lost", { delivery: "unknown" })
    const feature = await startedFeature(engine)
    await engine.drainRunnerCleanup()
    const delays: number[] = []
    for (let failure = 1; failure <= 4; failure++) {
      const episode = store.getOpenHealingEpisode(feature.id, "main", "review")!
      expect(episode.consecutiveFailures).toBe(failure)
      delays.push(Math.round(episode.delayMs / 1000))
      expect(store.listAttention(feature.id).length > 0).toBe(failure >= 3)
      acpSessions.createSessionError = new RunnerOperationError("session/new lost", { delivery: "unknown" })
      clock.advance(episode.delayMs)
      await engine.reconcile()
      await engine.drainRunnerCleanup()
    }
    expect(delays).toEqual([60, 120, 240, 480])
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.listAttention(feature.id)[0]?.consecutiveFailures).toBe(5)

    const episode = store.getOpenHealingEpisode(feature.id, "main", "review")!
    clock.advance(episode.delayMs)
    await engine.reconcile()
    const live = store.getActiveRunForStep(feature.id, "main", "review")!
    expect(live).not.toBeNull()
    await engine.report({ runId: live.id, outcome: "succeeded", notes: "ok" })
    expect(store.listAttention(feature.id)).toHaveLength(0)
    expect(store.getFeature(feature.id)?.status).toBe("done")
  })

  it("pause suspends healing; resume continues it", async () => {
    acpSessions.createSessionError = new RunnerOperationError("session/new lost", { delivery: "unknown" })
    const engine = healingEngine(reviewWorkflow)
    const feature = await startedFeature(engine)
    await engine.drainRunnerCleanup()
    await engine.pause(feature.id)
    clock.advance(10 * 60_000)
    await engine.reconcile()
    expect(store.listRuns(feature.id)).toHaveLength(1)
    await engine.resume(feature.id)
    await engine.reconcile()
    expect(store.listRuns(feature.id)).toHaveLength(2)
  })

  it("abandon closes pending healing", async () => {
    acpSessions.createSessionError = new RunnerOperationError("session/new lost", { delivery: "unknown" })
    const engine = healingEngine(reviewWorkflow)
    const feature = await startedFeature(engine)
    await engine.drainRunnerCleanup()
    await engine.abandon(feature.id)
    expect(store.getOpenHealingEpisode(feature.id, "main", "review")).toBeNull()
    clock.advance(10 * 60_000)
    await engine.reconcile()
    expect(store.listRuns(feature.id)).toHaveLength(1)
  })

  it("an unclassified fence after a restart is classified unsafe once the bound expires", async () => {
    const engine = makeEngine(reviewWorkflow, { cleanupAcpRun: async () => "unconfirmed" }, { fenceClassifyTimeoutMs: 1000 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    store.fenceRunnerExecution({ runId: run.id, jobId: "main", stepId: "review", reasonCode: "startup_recovery", diagnostic: "restart" },
      () => snapshotOf(reviewWorkflow))
    await engine.reconcile()
    expect(store.getFence(run.id)?.classification).toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("running")
    clock.advance(1000)
    await engine.reconcile()
    expect(store.getFence(run.id)?.classification).toBe("unsafe")
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("opencode transport routing", () => {
  const opencodeRunners = (): RunnersConfig => ({
    default: "native",
    projects: { "/tmp/acp-project": "v2" },
    acp: {},
    opencode: { v2: { baseUrl: "http://fake", passwordEnv: "PW", allowedRoots: ["/tmp/acp-project"], maxConcurrent: 2, bindings: { build: { model: "omni/claude/x", variant: "medium" } } } },
  })

  it("prepares with the binding selection, binds the opencode transport and prompts with a keyed operation", async () => {
    const opencode = new FakeAcpSessions()
    const engine = makeEngine(singleAgentWorkflow, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {} })
    const feature = await startedFeature(engine)
    expect(acpSessions.prepareCalls).toHaveLength(0)
    expect(opencode.prepareCalls[0]).toMatchObject({ agent: "build", model: "omni/claude/x", variant: "medium" })
    expect(opencode.prompts[0]?.operationId).toBeDefined()
    const binding = store.getRunnerBinding(store.getActiveRun(feature.id)!.id)
    expect(binding).toMatchObject({ transport: "opencode", profileId: "v2" })
  })

  it("lets the workflow role override the binding variant", async () => {
    const opencode = new FakeAcpSessions()
    const wf = workflow({ main: job([agentStep("implement", "implementer", "do the work")]) }, { implementer: { agent: "build", variant: "low" } })
    const engine = makeEngine(wf, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {} })
    await startedFeature(engine)
    expect(opencode.prepareCalls[0]).toMatchObject({ model: "omni/claude/x", variant: "low" })
  })

  it("fences a lost create response instead of retrying", async () => {
    const opencode = new FakeAcpSessions()
    opencode.createSessionError = new RunnerOperationError("lost", { delivery: "unknown" })
    const engine = makeEngine(singleAgentWorkflow, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {} })
    const feature = await startedFeature(engine)
    const runs = store.listRuns(feature.id)
    expect(opencode.prompts).toHaveLength(0)
    expect(store.getRunnerBinding(runs[0]!.id)?.phase).toBe("fenced")
  })

  it("lets a reported session finish its turn instead of interrupting it", async () => {
    const opencode = new FakeAcpSessions()
    const engine = makeEngine(singleAgentWorkflow, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {}, sleep: async () => {} })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    opencode.statuses.set(run.sessionId!, "idle")
    await engine.report({ runId: run.id, outcome: "succeeded" })
    await engine.drainRunnerCleanup()
    expect(opencode.aborted).toHaveLength(0)
  })

  it("interrupts a reported session that is still busy after the settle window", async () => {
    const opencode = new FakeAcpSessions()
    const engine = makeEngine(singleAgentWorkflow, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {}, sleep: async () => {} }, { reportSettleMs: 3000 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    await engine.drainRunnerCleanup()
    expect(opencode.aborted).toEqual([run.sessionId!])
  })

  it("opens the session in the step's rendered cwd", async () => {
    const opencode = new FakeAcpSessions()
    const wf = workflow({ main: job([agentStep("implement", "implementer", "do the work", { cwd: "/tmp/acp-project/wt/{{ feature.slug }}" })]) }, roles)
    const engine = makeEngine(wf, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {} })
    const feature = await startedFeature(engine)
    expect(opencode.prepareCalls[0]?.directory).toBe(`/tmp/acp-project/wt/${feature.slug}`)
    expect(store.getRunnerBinding(store.getActiveRun(feature.id)!.id)?.directory).toBe(`/tmp/acp-project/wt/${feature.slug}`)
  })

  it("groups the step session under the feature's root session", async () => {
    const opencode = new FakeGroupingSessions()
    const wf = workflow({ main: job([agentStep("implement", "implementer", "do the work", { cwd: "/tmp/acp-project/wt/{{ feature.slug }}" })]) }, roles)
    const engine = makeEngine(wf, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {} })
    const feature = await startedFeature(engine)
    expect(opencode.parents[0]).toMatchObject({ featureId: feature.id, directory: "/tmp/acp-project" })
    expect(opencode.creates[0]).toMatchObject({ parentID: `root-${feature.id}`, directory: `/tmp/acp-project/wt/${feature.slug}` })
    expect(store.getFeature(feature.id)?.sessionId).toBe(`root-${feature.id}`)
    expect(opencode.prompts).toHaveLength(1)
  })

  it("falls back to an ungrouped session when the root session cannot be ensured", async () => {
    const opencode = new FakeGroupingSessions()
    opencode.parentError = new RunnerOperationError("down", { delivery: "not_sent" })
    const engine = makeEngine(singleAgentWorkflow, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {} })
    await startedFeature(engine)
    expect(opencode.creates[0]?.parentID).toBeUndefined()
    expect(opencode.prompts).toHaveLength(1)
  })

  it("fails the step when the rendered cwd is not absolute", async () => {
    const opencode = new FakeAcpSessions()
    const wf = workflow({ main: job([agentStep("implement", "implementer", "do the work", { cwd: "relative/dir" })]) }, roles)
    const engine = makeEngine(wf, { runners: opencodeRunners(), opencodeSessions: opencode, releaseOpencodeReservation: async () => {} })
    const feature = await startedFeature(engine)
    expect(opencode.prepareCalls).toHaveLength(0)
    expect(store.getActiveRun(feature.id)).toBeNull()
  })

  it("fails the step when the opencode client is not wired", async () => {
    const engine = makeEngine(singleAgentWorkflow, { runners: opencodeRunners() })
    const feature = await startedFeature(engine)
    expect(store.getActiveRun(feature.id)).toBeNull()
  })
})
