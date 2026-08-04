import { expect, it } from "bun:test"
import { name as core, interpret, render, validateWorkflow } from "@conductor/core"
import { name as server } from "@conductor/server"
import { name as runner } from "@conductor/runner-opencode"
import { name as cli } from "@conductor/cli"

it("resolves every workspace package", () => {
  expect(core).toBe("@conductor/core")
  expect(render("{{value}}", { value: core }).text).toBe("@conductor/core")
  expect(server).toBe("@conductor/server")
  expect(runner).toBe("@conductor/runner-opencode")
  expect(cli).toBe("@conductor/cli")
})

it("exports a working interpret + validateWorkflow pair", () => {
  const workflow = {
    name: "smoke",
    roles: { implementer: { agent: "build" } },
    jobs: { main: { steps: [{ id: "impl", type: "agent", role: "implementer", prompt: "impl" }] } },
  } as const
  expect(validateWorkflow(workflow).errors).toEqual([])
  const state = {
    id: "f",
    title: "t",
    slug: "t",
    projectDir: "/tmp",
    workflow: null,
    description: null,
    status: "running",
    trigger: null,
    input: {},
    sessionId: null,
    worktree: null,
    branch: null,
    pr: null,
    jobs: { main: { status: "pending", currentStep: null, attempts: {}, rounds: {}, reruns: {}, outputs: {}, steps: {} } },
  } as const
  expect(interpret(workflow, state, { kind: "feature.start" }).decisions[0]).toEqual({
    kind: "execute_step",
    jobId: "main",
    stepId: "impl",
  })
})
