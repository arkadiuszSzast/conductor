import { describe, expect, it } from "bun:test"
import { validatePipeline } from "./src/validate"
import type { PipelineDef } from "./src/types"

const roles = {
  implementer: { agent: "build" },
  reviewer: { agent: "review" },
  fixer: { agent: "build" },
}

describe("validatePipeline", () => {
  it("accepts a well-formed pipeline", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [
        { id: "implement", type: "agent", role: "implementer" },
        { id: "gate", type: "command", run: ["make check"], on_fail: { goto: "fix", max_attempts: 2 } },
        { id: "fix", type: "agent", role: "fixer", then: "gate" },
        {
          id: "review",
          type: "agent",
          role: "reviewer",
          rounds_with: "fix_review",
          on_verdict: { approved: { next: true }, changes_requested: { goto: "fix_review" } },
        },
        { id: "fix_review", type: "agent", role: "fixer", then: "review" },
        { id: "merge", type: "builtin", action: "pr.merge" },
      ],
    }
    const result = validatePipeline(def)
    expect(result.errors).toEqual([])
  })

  it("rejects an empty pipeline", () => {
    const result = validatePipeline({ roles, pipeline: [] })
    expect(result.errors.length).toBe(1)
  })

  it("rejects duplicate step ids", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [
        { id: "a", type: "command", run: ["true"] },
        { id: "a", type: "command", run: ["true"] },
      ],
    }
    expect(validatePipeline(def).errors.some((e) => e.includes("duplicate"))).toBe(true)
  })

  it("rejects dangling then / on_fail.goto / rounds_with / on_verdict.goto", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [
        { id: "a", type: "command", run: ["true"], then: "ghost1", on_fail: { goto: "ghost2" } },
        {
          id: "b",
          type: "agent",
          role: "reviewer",
          rounds_with: "ghost3",
          on_verdict: { approved: { goto: "ghost4" } },
        },
      ],
    }
    const { errors } = validatePipeline(def)
    expect(errors.some((e) => e.includes("ghost1"))).toBe(true)
    expect(errors.some((e) => e.includes("ghost2"))).toBe(true)
    expect(errors.some((e) => e.includes("ghost3"))).toBe(true)
    expect(errors.some((e) => e.includes("ghost4"))).toBe(true)
  })

  it("rejects an agent step with an unknown role", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [{ id: "a", type: "agent", role: "nonexistent" }],
    }
    expect(validatePipeline(def).errors.some((e) => e.includes("nonexistent"))).toBe(true)
  })

  it("rejects a command step with an empty run list", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [{ id: "a", type: "command", run: [] }],
    }
    expect(validatePipeline(def).errors.some((e) => e.includes("empty run"))).toBe(true)
  })

  it("rejects an unbounded then-loop with no counter", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [
        { id: "a", type: "command", run: ["true"], then: "b" },
        { id: "b", type: "command", run: ["true"], then: "a" },
      ],
    }
    expect(validatePipeline(def).errors.some((e) => e.includes("unbounded loop"))).toBe(true)
  })

  it("accepts a loop bounded by rounds_with", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [
        {
          id: "review",
          type: "agent",
          role: "reviewer",
          rounds_with: "fix",
          max_rounds: 3,
          on_verdict: { approved: { next: true }, changes_requested: { goto: "fix" } },
        },
        { id: "fix", type: "agent", role: "fixer", then: "review" },
      ],
    }
    expect(validatePipeline(def).errors).toEqual([])
  })

  it("warns when an on_verdict route goes nowhere", () => {
    const def: PipelineDef = {
      roles,
      pipeline: [
        {
          id: "review",
          type: "agent",
          role: "reviewer",
          on_verdict: { approved: {} },
        },
      ],
    }
    const { errors, warnings } = validatePipeline(def)
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.includes("routes nowhere"))).toBe(true)
  })
})
