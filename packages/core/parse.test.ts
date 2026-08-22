import { describe, expect, it } from "bun:test"
import { parseWorkflow } from "./src/parse.ts"
import type { ParseError } from "./src/parse.ts"
import { validateWorkflow } from "./src/validate.ts"
import type { WorkflowDef } from "./src/types.ts"

const fixture = (name: string): Promise<string> =>
  Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text()

function parsed(source: string): WorkflowDef {
  const result = parseWorkflow(source)
  if (!result.ok) throw new Error(result.errors.map(error => error.message).join("\n"))
  return result.workflow
}

function failed(source: string): readonly ParseError[] {
  const result = parseWorkflow(source)
  if (result.ok) throw new Error("expected parse errors, got a workflow")
  return result.errors
}

const messages = (errors: readonly ParseError[]): string => errors.map(error => error.message).join("\n")

describe("golden fixtures — valid", () => {
  const cases = ["minimal-linear", "fan-out-fan-in", "gate", "review-fix-loop", "feature-delivery"]
  for (const name of cases) {
    it(`${name} parses and validates cleanly`, async () => {
      const workflow = parsed(await fixture(`valid/${name}.yaml`))
      expect(validateWorkflow(workflow).errors).toEqual([])
    })
  }
})

describe("golden fixtures — invalid", () => {
  it("rejects duplicate keys with the duplicate's location", async () => {
    const errors = failed(await fixture("invalid/duplicate-key.yaml"))
    expect(messages(errors)).toContain("duplicate mapping key")
    expect(errors[0]!.line).toBe(2)
  })

  it("rejects anchors and aliases", async () => {
    const errors = failed(await fixture("invalid/alias.yaml"))
    expect(messages(errors)).toContain("aliases are not allowed")
    expect(messages(errors)).toContain("anchors are not allowed")
  })

  it("rejects an unknown field with location and closest-match suggestion", async () => {
    const errors = failed(await fixture("invalid/unknown-field.yaml"))
    expect(messages(errors)).toContain('unknown field "promt" — did you mean "prompt"?')
    const error = errors.find(candidate => candidate.message.includes("promt"))!
    expect(error.line).toBe(12)
    expect(error.col).toBe(11)
  })

  it("rejects mixed step kinds naming the step and the conflicting keys", async () => {
    const errors = failed(await fixture("invalid/mixed-step-kinds.yaml"))
    expect(messages(errors)).toContain('step "confused"')
    expect(messages(errors)).toContain("conflicting keys: agent, command")
  })

  it("rejects malformed inputs — bad type, required+default, neither, mismatched default", async () => {
    const errors = failed(await fixture("invalid/bad-input-type.yaml"))
    const text = messages(errors)
    expect(text).toContain('input "feature": type must be one of: string, number, boolean')
    expect(text).toContain('input "budget": required and default are mutually exclusive')
    expect(text).toContain('input "quiet": declare either required: true or a default')
    expect(text).toContain('input "retries": default must be a number')
  })
})

describe("document safety limits", () => {
  it("rejects custom tags", () => {
    const errors = failed('name: x\njobs:\n  main:\n    steps: !steps []\n')
    expect(messages(errors)).toContain("custom tags are not allowed")
  })

  it("rejects multiple documents", () => {
    const errors = failed("name: a\njobs: {}\n---\nname: b\n")
    expect(messages(errors)).toContain("multiple YAML documents")
  })

  it("rejects a non-mapping document", () => {
    expect(messages(failed("- just\n- a\n- list\n"))).toContain("must be a mapping")
  })

  it("rejects a document nested too deep", () => {
    const deep = "name: x\njobs:\n  main:\n    steps:\n      - id: s\n        action:\n          uses: a@v1\n          with:\n            k: " +
      "[".repeat(70) + "1" + "]".repeat(70) + "\n"
    expect(messages(failed(deep))).toContain("nests deeper")
  })

  it("rejects an oversized document", () => {
    const source = `name: x\njobs: {}\n# ${"a".repeat(1_100_000)}`
    expect(messages(failed(source))).toContain("exceeds")
  })
})

describe("top-level shape", () => {
  it("requires name and jobs", () => {
    const text = messages(failed("on: [manual]\n"))
    expect(text).toContain('missing required field "name"')
    expect(text).toContain('missing required field "jobs"')
  })

  it("suggests the closest top-level field", () => {
    expect(messages(failed("name: x\njobz:\n  main:\n    steps: []\n"))).toContain('did you mean "jobs"?')
  })

  it("normalises omitted collections to empty", () => {
    const workflow = parsed("name: x\njobs:\n  main:\n    steps:\n      - id: s\n        human: {}\n")
    expect(workflow.on).toEqual([])
    expect(workflow.inputs).toEqual({})
    expect(workflow.roles).toEqual({})
    expect(workflow.jobs.main).toEqual({
      needs: [],
      outputs: {},
      steps: [{ id: "s", type: "human", outcomes: {}, retry: { strategy: "none" } }],
    })
  })

  it("parses an input literally named `__proto__` as a genuine own property, not a prototype reassignment", () => {
    const workflow = parsed(
      "name: x\ninputs:\n  __proto__: { type: string, required: true }\n  normal: { type: string, required: true }\n" +
        "jobs:\n  main:\n    steps:\n      - id: s\n        human: {}\n",
    )
    expect(Object.prototype.hasOwnProperty.call(workflow.inputs, "__proto__")).toBe(true)
    expect(workflow.inputs["__proto__"]).toEqual({ type: "string", presence: "required" })
    expect(Object.keys(workflow.inputs).sort()).toEqual(["__proto__", "normal"])
  })
})

describe("triggers", () => {
  it("parses the manual sugar and mapping forms", () => {
    const workflow = parsed(
      "name: x\non:\n  - manual\n  - { schedule: { cron: '0 6 * * *', missedFire: catch-up } }\n  - { event: push }\njobs:\n  main:\n    steps:\n      - id: s\n        human: {}\n",
    )
    expect(workflow.on).toEqual([
      { kind: "manual" },
      { kind: "schedule", cron: "0 6 * * *", missedFire: "catch-up" },
      { kind: "event", event: "push" },
    ])
  })

  it("rejects unknown trigger words and shapes", () => {
    expect(messages(failed("name: x\non: [webhook]\njobs: {}\n"))).toContain('unknown trigger "webhook"')
    expect(messages(failed("name: x\non: [{ schedule: { cron: 'x' } }]\njobs: {}\n"))).toContain(
      'missing required field "missedFire"',
    )
    expect(messages(failed("name: x\non: [{ schedule: { cron: 'x', missedFire: retry } }]\njobs: {}\n"))).toContain(
      "missedFire must be one of: skip, catch-up",
    )
    expect(messages(failed("name: x\non: manual\njobs: {}\n"))).toContain("on must be a list")
  })
})

describe("steps", () => {
  const wrap = (step: string): string =>
    `name: x\nroles:\n  r: { agent: build }\njobs:\n  main:\n    steps:\n${step}`

  it("rejects a step with no kind", () => {
    const errors = failed(wrap("      - id: s\n"))
    expect(messages(errors)).toContain("a step is exactly one kind — add one of: agent, command, action, human")
  })

  it("rejects a human gate with unknown fields", () => {
    const errors = failed(wrap("      - id: s\n        human:\n          question: approve?\n"))
    expect(messages(errors)).toContain('unknown field "question"')
  })

  it("accepts a fieldless human gate written as human: or human: {}", () => {
    expect(parsed(wrap("      - id: s\n        human: {}\n")).jobs.main!.steps[0]!.type).toBe("human")
    expect(parsed(wrap("      - id: s\n        human:\n")).jobs.main!.steps[0]!.type).toBe("human")
  })

  it("accepts a human gate with a prompt", () => {
    const step = parsed(wrap("      - id: s\n        human:\n          prompt: 'Answer: {{ inputs.q }}'\n")).jobs.main!.steps[0]!
    expect(step.type).toBe("human")
    expect((step as { prompt?: string }).prompt).toBe("Answer: {{ inputs.q }}")
  })

  it("rejects a non-string human prompt", () => {
    const errors = failed(wrap("      - id: s\n        human:\n          prompt: [a, b]\n"))
    expect(messages(errors)).toContain("human: prompt")
  })

  it("accepts interactive on agent steps, absent means autonomous", () => {
    const on = parsed(wrap("      - id: s\n        agent: { role: r, prompt: p, interactive: true }\n")).jobs.main!.steps[0]!
    expect(on).toMatchObject({ type: "agent", interactive: true })
    const off = parsed(wrap("      - id: s\n        agent: { role: r, prompt: p }\n")).jobs.main!.steps[0]!
    expect((off as { interactive?: boolean }).interactive).toBeUndefined()
  })

  it("rejects a non-boolean interactive", () => {
    const errors = failed(wrap("      - id: s\n        agent: { role: r, prompt: p, interactive: maybe }\n"))
    expect(messages(errors)).toContain("agent: interactive must be a boolean")
  })

  it("rejects interactive on non-agent step bodies", () => {
    const errors = failed(wrap("      - id: s\n        command:\n          run: [ls]\n          interactive: true\n"))
    expect(messages(errors)).toContain('unknown field "interactive"')
  })

  it("rejects timeoutMs below 1", () => {
    const errors = failed(wrap("      - id: s\n        command:\n          run: [ls]\n          timeoutMs: 0\n"))
    expect(messages(errors)).toContain("timeoutMs must be ≥ 1")
  })

  it("keeps action uses as an unresolved string and normalises with", () => {
    const workflow = parsed(wrap("      - id: s\n        action:\n          uses: git/push@v1\n"))
    expect(workflow.jobs.main!.steps[0]).toMatchObject({ type: "action", uses: "git/push@v1", with: {} })
  })

  it("preserves nested with values", () => {
    const workflow = parsed(
      wrap("      - id: s\n        action:\n          uses: a@v1\n          with:\n            flags: [1, two]\n            opts: { deep: true }\n"),
    )
    expect(workflow.jobs.main!.steps[0]).toMatchObject({ with: { flags: [1, "two"], opts: { deep: true } } })
  })
})

describe("routes and retry", () => {
  const wrap = (fragment: string): string =>
    `name: x\nroles:\n  r: { agent: build }\njobs:\n  main:\n    steps:\n      - id: a\n        agent: { role: r, prompt: p }\n      - id: s\n        agent: { role: r, prompt: p }\n${fragment}`

  it("parses next, goto and both rerun scopes", () => {
    const workflow = parsed(
      wrap(
        "        outcomes:\n          ok: next\n          back: { goto: a }\n          again: { rerun: { scope: steps, stepIds: [a], maxRounds: 2 } }\n",
      ),
    )
    expect(workflow.jobs.main!.steps[1]!.outcomes).toEqual({
      ok: { kind: "next" },
      back: { kind: "goto", stepId: "a" },
      again: { kind: "rerun", target: { scope: "steps", stepIds: ["a"], maxRounds: 2 } },
    })
  })

  it("rejects a route with both goto and rerun", () => {
    const errors = failed(
      wrap("        onFail:\n          goto: a\n          rerun: { scope: steps, stepIds: [a], maxRounds: 2 }\n"),
    )
    expect(messages(errors)).toContain("a route has exactly one key — goto or rerun")
  })

  it("rejects mismatched rerun scope fields", () => {
    const errors = failed(
      wrap("        onFail: { rerun: { scope: steps, jobIds: [other], maxRounds: 2 } }\n"),
    )
    expect(messages(errors)).toContain("jobIds is for scope: jobs")
  })

  it("rejects a constant backoff with exponential fields", () => {
    const errors = failed(
      wrap("        retry:\n          maxAttempts: 2\n          backoff: { strategy: constant, delay: 10, initial: 5 }\n"),
    )
    expect(messages(errors)).toContain("initial is for strategy: exponential")
  })

  it("rejects a non-integer maxRounds", () => {
    const errors = failed(wrap("        onFail: { rerun: { scope: steps, stepIds: [a], maxRounds: 1.5 } }\n"))
    expect(messages(errors)).toContain("maxRounds must be an integer")
  })
})

describe("the docs' feature-delivery example — YAML vs hand-built IR", () => {
  it("normalises to the exact IR reference.test.ts builds by hand", async () => {
    const workflow = parsed(await fixture("valid/feature-delivery.yaml"))

    expect(workflow.name).toBe("feature-delivery")
    expect(workflow.on).toEqual([{ kind: "manual" }])
    expect(workflow.inputs).toEqual({ feature: { type: "string", presence: "required" } })
    expect(Object.keys(workflow.roles)).toEqual(["architect", "judge", "implementer", "quality", "reviewer"])
    expect(workflow.roles.architect).toEqual({ agent: "build", model: "prov/architect" })

    expect(Object.keys(workflow.jobs)).toEqual(["architect-a", "architect-b", "consensus", "deliver"])
    expect(workflow.jobs["architect-a"]!.outputs).toEqual({ design: "{{ steps.design.outputs.report }}" })
    expect(workflow.jobs.consensus!.needs).toEqual(["architect-a", "architect-b"])
    expect(workflow.jobs.consensus!.steps[0]!.outcomes).toEqual({
      approved: { kind: "next" },
      changes_requested: {
        kind: "rerun",
        target: { scope: "jobs", jobIds: ["architect-a", "architect-b"], maxRounds: 5 },
      },
    })

    const deliver = workflow.jobs.deliver!
    expect(deliver.needs).toEqual(["consensus"])
    expect(deliver.steps.map(step => step.id)).toEqual([
      "worktree",
      "openspec",
      "implement",
      "quality",
      "internal-review",
      "push",
      "pr-review",
      "merge",
    ])
    expect(deliver.steps.map(step => step.type)).toEqual([
      "command",
      "agent",
      "agent",
      "agent",
      "agent",
      "action",
      "human",
      "action",
    ])
    expect(deliver.steps[6]!.outcomes).toEqual({
      approved: { kind: "next" },
      rejected: {
        kind: "rerun",
        target: { scope: "steps", stepIds: ["implement", "quality", "internal-review"], maxRounds: 3 },
      },
    })
    expect(deliver.steps[7]).toEqual({
      id: "merge",
      type: "action",
      uses: "git/pr-merge@v1",
      with: { method: "squash" },
      outcomes: {},
      retry: { strategy: "backoff", maxAttempts: 3, backoff: { strategy: "constant", delay: 30000 } },
    })

    expect(validateWorkflow(workflow)).toEqual({ errors: [], warnings: [] })
  })
})
