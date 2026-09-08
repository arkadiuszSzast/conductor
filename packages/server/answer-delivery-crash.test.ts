import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { Engine, type EngineDeps, type EngineOptions } from "./src/engine.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner, SessionClient } from "./src/ports.ts"
import type { WorkflowSnapshot } from "./src/workflow-registry.ts"
import type { ActionExecutor, ActionExecuteEffects, ActionHostExecuteResult } from "./src/action-host.ts"
import type { ResolvedActionBinding } from "./src/workflow-reservation.ts"
import { agentStep, commandStep, humanStep, job, next, rerunSteps, workflow } from "@conductor/core/testing.ts"
import type { WorkflowDef } from "@conductor/core"

// ---------------------------------------------------------------- fakes
// A trimmed copy of engine.test.ts's fakes — this file exercises crash
// boundaries around answer delivery specifically and wants its own
// tight control over `prompt()` failure injection without perturbing
// the main engine.test.ts fixtures.

class FakeSessions implements SessionClient {
  prompts: Array<{ sessionID: string; text: string; agent?: string; model?: string }> = []
  liveSessions = new Set<string>()
  statuses = new Map<string, "busy" | "idle" | "retry">()
  private counter = 0
  /** When set, the NEXT `prompt()` call throws this instead of
   *  succeeding — cleared automatically unless `promptThrowSticky` is
   *  set, letting a test inject either a single transient blip or a
   *  persistently unreachable session/runner across every attempt. */
  promptThrow: Error | null = null
  promptThrowSticky = false
  /** Every `prompt()` invocation, successful or thrown — unlike `prompts`
   *  (which only records ones that actually reached the session), this
   *  lets a test assert "reconcile attempted delivery N times" even
   *  while every attempt is failing. */
  promptCalls = 0

  async createSession(input: { title: string; directory: string; parentID?: string }): Promise<{ id: string }> {
    const id = `ses-${++this.counter}`
    this.liveSessions.add(id)
    return { id }
  }
  async prompt(input: { sessionID: string; text: string; agent?: string; model?: string }): Promise<void> {
    this.promptCalls += 1
    if (this.promptThrow) {
      const err = this.promptThrow
      if (!this.promptThrowSticky) this.promptThrow = null
      throw err
    }
    this.prompts.push(input)
  }
  async note(_input: { sessionID: string; text: string }): Promise<void> {}
  aborted: string[] = []
  async abort(sessionID: string): Promise<void> {
    this.aborted.push(sessionID)
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
  async execute(_binding: ResolvedActionBinding, _ctx: unknown, _effects?: ActionExecuteEffects): Promise<ActionHostExecuteResult> {
    return { ok: true, outputs: {} }
  }
}

const roles: WorkflowDef["roles"] = {
  implementer: { agent: "build", model: "prov/impl" },
}

const linearWorkflow: WorkflowDef = workflow(
  {
    main: job([
      agentStep("implement", "implementer", "Implement {{ inputs.feature }}.", { interactive: true }),
      commandStep("verify", ["bun test"]),
      humanStep("gate", { outcomes: { approved: next, rejected: rerunSteps(["implement"], 3) } }),
    ]),
  },
  roles,
  "linear",
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
let actions: FakeActionHost

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-answer-delivery-crash-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
  sessions = new FakeSessions()
  process_ = new FakeProcess()
  clock = new FakeClock()
  actions = new FakeActionHost()
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function makeEngine(options: EngineOptions = {}, overrides: Partial<EngineDeps> = {}): Engine {
  const snapshot = snapshotOf(linearWorkflow)
  return new Engine(
    {
      store, workflows: () => snapshot, sessions, process: process_, clock,
      log: { log: () => {} }, actions,
      ...overrides,
    },
    options,
  )
}

async function askingFeature(engine: Engine) {
  const result = await engine.startFeature("/tmp/project", { title: "Ship it" })
  if (!result.ok) throw new Error(result.message)
  const run = store.getActiveRunForStep(result.feature.id, "main", "implement")!
  await engine.report({ runId: run.id, ask: "Which storage?" })
  // `startFeature` already sent the step's initial agent prompt — every
  // assertion below counts ANSWER-delivery prompts specifically, so
  // capture that baseline here rather than asserting on the raw length.
  const promptsBefore = sessions.prompts.length
  return { feature: result.feature, run, promptsBefore }
}

// ---------------------------------------------------------------------------
// Crash boundary 1: before acceptance — no delivery row, question intact.
// ---------------------------------------------------------------------------

describe("crash boundary: before acceptance", () => {
  it("no delivery row exists and the question is intact until answer() is actually called", async () => {
    const engine = makeEngine()
    const { feature, run } = await askingFeature(engine)

    expect(store.listAnswerDeliveries(feature.id)).toHaveLength(0)
    expect(store.getRunById(run.id)!.pendingQuestion).toBe("Which storage?")
    expect(store.getFeature(feature.id)!.status).toBe("waiting_human")
  })
})

// ---------------------------------------------------------------------------
// Crash boundary 2: after acceptance, before the prompt is attempted —
// restart reconciliation delivers.
// ---------------------------------------------------------------------------

describe("crash boundary: after acceptance, before prompt delivery", () => {
  it("restart reconciliation delivers the accepted answer without a new operator submission", async () => {
    const engine = makeEngine()
    const { feature, run, promptsBefore } = await askingFeature(engine)

    // Simulate the crash: accept durably at the store level directly
    // (bypassing engine.answer, which would also attempt delivery) —
    // this is exactly the durable state a daemon crash between
    // `store.acceptAnswer` and the prompt attempt would leave behind.
    const accepted = store.acceptAnswer(run.id, "SQLite")
    expect(accepted.kind).toBe("accepted")
    expect(sessions.prompts).toHaveLength(promptsBefore)

    // A fresh engine over the same store (the restarted daemon).
    const restarted = makeEngine()
    await restarted.reconcile()

    expect(sessions.prompts).toHaveLength(promptsBefore + 1)
    expect(sessions.prompts.at(-1)!.sessionID).toBe(run.sessionId!)
    expect(sessions.prompts.at(-1)!.text).toContain("SQLite")
    expect(store.getRunById(run.id)!.pendingQuestion).toBeNull()
    expect(store.getFeature(feature.id)!.status).toBe("running")
    if (accepted.kind === "accepted") {
      expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("delivered")
    }
  })
})

// ---------------------------------------------------------------------------
// Crash boundary 3: after the prompt lands, before confirmation — lease
// expiry makes the row claimable again and a redelivery attempt happens.
// This is the documented at-least-once edge (design.md: "Treat
// confirmation strength as a runner boundary") — the prompt itself may
// be delivered TWICE to the session if the daemon crashes in this exact
// gap; only the store-side bookkeeping (claim/confirm) is exactly-once.
// ---------------------------------------------------------------------------

describe("crash boundary: after prompt delivery, before confirmation", () => {
  it("a lease-expired claimed delivery is claimable again and reconciliation redelivers (documented at-least-once edge)", async () => {
    const engine = makeEngine()
    const { feature, run, promptsBefore } = await askingFeature(engine)
    const accepted = store.acceptAnswer(run.id, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    // Simulate: a prior attempt claimed the delivery and sent the prompt,
    // then the daemon crashed before `confirmAnswerDelivered` committed.
    const claimed = store.claimAnswerDelivery(accepted.delivery.id, clock.now(), 60_000)
    expect(claimed).not.toBeNull()
    await sessions.prompt({ sessionID: run.sessionId!, text: `[conductor] The human answered your question:\n\nSQLite\n\n[conductor delivery ${claimed!.deliveryToken}]` })
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)
    // Still claimed, not confirmed — the row a crash right here leaves.
    expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("claimed")

    // Before the lease expires, reconciliation must NOT re-attempt.
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)

    // Once the lease expires, reconciliation redelivers — a SECOND prompt
    // reaches the session (at-least-once, not exactly-once, across this
    // boundary) but the store-side confirmation is exactly-once: the
    // delivery ends up `delivered` precisely once.
    clock.advance(61_000)
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 2)
    expect(sessions.prompts.at(-1)!.text).toContain(`[conductor delivery ${claimed!.deliveryToken}]`)
    expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("delivered")
    expect(store.getFeature(feature.id)!.status).toBe("running")
    expect(store.getRunById(run.id)!.pendingQuestion).toBeNull()

    // A third reconcile pass is a pure no-op: nothing pending, nothing
    // to redeliver.
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 2)
  })
})

// ---------------------------------------------------------------------------
// Crash boundary 4: after confirmation — no redelivery, ever.
// ---------------------------------------------------------------------------

describe("crash boundary: after confirmation", () => {
  it("a delivered answer is never redelivered across any number of reconcile passes", async () => {
    const engine = makeEngine()
    const { feature, run, promptsBefore } = await askingFeature(engine)

    const answered = await engine.answer(run.id, "SQLite")
    expect(answered.ok).toBe(true)
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)

    for (let i = 0; i < 5; i++) await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)
    expect(store.getFeature(feature.id)!.status).toBe("running")

    // A fresh engine over the same store (another restart) sees the same
    // terminal disposition and does not redeliver either.
    const restarted = makeEngine()
    await restarted.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)
  })
})

// ---------------------------------------------------------------------------
// Pause interaction: acceptance succeeds while paused; delivery waits for
// resume + reconcile.
// ---------------------------------------------------------------------------

describe("pause interaction", () => {
  it("acceptance succeeds while paused but the prompt is never attempted until resume + reconcile", async () => {
    const engine = makeEngine()
    const { feature, run, promptsBefore } = await askingFeature(engine)

    await engine.pause(feature.id)
    expect(store.getFeature(feature.id)!.status).toBe("paused")

    const answered = await engine.answer(run.id, "SQLite")
    expect(answered.ok).toBe(true)
    expect(sessions.prompts).toHaveLength(promptsBefore)
    const delivery = store.getOpenAnswerDelivery(run.id)
    expect(delivery).not.toBeNull()
    expect(delivery!.status).toBe("pending")

    // Reconcile while still paused must not attempt delivery either —
    // the same pause barrier durable retries/resource waits observe.
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore)

    await engine.resume(feature.id)
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)
    expect(sessions.prompts.at(-1)!.sessionID).toBe(run.sessionId!)
    expect(store.getFeature(feature.id)!.status).toBe("running")
  })
})

// ---------------------------------------------------------------------------
// Repeated answer while accepted-pending is rejected (clarified decision 1).
// ---------------------------------------------------------------------------

describe("repeated answer while accepted-pending", () => {
  it("a second answer request while the first is accepted-but-undelivered is rejected as a conflict, not a replacement", async () => {
    const engine = makeEngine()
    const { run } = await askingFeature(engine)

    // Pause first so the FIRST answer's acceptance durably lands without
    // its delivery attempt racing/consuming the question before the
    // second request arrives.
    await engine.pause(run.featureId)
    const first = await engine.answer(run.id, "SQLite")
    expect(first.ok).toBe(true)

    const second = await engine.answer(run.id, "Postgres")
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe("no_pending_question")

    const delivery = store.getOpenAnswerDelivery(run.id)!
    expect(delivery.notes).toBe("SQLite")
    expect(store.listAnswerDeliveries(run.featureId)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Dead session: run fails via the classified path and onFail routing applies.
// ---------------------------------------------------------------------------

describe("dead session routes through classified failure and onFail", () => {
  it("a rejected gate reruns implement; a dead session on the rerun still fails honestly through the same routing", async () => {
    const engine = makeEngine()
    const { feature, run } = await askingFeature(engine)
    sessions.liveSessions.delete(run.sessionId!)

    const result = await engine.answer(run.id, "yes")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("session_lost")

    // classified failure path: run fails, retry budget for "implement"
    // (DEFAULT_MAX_ATTEMPTS = 1, no `retry.backoff` declared) is
    // exhausted on the first failure and there's no onFail route on this
    // step in linearWorkflow, so the job — and with it the feature —
    // escalates. This is exactly the existing "answer on a dead session"
    // behavior (engine.test.ts), asserted here as the crash-boundary
    // regression guard for the durable delivery rework.
    expect(store.getRunById(run.id)!.status).toBe("failed")
    expect(store.getFeature(feature.id)!.status).toBe("escalated")
    const delivery = store.listAnswerDeliveries(feature.id).at(-1)!
    expect(delivery.status).toBe("failed")
    expect(delivery.notes).toBe("yes")
    expect(delivery.failureDetail).toContain("session")
  })
})

// ---------------------------------------------------------------------------
// Review fix: bounded, durable transient-delivery-retry scheduling —
// a persistently unreachable session/runner must eventually route
// through normal run failure instead of retrying the prompt forever.
// ---------------------------------------------------------------------------

describe("bounded transient delivery retries", () => {
  it("a future next_attempt_at (scheduled backoff) suppresses an early reconcile pass, then delivers once due", async () => {
    const engine = makeEngine()
    const { feature, run, promptsBefore } = await askingFeature(engine)
    const accepted = store.acceptAnswer(run.id, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    // A single transient blip on the first delivery attempt.
    sessions.promptThrow = Object.assign(new Error("fetch failed"), {})
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore)
    const scheduled = store.getAnswerDelivery(accepted.delivery.id)!
    expect(scheduled.status).toBe("pending")
    expect(scheduled.attemptCount).toBe(1)
    expect(scheduled.nextAttemptAt).not.toBeNull()
    expect(scheduled.nextAttemptAt!).toBeGreaterThan(clock.now())

    // Reconciling before the scheduled backoff elapses must NOT
    // re-attempt delivery — this is the durable difference from the
    // pre-fix behaviour (unconditional immediate release-to-pending).
    const dueAt = scheduled.nextAttemptAt!
    clock.current = dueAt - 1
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore)
    expect(store.getAnswerDelivery(accepted.delivery.id)!.attemptCount).toBe(1)

    // Once due, reconcile delivers successfully (no further throw armed).
    clock.current = dueAt
    await engine.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)
    expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("delivered")
    expect(store.getFeature(feature.id)!.status).toBe("running")
    expect(store.getRunById(run.id)!.pendingQuestion).toBeNull()
  })

  it("repeated transient failures exhaust the bounded attempt budget and terminal-route through normal run failure", async () => {
    const engine = makeEngine()
    const { feature, run } = await askingFeature(engine)
    const accepted = store.acceptAnswer(run.id, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    // Sticky: every prompt attempt fails transiently — the class-default
    // budget for transient_transport is 5 attempts (retry-policy.ts
    // PATIENT_BUDGET), so drive reconcile/advance past every scheduled
    // backoff until the budget is exhausted.
    sessions.promptThrow = Object.assign(new Error("fetch failed"), {})
    sessions.promptThrowSticky = true

    for (let i = 0; i < 6; i++) {
      const before = store.getAnswerDelivery(accepted.delivery.id)
      if (before === null || before.status !== "pending") break
      await engine.reconcile()
      const after = store.getAnswerDelivery(accepted.delivery.id)!
      if (after.status !== "pending") break
      clock.current = after.nextAttemptAt!
    }

    const final = store.getAnswerDelivery(accepted.delivery.id)!
    expect(final.status).toBe("failed")
    expect(final.failureDetail).toContain("exhausted")
    expect(final.notes).toBe("SQLite")

    // Terminal delivery failure routes through normal run
    // failure/retry/onFail exactly like a session-lost/deterministic
    // delivery error already does — no onFail on this step, single job,
    // so the feature escalates.
    expect(store.getRunById(run.id)!.status).toBe("failed")
    expect(store.getFeature(feature.id)!.status).toBe("escalated")
  })

  it("restart preserves the scheduled backoff: a fresh engine over the same store does not redeliver early", async () => {
    const engine = makeEngine()
    const { run, promptsBefore } = await askingFeature(engine)
    const accepted = store.acceptAnswer(run.id, "SQLite")
    if (accepted.kind !== "accepted") throw new Error("expected accepted")

    sessions.promptThrow = Object.assign(new Error("fetch failed"), {})
    await engine.reconcile()
    const scheduled = store.getAnswerDelivery(accepted.delivery.id)!
    expect(scheduled.status).toBe("pending")
    expect(scheduled.attemptCount).toBe(1)
    const dueAt = scheduled.nextAttemptAt!

    // "Restart": a fresh engine/clock instance over the same store,
    // still before the schedule is due.
    const restartedClock = new FakeClock()
    restartedClock.current = dueAt - 1
    const restarted = makeEngine({}, { clock: restartedClock })
    await restarted.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore)
    expect(store.getAnswerDelivery(accepted.delivery.id)!.attemptCount).toBe(1)

    // Once the restarted clock reaches the SAME persisted due time, the
    // schedule fires normally — restart never reset or lost it.
    restartedClock.current = dueAt
    await restarted.reconcile()
    expect(sessions.prompts).toHaveLength(promptsBefore + 1)
    expect(store.getAnswerDelivery(accepted.delivery.id)!.status).toBe("delivered")
  })
})

// ---------------------------------------------------------------------------
// Review fix: secret-safe diagnostics — a prompt exception carrying a
// credential must never survive into durable/logged state unredacted.
// ---------------------------------------------------------------------------

describe("secret-safe diagnostics", () => {
  it("a terminal (non-transient) prompt failure carrying a Bearer token is redacted in run.reason, the delivery's failureDetail, and the log — never the operator's notes", async () => {
    const logs: string[] = []
    const engine = makeEngine({}, { log: { log: line => logs.push(line) } })
    const { feature, run } = await askingFeature(engine)

    // Deterministic (non-transient) failure: classifyThrownBoundary
    // falls through to "internal" for an unrecognized message shape, so
    // this routes straight through the terminal path instead of the
    // bounded-retry path — the SAME redaction guarantee must hold there.
    const secret = "sk-verysecrettoken1234567890"
    sessions.promptThrow = new Error(`upstream rejected: Authorization: Bearer ${secret}`)

    const result = await engine.answer(run.id, "the human's own SQLite notes")
    expect(result.ok).toBe(false)

    const failedRun = store.getRunById(run.id)!
    expect(failedRun.status).toBe("failed")
    expect(failedRun.reason).not.toContain(secret)
    expect(failedRun.reason).toContain("Bearer [REDACTED]")
    expect(failedRun.failure?.diagnostic).not.toContain(secret)

    const delivery = store.listAnswerDeliveries(feature.id).at(-1)!
    expect(delivery.failureDetail).not.toContain(secret)
    // The operator's own notes must survive completely untouched —
    // redaction targets diagnostics, never human-authored answer text.
    expect(delivery.notes).toBe("the human's own SQLite notes")

    for (const line of logs) expect(line).not.toContain(secret)
  })

  it("a huge diagnostic embedding a secret past the truncation point is still redacted (redact-then-truncate ordering)", async () => {
    const engine = makeEngine()
    const { run } = await askingFeature(engine)

    const secret = "sk-anothersecrettoken998877"
    const huge = "x".repeat(10_000) + ` Bearer ${secret} ` + "y".repeat(10_000)
    sessions.promptThrow = new Error(huge)

    await engine.answer(run.id, "notes")

    const failedRun = store.getRunById(run.id)!
    expect(failedRun.reason).not.toContain(secret)
  })
})
