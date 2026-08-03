import { describe, expect, it } from "bun:test"
import { interpret } from "./src/interpret"
import type { FeatureState, PipelineDef } from "./src/types"

/** Minimal quality pipeline used across the tests. */
const def: PipelineDef = {
  roles: {
    implementer: { agent: "build", model: "prov/impl" },
    reviewer: { agent: "review", model: "prov/review" },
    fixer: { agent: "build", model: "prov/impl" },
  },
  pipeline: [
    { id: "implement", type: "agent", role: "implementer" },
    {
      id: "gate",
      type: "command",
      run: ["./gradlew check"],
      on_fail: { goto: "fix_gate", max_attempts: 2 },
    },
    { id: "fix_gate", type: "agent", role: "fixer", then: "gate" },
    {
      id: "review",
      type: "agent",
      role: "reviewer",
      rounds_with: "fix_review",
      max_rounds: 3,
      on_verdict: {
        approved: { next: true },
        changes_requested: { goto: "fix_review" },
      },
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
    ...over,
  }
}

describe("feature.start", () => {
  it("enters the first step", () => {
    const t = interpret(def, state(), { kind: "feature.start" })
    expect(t.decision).toEqual({ kind: "execute", stepId: "implement" })
    expect(t.patch.currentStep).toBe("implement")
    expect(t.patch.status).toBe("running")
  })
})

describe("step.succeeded", () => {
  it("advances to the next step in list order", () => {
    const t = interpret(def, state({ currentStep: "implement" }), {
      kind: "step.succeeded",
      stepId: "implement",
    })
    expect(t.decision).toEqual({ kind: "execute", stepId: "gate" })
  })

  it("honours explicit then", () => {
    const t = interpret(def, state({ currentStep: "fix_gate" }), {
      kind: "step.succeeded",
      stepId: "fix_gate",
    })
    expect(t.decision).toEqual({ kind: "execute", stepId: "gate" })
  })

  it("finishes after the last step", () => {
    const t = interpret(def, state({ currentStep: "merge" }), {
      kind: "step.succeeded",
      stepId: "merge",
    })
    expect(t.decision).toEqual({ kind: "finish" })
    expect(t.patch.status).toBe("done")
  })

  it("ignores stale success from a step that is no longer current", () => {
    const t = interpret(def, state({ currentStep: "review" }), {
      kind: "step.succeeded",
      stepId: "implement",
    })
    expect(t.decision.kind).toBe("noop")
    expect(t.patch).toEqual({})
  })

  it("pauses at a requires_human step instead of executing it", () => {
    const t = interpret(def, state({ currentStep: "review", rounds: { review: 1 } }), {
      kind: "step.verdict",
      stepId: "review",
      verdict: "approved",
    })
    expect(t.decision).toEqual({ kind: "wait_human", stepId: "merge" })
    expect(t.patch.status).toBe("waiting_human")
  })
})

describe("step.failed", () => {
  it("routes to on_fail.goto and counts the attempt", () => {
    const t = interpret(def, state({ currentStep: "gate" }), {
      kind: "step.failed",
      stepId: "gate",
      reason: "exit 1",
    })
    expect(t.decision).toEqual({ kind: "execute", stepId: "fix_gate" })
    expect(t.patch.attempts).toEqual({ gate: 1 })
  })

  it("escalates when max_attempts is exhausted", () => {
    const t = interpret(def, state({ currentStep: "gate", attempts: { gate: 2 } }), {
      kind: "step.failed",
      stepId: "gate",
      reason: "exit 1",
    })
    expect(t.decision.kind).toBe("escalate")
    expect(t.patch.status).toBe("escalated")
  })

  it("retries the same step when there is no goto", () => {
    const localDef: PipelineDef = {
      roles: def.roles,
      pipeline: [
        { id: "flaky", type: "command", run: ["true"], on_fail: { max_attempts: 3 } },
      ],
    }
    const t = interpret(localDef, state({ currentStep: "flaky" }), {
      kind: "step.failed",
      stepId: "flaky",
      reason: "network",
    })
    expect(t.decision).toEqual({ kind: "execute", stepId: "flaky" })
    expect(t.patch.attempts).toEqual({ flaky: 1 })
  })

  it("escalates immediately when on_fail.escalate is set", () => {
    const localDef: PipelineDef = {
      roles: def.roles,
      pipeline: [
        { id: "critical", type: "command", run: ["true"], on_fail: { escalate: true } },
      ],
    }
    const t = interpret(localDef, state({ currentStep: "critical" }), {
      kind: "step.failed",
      stepId: "critical",
      reason: "boom",
    })
    expect(t.decision.kind).toBe("escalate")
  })

  it("defaults to a single attempt when on_fail is absent", () => {
    const localDef: PipelineDef = {
      roles: def.roles,
      pipeline: [{ id: "solo", type: "command", run: ["true"] }],
    }
    const first = interpret(localDef, state({ currentStep: "solo" }), {
      kind: "step.failed",
      stepId: "solo",
      reason: "x",
    })
    expect(first.decision).toEqual({ kind: "execute", stepId: "solo" })
    const second = interpret(
      localDef,
      state({ currentStep: "solo", attempts: { solo: 1 } }),
      { kind: "step.failed", stepId: "solo", reason: "x" },
    )
    expect(second.decision.kind).toBe("escalate")
  })
})

describe("step.verdict (review loops)", () => {
  it("routes changes_requested to the fix step and counts the round", () => {
    const t = interpret(def, state({ currentStep: "review" }), {
      kind: "step.verdict",
      stepId: "review",
      verdict: "changes_requested",
    })
    expect(t.decision).toEqual({ kind: "execute", stepId: "fix_review" })
    expect(t.patch.rounds).toEqual({ review: 1 })
  })

  it("escalates after max_rounds without approval", () => {
    const t = interpret(def, state({ currentStep: "review", rounds: { review: 2 } }), {
      kind: "step.verdict",
      stepId: "review",
      verdict: "changes_requested",
    })
    expect(t.decision.kind).toBe("escalate")
    expect(t.patch.rounds).toEqual({ review: 3 })
  })

  it("approved verdict proceeds past the loop", () => {
    const t = interpret(def, state({ currentStep: "review", rounds: { review: 2 } }), {
      kind: "step.verdict",
      stepId: "review",
      verdict: "approved",
    })
    expect(t.decision).toEqual({ kind: "wait_human", stepId: "merge" })
  })

  it("escalates on an unmapped verdict", () => {
    const t = interpret(def, state({ currentStep: "review" }), {
      kind: "step.verdict",
      stepId: "review",
      verdict: "wat",
    })
    expect(t.decision.kind).toBe("escalate")
  })

  it("ignores a stale verdict", () => {
    const t = interpret(def, state({ currentStep: "gate" }), {
      kind: "step.verdict",
      stepId: "review",
      verdict: "approved",
    })
    expect(t.decision.kind).toBe("noop")
  })
})

describe("human interactions", () => {
  it("human.approved executes the awaited step", () => {
    const t = interpret(
      def,
      state({ currentStep: "merge", status: "waiting_human" }),
      { kind: "human.approved", stepId: "merge" },
    )
    expect(t.decision).toEqual({ kind: "execute", stepId: "merge" })
    expect(t.patch.status).toBe("running")
  })

  it("human.approved is a noop when nothing awaits approval", () => {
    const t = interpret(def, state({ currentStep: "gate" }), {
      kind: "human.approved",
      stepId: "merge",
    })
    expect(t.decision.kind).toBe("noop")
  })

  it("pause and resume round-trip preserves the current step", () => {
    const paused = interpret(def, state({ currentStep: "gate" }), { kind: "human.paused" })
    expect(paused.patch.status).toBe("paused")
    const resumed = interpret(
      def,
      state({ currentStep: "gate", status: "paused" }),
      { kind: "human.resumed" },
    )
    expect(resumed.decision).toEqual({ kind: "execute", stepId: "gate" })
  })

  it("resume at a requires_human step waits for the human again", () => {
    const t = interpret(
      def,
      state({ currentStep: "merge", status: "paused" }),
      { kind: "human.resumed" },
    )
    expect(t.decision).toEqual({ kind: "wait_human", stepId: "merge" })
  })

  it("resume from ESCALATED re-executes the current step with its budget reset", () => {
    const t = interpret(
      def,
      state({
        currentStep: "gate",
        status: "escalated",
        attempts: { gate: 2, other: 1 },
        rounds: { gate: 3 },
      }),
      { kind: "human.resumed" },
    )
    expect(t.decision).toEqual({ kind: "execute", stepId: "gate" })
    expect(t.patch.status).toBe("running")
    // Current step's budget zeroed; other steps untouched.
    expect(t.patch.attempts).toEqual({ gate: 0, other: 1 })
    expect(t.patch.rounds).toEqual({ gate: 0 })
  })

  it("resume on a running feature stays a noop", () => {
    const t = interpret(def, state({ currentStep: "gate", status: "running" }), { kind: "human.resumed" })
    expect(t.decision.kind).toBe("noop")
  })

  it("human.abandoned abandons from any state", () => {
    const t = interpret(def, state({ currentStep: "review" }), { kind: "human.abandoned" })
    expect(t.decision.kind).toBe("abandon")
    expect(t.patch.status).toBe("abandoned")
  })
})
