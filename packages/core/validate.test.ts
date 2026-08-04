import { describe, expect, it } from "bun:test"
import { validateWorkflow } from "./src/validate.ts"
import type { WorkflowDef } from "./src/types.ts"

const base: WorkflowDef = {
  name: "v",
  roles: { implementer: { agent: "build" } },
  jobs: {
    main: { steps: [{ id: "impl", type: "agent", role: "implementer", prompt: "impl" }] },
  },
}

describe("validateWorkflow", () => {
  it("accepts a minimal workflow", () => {
    const r = validateWorkflow(base)
    expect(r.errors).toEqual([])
  })

  it("rejects a workflow with no jobs", () => {
    const r = validateWorkflow({ ...base, jobs: {} })
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it("rejects duplicate step ids in a job", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: {
          steps: [
            { id: "a", type: "command", run: ["x"] },
            { id: "a", type: "command", run: ["y"] },
          ],
        },
      },
    })
    expect(r.errors.join("\n")).toContain("duplicate step id")
  })

  it("rejects a then edge to a missing step", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: { steps: [{ id: "a", type: "command", run: ["x"], then: "ghost" }] },
      },
    })
    expect(r.errors.join("\n")).toContain('then → "ghost"')
  })

  it("rejects an unknown role", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: { steps: [{ id: "a", type: "agent", role: "nope", prompt: "a" }] },
      },
    })
    expect(r.errors.join("\n")).toContain('role "nope"')
  })

  it("rejects a dependency on a missing job", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        a: { steps: [{ id: "s", type: "command", run: ["x"] }] },
        b: { needs: ["ghost"], steps: [{ id: "s", type: "command", run: ["x"] }] },
      },
    })
    expect(r.errors.join("\n")).toContain('"b": needs → "ghost"')
  })

  it("rejects a job dependency cycle", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        a: { needs: ["b"], steps: [{ id: "s", type: "command", run: ["x"] }] },
        b: { needs: ["a"], steps: [{ id: "s", type: "command", run: ["x"] }] },
      },
    })
    expect(r.errors.join("\n")).toContain("cycle")
  })

  it("rejects an unbounded step loop with no counter", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: {
          steps: [
            { id: "a", type: "command", run: ["x"], then: "b" },
            { id: "b", type: "command", run: ["x"], then: "a" },
          ],
        },
      },
    })
    expect(r.errors.join("\n")).toContain("unbounded loop")
  })

  it("accepts a loop reached via onFail.goto (bounded by retry.maxAttempts)", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: {
          steps: [
            { id: "a", type: "command", run: ["x"] },
            { id: "b", type: "command", run: ["x"], retry: { maxAttempts: 3 }, onFail: { goto: "a" } },
          ],
        },
      },
    })
    expect(r.errors).toEqual([])
  })

  it("accepts a review loop bounded by rounds_with", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: {
          steps: [
            { id: "r", type: "agent", role: "implementer", prompt: "r", roundsWith: "fix", maxRounds: 3, onVerdict: { approved: { next: true }, changes_requested: { goto: "fix" } } },
            { id: "fix", type: "agent", role: "implementer", prompt: "fix", then: "r" },
          ],
        },
      },
    })
    expect(r.errors).toEqual([])
  })

  it("warns when an agent step routes nowhere", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: {
          steps: [{ id: "a", type: "agent", role: "implementer", prompt: "a", onVerdict: { ok: {} } }],
        },
      },
    })
    expect(r.warnings.join("\n")).toContain("routes nowhere")
  })

  it("warns when onReject is used on a non-human step", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: {
          steps: [{ id: "a", type: "command", run: ["x"], onReject: { goto: "a" } }],
        },
      },
    })
    expect(r.warnings.join("\n")).toContain("non-human")
  })

  it("rejects an empty command run list", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: { steps: [{ id: "a", type: "command", run: [] }] },
      },
    })
    expect(r.errors.join("\n")).toContain("empty run")
  })

  it("rejects an action step with no uses", () => {
    const r = validateWorkflow({
      ...base,
      jobs: {
        main: { steps: [{ id: "a", type: "action", uses: "" }] },
      },
    })
    expect(r.errors.join("\n")).toContain("empty uses")
  })
})
