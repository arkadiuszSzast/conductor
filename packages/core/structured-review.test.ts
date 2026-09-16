import { expect, it } from "bun:test"
import { parseWorkflow, validateWorkflow } from "./src/index.ts"

const yaml = (fields = "") => `name: review
roles:
  worker: { agent: build }
jobs:
  main:
    steps:
      - id: implement
        agent:
          role: worker
          prompt: full
          fixFrom: main/review
          fixPrompt: fix
          ${fields}
      - id: review
        agent:
          role: worker
          prompt: review
          reviewHead: '${"a".repeat(40)}'
        outcomes:
          approved: next
          changes_requested:
            rerun: { scope: steps, stepIds: [implement, review], maxRounds: 3 }
`

it("parses and validates opt-in review/fix workflow", () => {
  const result = parseWorkflow(yaml())
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(validateWorkflow(result.workflow).errors).toEqual([])
  expect(result.workflow.jobs.main!.steps[0]).toMatchObject({ fixFrom: "main/review", fixPrompt: "fix" })
})

it("rejects invalid field shapes and unrelated feedback interpolation", () => {
  expect(parseWorkflow(yaml("qualityFrom: []")).ok).toBe(false)
  for (const document of [yaml("qualityFrom: missing/check"), yaml().replace("fixPrompt: fix", 'fixPrompt: "{{ feedback.message }}"'), yaml().replace("fixFrom: main/review", "fixFrom: main/implement"), yaml().replace("fixPrompt: fix", "")]) {
    const result = parseWorkflow(document)
    expect(result.ok).toBe(true)
    if (result.ok) expect(validateWorkflow(result.workflow).errors.length).toBeGreaterThan(0)
  }
})
