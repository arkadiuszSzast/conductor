import { describe, expect, it } from "bun:test"
import { validateWorkflow } from "./src/validate.ts"
import {
  actionStep,
  agentStep,
  backoff,
  commandStep,
  goto,
  humanStep,
  job,
  rerunSteps,
  workflow,
} from "./testing.ts"
import type { RetryPolicy, WorkflowDef } from "./src/types.ts"

const roles: WorkflowDef["roles"] = { implementer: { agent: "build" } }

const base = workflow({ main: job([agentStep("impl", "implementer", "impl")]) }, roles, "v")

const withJobs = (jobs: WorkflowDef["jobs"]): WorkflowDef => ({ ...base, jobs })

describe("validateWorkflow", () => {
  it("accepts a minimal workflow", () => {
    expect(validateWorkflow(base).errors).toEqual([])
  })

  it("rejects a workflow with no jobs", () => {
    expect(validateWorkflow(withJobs({})).errors.length).toBeGreaterThan(0)
  })

  it("rejects a job with no steps", () => {
    const r = validateWorkflow(withJobs({ main: job([]) }))
    expect(r.errors.join("\n")).toContain("no steps")
  })

  it("rejects duplicate step ids in a job", () => {
    const r = validateWorkflow(withJobs({
      main: job([commandStep("a", ["x"]), commandStep("a", ["y"])]),
    }))
    expect(r.errors.join("\n")).toContain("duplicate step id")
  })

  it("rejects a goto edge to a missing step", () => {
    const r = validateWorkflow(withJobs({
      main: job([commandStep("a", ["x"], { outcomes: { done: goto("ghost") } })]),
    }))
    expect(r.errors.join("\n")).toContain('goto → "ghost"')
  })

  it("rejects an onFail goto to a missing step", () => {
    const r = validateWorkflow(withJobs({
      main: job([commandStep("a", ["x"], { onFail: goto("ghost") })]),
    }))
    expect(r.errors.join("\n")).toContain('goto → "ghost"')
  })

  it("rejects an unknown role", () => {
    const r = validateWorkflow(withJobs({ main: job([agentStep("a", "nope", "a")]) }))
    expect(r.errors.join("\n")).toContain('role "nope"')
  })

  it("rejects a dependency on a missing job", () => {
    const r = validateWorkflow(withJobs({
      a: job([commandStep("s", ["x"])]),
      b: job([commandStep("s", ["x"])], ["ghost"]),
    }))
    expect(r.errors.join("\n")).toContain('"b": needs → "ghost"')
  })

  it("rejects a job dependency cycle", () => {
    const r = validateWorkflow(withJobs({
      a: job([commandStep("s", ["x"])], ["b"]),
      b: job([commandStep("s", ["x"])], ["a"]),
    }))
    expect(r.errors.join("\n")).toContain("cycle")
  })

  it("rejects an unbounded step loop with no counter", () => {
    const r = validateWorkflow(withJobs({
      main: job([
        commandStep("a", ["x"], { outcomes: { done: goto("b") } }),
        commandStep("b", ["x"], { outcomes: { done: goto("a") } }),
      ]),
    }))
    expect(r.errors.join("\n")).toContain("unbounded loop")
  })

  it("accepts a loop reached via onFail.goto when a retry budget bounds it", () => {
    const r = validateWorkflow(withJobs({
      main: job([
        commandStep("a", ["x"]),
        commandStep("b", ["x"], { retry: backoff(3), onFail: goto("a") }),
      ]),
    }))
    expect(r.errors).toEqual([])
  })

  it("accepts a review loop bounded by rerun.stepIds", () => {
    const r = validateWorkflow(withJobs({
      main: job([
        agentStep("r", "implementer", "r", {
          outcomes: { changes_requested: rerunSteps(["fix"], 3) },
        }),
        agentStep("fix", "implementer", "fix", { outcomes: { done: goto("r") } }),
      ]),
    }))
    expect(r.errors).toEqual([])
  })

  it("accepts a human gate that loops back on rejection", () => {
    const r = validateWorkflow(withJobs({
      main: job([
        agentStep("draft", "implementer", "draft"),
        humanStep("gate", { outcomes: { rejected: rerunSteps(["draft"], 2) } }),
      ]),
    }))
    expect(r.errors).toEqual([])
  })

  it("accepts a human prompt quoting an earlier step's report", () => {
    const r = validateWorkflow(withJobs({
      main: job([
        agentStep("explore", "implementer", "explore"),
        humanStep("gate", { prompt: "Answer: {{ steps.explore.outputs.report }}" }),
      ]),
    }))
    expect(r.errors).toEqual([])
  })

  it("rejects a human prompt referencing a later step", () => {
    const r = validateWorkflow(withJobs({
      main: job([
        humanStep("gate", { prompt: "{{ steps.impl.outputs.report }}" }),
        agentStep("impl", "implementer", "impl"),
      ]),
    }))
    expect(r.errors.some(e => e.includes("gate") && e.includes("prompt"))).toBe(true)
  })

  it("rejects a human prompt reading an undeclared needs output", () => {
    const r = validateWorkflow(withJobs({
      up: job([agentStep("a", "implementer", "a")]),
      main: job([humanStep("gate", { prompt: "{{ needs.up.outputs.missing }}" })], ["up"]),
    }))
    expect(r.errors.some(e => e.includes("prompt"))).toBe(true)
  })

  it("rejects an empty command run list", () => {
    const r = validateWorkflow(withJobs({ main: job([commandStep("a", [])]) }))
    expect(r.errors.join("\n")).toContain("empty run")
  })

  it("rejects an action step with no uses", () => {
    const r = validateWorkflow(withJobs({ main: job([actionStep("a", "")]) }))
    expect(r.errors.join("\n")).toContain("empty uses")
  })

  it("rejects a backoff retry with maxAttempts below 1", () => {
    const r = validateWorkflow(withJobs({
      main: job([commandStep("a", ["x"], { retry: backoff(0) })]),
    }))
    expect(r.errors.join("\n")).toContain("retry.maxAttempts")
  })

  it("rejects a constant backoff with a negative delay", () => {
    const r = validateWorkflow(withJobs({
      main: job([commandStep("a", ["x"], { retry: backoff(2, -1) })]),
    }))
    expect(r.errors.join("\n")).toContain("backoff.delay")
  })

  it("rejects an exponential backoff with a multiplier below 1", () => {
    const retry: RetryPolicy = {
      strategy: "backoff",
      maxAttempts: 2,
      backoff: { strategy: "exponential", initial: 100, multiplier: 0.5, max: 1000 },
    }
    const r = validateWorkflow(withJobs({ main: job([commandStep("a", ["x"], { retry })]) }))
    expect(r.errors.join("\n")).toContain("backoff.multiplier")
  })

  it("rejects a malformed maxElapsed duration", () => {
    const retry: RetryPolicy = {
      strategy: "backoff",
      maxAttempts: 2,
      maxElapsed: "10m",
      backoff: { strategy: "constant", delay: 10 },
    }
    const r = validateWorkflow(withJobs({ main: job([commandStep("a", ["x"], { retry })]) }))
    expect(r.errors.join("\n")).toContain("ISO-8601")
  })

  it("accepts a valid ISO-8601 maxElapsed", () => {
    const retry: RetryPolicy = {
      strategy: "backoff",
      maxAttempts: 2,
      maxElapsed: "PT10M",
      backoff: { strategy: "constant", delay: 10 },
    }
    const r = validateWorkflow(withJobs({ main: job([commandStep("a", ["x"], { retry })]) }))
    expect(r.errors).toEqual([])
  })
})
