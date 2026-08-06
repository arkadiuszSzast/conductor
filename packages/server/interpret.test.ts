import { describe, expect, it } from "bun:test"
import { interpret } from "./src/engine/interpret.ts"
import type { FeatureState } from "./src/store.ts"
import type { PipelineDef } from "./src/engine/types.ts"

const def: PipelineDef = {
  roles: {
    implementer: { agent: "build", model: "prov/impl" },
    reviewer: { agent: "review", model: "prov/review" },
    fixer: { agent: "build", model: "prov/impl" },
  },
  pipeline: [
    { id: "implement", type: "agent", role: "implementer" },
    { id: "gate", type: "command", run: ["./check"], on_fail: { goto: "fix_gate", max_attempts: 2 } },
    { id: "fix_gate", type: "agent", role: "fixer", then: "gate" },
    {
      id: "review",
      type: "agent",
      role: "reviewer",
      rounds_with: "fix_review",
      max_rounds: 3,
      on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
    },
    { id: "fix_review", type: "agent", role: "fixer", then: "review" },
    { id: "merge", type: "builtin", action: "pr.merge", requires_human: true },
  ],
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
    currentStep: null,
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    attempts: {},
    rounds: {},
    escalation: null,
    ...over,
  }
}

describe("interpret: feature.start", () => {
  it("enters the first step", () => {
    const t = interpret(def, state(), { kind: "feature.start" })
    expect(t.decision).toEqual({ kind: "execute", stepId: "implement" })
    expect(t.patch.currentStep).toBe("implement")
    expect(t.patch.status).toBe("running")
  })
})

describe("interpret: retry and escalation", () => {
  it("retries the same step until max_attempts, then escalates", () => {
    const s = state({ currentStep: "gate", attempts: { gate: 1 } })
    const t1 = interpret(def, s, { kind: "step.failed", stepId: "gate", reason: "boom" })
    // attempts becomes 2 == max_attempts(2) → not exhausted yet, goto fix_gate
    expect(t1.decision).toEqual({ kind: "execute", stepId: "fix_gate" })
    expect(t1.patch.attempts).toEqual({ gate: 2 })

    const s2 = state({ currentStep: "gate", attempts: { gate: 2 } })
    const t2 = interpret(def, s2, { kind: "step.failed", stepId: "gate", reason: "boom again" })
    expect(t2.decision.kind).toBe("escalate")
    expect(t2.patch.status).toBe("escalated")
  })

  it("ignores stale success/failure events for a step that is no longer current", () => {
    const s = state({ currentStep: "gate" })
    const t = interpret(def, s, { kind: "step.succeeded", stepId: "implement" })
    expect(t.decision.kind).toBe("noop")
    expect(t.patch).toEqual({})
  })
})

describe("interpret: verdict routing and rounds_with", () => {
  it("routes changes_requested back to fix_review and tracks rounds", () => {
    const s = state({ currentStep: "review", rounds: {} })
    const t = interpret(def, s, { kind: "step.verdict", stepId: "review", verdict: "changes_requested" })
    expect(t.decision).toEqual({ kind: "execute", stepId: "fix_review" })
    expect(t.patch.rounds).toEqual({ review: 1 })
  })

  it("escalates after max_rounds of the same loop", () => {
    const s = state({ currentStep: "review", rounds: { review: 2 } })
    const t = interpret(def, s, { kind: "step.verdict", stepId: "review", verdict: "changes_requested" })
    expect(t.decision.kind).toBe("escalate")
    expect(t.patch.status).toBe("escalated")
  })

  it("escalates on an unmapped verdict", () => {
    const s = state({ currentStep: "review" })
    const t = interpret(def, s, { kind: "step.verdict", stepId: "review", verdict: "unknown" })
    expect(t.decision.kind).toBe("escalate")
  })
})

describe("interpret: human gates", () => {
  it("waits for human at a requires_human step", () => {
    const t = interpret(def, state({ currentStep: "review" }), {
      kind: "step.verdict",
      stepId: "review",
      verdict: "approved",
    })
    expect(t.decision).toEqual({ kind: "wait_human", stepId: "merge" })
    expect(t.patch.status).toBe("waiting_human")
  })

  it("executes the gate step on human.approved", () => {
    const s = state({ status: "waiting_human", currentStep: "merge" })
    const t = interpret(def, s, { kind: "human.approved", stepId: "merge" })
    expect(t.decision).toEqual({ kind: "execute", stepId: "merge" })
  })

  it("escalates human.rejected without on_reject; noop when no gate is pending", () => {
    const s = state({ status: "waiting_human", currentStep: "merge" })
    const t = interpret(def, s, { kind: "human.rejected", stepId: "merge" })
    expect(t.decision.kind).toBe("escalate")

    const notPending = state({ status: "running", currentStep: "merge" })
    const noop = interpret(def, notPending, { kind: "human.rejected", stepId: "merge" })
    expect(noop.decision.kind).toBe("noop")
  })
})

describe("interpret: resume resets the exhausted budget", () => {
  it("resets attempts/rounds for the escalated step on human.resumed", () => {
    const s = state({ status: "escalated", currentStep: "gate", attempts: { gate: 3 } })
    const t = interpret(def, s, { kind: "human.resumed" })
    expect(t.decision).toEqual({ kind: "execute", stepId: "gate" })
    expect(t.patch.attempts).toEqual({ gate: 0 })
  })

  it("escalates loudly when the current step vanished from the pipeline", () => {
    const s = state({ status: "paused", currentStep: "ghost-step" })
    const t = interpret(def, s, { kind: "human.resumed" })
    expect(t.decision.kind).toBe("escalate")
    expect(t.patch.status).toBe("escalated")
  })
})

describe("interpret: on_reject to another human-gated step (seed parity)", () => {
  // Seed parity: `enter` only issues `wait_human` when the feature is NOT
  // already `waiting_human`. A rejection at one gate is already in that
  // status, so routing on_reject to a second requires_human step executes
  // it immediately instead of re-pausing — this is the seed's actual
  // (surprising but confirmed) behaviour, not a bug to "fix" here.
  const twoGates: PipelineDef = {
    roles: {},
    pipeline: [
      { id: "gate1", type: "builtin", action: "pr.merge", requires_human: true, on_reject: { goto: "gate2" } },
      { id: "gate2", type: "builtin", action: "pr.merge", requires_human: true },
    ],
  }

  it("executes the second gate directly instead of re-issuing wait_human", () => {
    const s = state({ status: "waiting_human", currentStep: "gate1" })
    const t = interpret(twoGates, s, { kind: "human.rejected", stepId: "gate1" })
    expect(t.decision).toEqual({ kind: "execute", stepId: "gate2" })
    expect(t.patch.status).toBe("running")
    expect(t.patch.currentStep).toBe("gate2")
  })
})
