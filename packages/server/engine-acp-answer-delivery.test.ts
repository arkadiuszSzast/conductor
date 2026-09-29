import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { Engine, type EngineDeps } from "./src/engine.ts"
import type { ProcessExecResult, ProcessRunner, SessionClient, OperationObservation, PrepareInput, PrepareResult, SessionCapabilities } from "./src/ports.ts"
import { RunnerOperationError } from "./src/ports.ts"
import type { ActionExecutor, ActionExecuteEffects, ActionHostExecuteResult } from "./src/action-host.ts"
import type { ResolvedActionBinding } from "./src/workflow-reservation.ts"
import { agentStep, job, workflow } from "@conductor/core/testing.ts"
import type { ActionRunContext, WorkflowDef } from "@conductor/core"
import type { RunnersConfig } from "./src/acp/config.ts"

class FakeAcpSessions implements SessionClient {
  prepareResult: PrepareResult = { ok: true, reservationId: "res-1", capabilities: { parentSessions: false, nonInferentialNotes: false, promptConfirmation: "submitted" } }
  prompts: Array<{ sessionID: string; text: string; operationId?: string; purpose?: string }> = []
  promptError: Error | null = null
  promptResolvesVoid = false
  statuses = new Map<string, "busy" | "idle" | "retry" | "missing" | "unknown">()
  aborted: string[] = []
  private counter = 0

  async prepare(_input: PrepareInput): Promise<PrepareResult> {
    return this.prepareResult
  }
  async createSession(): Promise<{ id: string }> {
    return { id: `acp-ses-${++this.counter}` }
  }
  async prompt(input: { sessionID: string; text: string; operationId?: string; purpose?: string }): Promise<void | { readonly kind: "submitted"; readonly operationId: string }> {
    if (this.promptError) {
      const error = this.promptError
      this.promptError = null
      throw error
    }
    this.prompts.push(input)
    if (this.promptResolvesVoid) return undefined
    return { kind: "submitted", operationId: input.operationId ?? "op-answer" }
  }
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing" | "unknown"> {
    return this.statuses.get(sessionID) ?? "idle"
  }
  async note(): Promise<void> {
    throw new RunnerOperationError("notes unsupported", { delivery: "not_sent" })
  }
  async abort(sessionID: string): Promise<void> {
    this.aborted.push(sessionID)
  }
  async observeOperation(_operationId: string): Promise<OperationObservation> {
    return { status: "unknown" }
  }
  capabilities(): SessionCapabilities {
    return { parentSessions: false, nonInferentialNotes: false, promptConfirmation: "submitted" }
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
  async shell(): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
}

class FakeClock {
  current = Date.now()
  now(): number {
    return this.current
  }
}

class FakeActionHost implements ActionExecutor {
  async execute(_binding: ResolvedActionBinding, _ctx: ActionRunContext, _effects?: ActionExecuteEffects): Promise<ActionHostExecuteResult> {
    return { ok: true, outputs: {} }
  }
}

const roles: WorkflowDef["roles"] = { implementer: { agent: "build" } }

function snapshotOf(def: WorkflowDef) {
  return { projectDir: "/tmp/acp-answer-project", workflow: def, source: "/tmp/acp-answer-project/conductor.yaml", warnings: [], loadedAt: Date.now(), actionBindings: {} }
}

function sampleRunnersConfig(): RunnersConfig {
  return {
    default: "native",
    projects: { "/tmp/acp-answer-project": "opencode-acp" },
    acp: {
      "opencode-acp": {
        command: "/usr/bin/true", args: ["acp"], allowedRoots: ["/tmp/acp-answer-project"],
        maxConcurrent: 2, permissions: { allowKinds: [] }, bindings: { build: { mode: "build" } },
      },
    },
    reportBridge: { command: "/usr/bin/true", args: ["report-mcp"] },
  }
}

let directory: string
let connection: DatabaseConnection
let store: Store
let nativeSessions: FakeNativeSessions
let acpSessions: FakeAcpSessions
let clock: FakeClock
let engines: Engine[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-engine-acp-answer-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  clock = new FakeClock()
  store = new Store(connection.db, clock)
  nativeSessions = new FakeNativeSessions()
  acpSessions = new FakeAcpSessions()
  engines = []
})

afterEach(async () => {
  await Promise.all(engines.map(engine => engine.settleActions()))
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function makeEngine(def: WorkflowDef, overrides: Partial<EngineDeps> = {}): Engine {
  const snapshot = snapshotOf(def)
  const engine = new Engine({
    store, workflows: () => snapshot, sessions: nativeSessions, process: new FakeProcess(), clock,
    log: { log: () => {} }, actions: new FakeActionHost(), runners: sampleRunnersConfig(), acpSessions,
    releaseAcpReservation: async () => {},
    ...overrides,
  })
  engines.push(engine)
  return engine
}

const interactiveWorkflow = workflow({ main: job([agentStep("implement", "implementer", "do the work", { interactive: true })]) }, roles)

async function dispatchedAcpFeature(engine: Engine) {
  const result = await engine.startFeature("/tmp/acp-answer-project", { title: "Ship it" })
  if (!result.ok) throw new Error(result.message)
  return result.feature
}

// ---------------------------------------------------------------------------
// 2.5: answer delivery journal, submitted disposition, fencing
// ---------------------------------------------------------------------------

describe("ACP completion and question generations", () => {
  it("waits for the previous turn and confirms only a matching durable completion", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "question N" })
    acpSessions.statuses.set(run.sessionId!, "busy")
    await engine.answer(run.id, "retained answer")
    const delivery = store.getOpenAnswerDelivery(run.id)!
    expect(delivery.status).toBe("pending")
    expect(acpSessions.prompts.filter(p => p.purpose === "answer")).toHaveLength(0)
    const binding = store.getRunnerBinding(run.id)!
    store.claimAnswerDelivery(delivery.id, clock.now(), 1)
    const op = store.claimOperation({ runId: run.id, kind: "answer", logicalKey: delivery.deliveryToken, payloadDigest: "d", ownerGeneration: binding.daemonGeneration })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    store.transitionOperationPhase(op.id, "sending", "submitted")
    store.markAnswerDeliverySubmitted(delivery.id)
    clock.current += 100
    expect(store.claimAnswerDelivery(delivery.id, clock.now(), 1)).toBeNull()
    expect(store.confirmAnswerDelivered(delivery.id).kind).toBe("not_claimed")
    await engine.report({ runId: run.id, ask: "question N+1" })
    store.transitionOperationPhase(op.id, "submitted", "completed")
    await engine.observeRunnerOperation(op.id)
    expect(store.getRunById(run.id)?.pendingQuestion).toBe("question N+1")
    expect(store.getAnswerDelivery(delivery.id)?.notes).toBe("retained answer")
    expect(store.getAnswerDelivery(delivery.id)?.status).toBe("cancelled")
  })
})

describe("2.5: ACP answer delivery — submitted disposition", () => {
  it("accepted-before-write: notes are durable even before delivery attempts", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    const result = await engine.answer(run.id, "use approach B")
    expect(result.ok).toBe(true)
    const delivery = store.getOpenAnswerDelivery(run.id)
    // "submitted" is non-terminal-but-open — notes remain on the record.
    expect(delivery?.notes).toBe("use approach B")
  })

  it("write-before-crash (submitted): delivery marked submitted, never replayed on a subsequent attempt", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    await engine.answer(run.id, "use approach B")
    const delivery = store.getOpenAnswerDelivery(run.id)
    expect(delivery?.status).toBe("submitted")
    // One prompt for the step's initial dispatch, one for the answer delivery.
    expect(acpSessions.prompts).toHaveLength(2)

    // A second reconcile pass must NOT resend — "submitted" is excluded
    // from listPendingAnswerDeliveries's due-set (only pending/claimed-
    // expired are due).
    await engine.reconcile()
    expect(acpSessions.prompts).toHaveLength(2)
  })

  it("N+1 ask race: a newer question recorded before this delivery confirms is never erased", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "question N" })
    await engine.answer(run.id, "answer N")
    // The delivery for question N is "submitted" (open, unconfirmed).
    // The agent (still the same live turn) asks again before N's
    // delivery confirms — question N+1 is recorded on the SAME run.
    await engine.report({ runId: run.id, ask: "question N+1" })
    const after = store.getRunById(run.id)
    expect(after?.pendingQuestion).toBe("question N+1")
  })
})

describe("2.5: ACP answer delivery — lost/unknown response fences, never fails/retries", () => {
  it("crash after send (lost answer response) fences the run instead of failing the step", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    acpSessions.promptError = new RunnerOperationError("answer prompt lost", { delivery: "unknown" })
    const result = await engine.answer(run.id, "use approach B")
    expect(result.ok).toBe(true)
    const after = store.getRunById(run.id)
    expect(after?.status).toBe("uncertain")
    const feat = store.getFeature(feature.id)
    expect(feat?.status).toBe("escalated")
  })

  it("accepted notes remain available (never lost) even when the run is fenced", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    acpSessions.promptError = new RunnerOperationError("answer prompt lost", { delivery: "unknown" })
    await engine.answer(run.id, "use approach B — remember this")
    const delivery = store.getOpenAnswerDelivery(run.id) ?? store.listAnswerDeliveries(feature.id).at(-1)
    expect(delivery?.notes).toBe("use approach B — remember this")
  })

  it("no answer replay and no automatic step retry occurs after fencing", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    acpSessions.promptError = new RunnerOperationError("answer prompt lost", { delivery: "unknown" })
    await engine.answer(run.id, "use approach B")
    const promptCountAfterFence = acpSessions.prompts.length
    await engine.reconcile()
    // No new prompt sent, no new run dispatched for the escalated feature.
    expect(acpSessions.prompts.length).toBe(promptCountAfterFence)
    const feat = store.getFeature(feature.id)
    expect(feat?.status).toBe("escalated")
  })
})

describe("2.5: native answer-delivery regressions unaffected", () => {
  const nativeInteractiveWorkflow = workflow({ main: job([agentStep("implement", "implementer", "work", { interactive: true })]) }, roles)

  it("a native (non-ACP-routed) run still delivers through the ordinary native path", async () => {
    const engine = makeEngine(nativeInteractiveWorkflow, { runners: undefined })
    const result = await engine.startFeature("/tmp/native-project", { title: "Native" })
    if (!result.ok) throw new Error(result.message)
    const run = store.getActiveRun(result.feature.id)!
    await engine.report({ runId: run.id, ask: "native question" })
    const answered = await engine.answer(run.id, "native answer")
    expect(answered.ok).toBe(true)
    const delivery = store.listAnswerDeliveries(result.feature.id).at(-1)
    expect(delivery?.status).toBe("delivered")
  })
})

// ---------------------------------------------------------------------------
// D9/D6: pause/resume/abandon interaction with an ACP run — pause while
// idle-and-asking never fences/aborts (the completed turn is not
// "interrupted"), pause during an unreported/in-flight turn DOES fence,
// answering while paused stays durable with no prompt sent, and resume
// both delivers the durable answer and requires explicit uncertainty
// acknowledgment (never a plain resume) once a fence exists.
// ---------------------------------------------------------------------------

describe("D9: pause/resume/abandon — ACP interaction", () => {
  it("pause while idle-and-asking (turn already completed) does NOT fence or abort — a completed turn awaiting a human answer is not 'interrupted'", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    // The initial create+prompt operations both completed durably before
    // the ask — this run is idle, not mid-write.
    expect(store.listRunnerOperations(run.id).every(op => op.phase === "completed")).toBe(true)

    await engine.pause(feature.id)

    expect(store.getFeature(feature.id)?.status).toBe("paused")
    expect(store.getFence(run.id)).toBeNull()
    expect(acpSessions.aborted).toHaveLength(0)
    expect(store.getRunById(run.id)?.status).toBe("running")
  })

  it("answering while paused is durable — notes are accepted but no prompt is ever sent until resume", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    await engine.pause(feature.id)

    const promptsBefore = acpSessions.prompts.length
    const result = await engine.answer(run.id, "durable answer while paused")
    expect(result.ok).toBe(true)
    // Durable acceptance — the notes are on the delivery record — but
    // NO delivery attempt (no prompt) happens while paused (matches the
    // native pause-interaction barrier `listPendingAnswerDeliveries`
    // enforces for reconciliation, applied here to the immediate path
    // too).
    expect(acpSessions.prompts.length).toBe(promptsBefore)
    const delivery = store.getOpenAnswerDelivery(run.id)
    expect(delivery?.notes).toBe("durable answer while paused")
    expect(delivery?.status).toBe("pending")
  })

  it("resume delivers a durably-accepted answer that was recorded while paused", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    await engine.pause(feature.id)
    await engine.answer(run.id, "answer recorded during pause")
    expect(acpSessions.prompts).toHaveLength(1) // only the initial prompt so far

    await engine.resume(feature.id)
    // Resume alone (human.resumed) does not itself deliver — the SAME
    // reconcile() worker attemptAnswerDelivery uses for restart/pause-
    // resume recovery drains the pending delivery.
    await engine.reconcile()

    const delivery = store.listAnswerDeliveries(feature.id).at(-1)!
    expect(acpSessions.prompts.some(p => p.purpose === "answer")).toBe(true)
    expect(["submitted", "delivered"]).toContain(delivery.status)
  })

  it("pause during an unreported/in-flight (sending) turn DOES fence — an interrupted write cannot be proven safe", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    // Park the answer as a durable "pending" delivery first (busy status
    // defers the immediate send, exactly like the "waits for the
    // previous turn" test above), then manually advance its OWN durable
    // operation to "sending" — the exact "unreported ACP turn" shape D9
    // requires a fence for, without racing a real unresolved promise.
    await engine.report({ runId: run.id, ask: "which approach?" })
    acpSessions.statuses.set(run.sessionId!, "busy")
    await engine.answer(run.id, "answer mid-flight")
    const delivery = store.getOpenAnswerDelivery(run.id)!
    expect(delivery.status).toBe("pending")
    const binding = store.getRunnerBinding(run.id)!
    store.claimAnswerDelivery(delivery.id, clock.now(), 60_000)
    const op = store.claimOperation({ runId: run.id, kind: "answer", logicalKey: delivery.deliveryToken, payloadDigest: "d", ownerGeneration: binding.daemonGeneration })
    store.transitionOperationPhase(op.id, "prepared", "sending")

    await engine.pause(feature.id)

    const fence = store.getFence(run.id)
    expect(fence).not.toBeNull()
    expect(fence?.reasonCode).toBe("cancellation_during_uncertain_write")
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getRunById(run.id)?.status).toBe("uncertain")
  })

  it("resume on a fenced run rejects with a message NAMING the required acknowledgement — never a plain resume", async () => {
    const engine = makeEngine(interactiveWorkflow)
    const feature = await dispatchedAcpFeature(engine)
    const run = store.getActiveRun(feature.id)!
    await engine.report({ runId: run.id, ask: "which approach?" })
    acpSessions.statuses.set(run.sessionId!, "busy")
    await engine.answer(run.id, "answer mid-flight")
    const delivery = store.getOpenAnswerDelivery(run.id)!
    const binding = store.getRunnerBinding(run.id)!
    store.claimAnswerDelivery(delivery.id, clock.now(), 60_000)
    const op = store.claimOperation({ runId: run.id, kind: "answer", logicalKey: delivery.deliveryToken, payloadDigest: "d", ownerGeneration: binding.daemonGeneration })
    store.transitionOperationPhase(op.id, "prepared", "sending")
    await engine.pause(feature.id)
    expect(store.getFence(run.id)).not.toBeNull()

    // The rejection message must actually NAME the acknowledgement path
    // an operator needs (acknowledgeUncertain via recover), not a bare
    // "cannot resume" — a caller integrating this API needs the exact
    // remedy, not just a refusal.
    await expect(engine.resume(feature.id)).rejects.toThrow(/recover/i)
  })
})
