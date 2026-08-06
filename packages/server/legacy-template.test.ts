import { describe, expect, it } from "bun:test"
import { renderLegacy } from "./src/legacy/template.ts"

describe("renderLegacy", () => {
  it("substitutes nested paths and reports missing variables", () => {
    const { text, missing } = renderLegacy("Hi {{feature.title}}, step {{steps.gate.output}}", {
      feature: { title: "Add login" },
    })
    expect(text).toBe("Hi Add login, step ")
    expect(missing).toEqual(["steps.gate.output"])
  })

  it("stringifies non-string values", () => {
    const { text } = renderLegacy("{{feature.pr}}", { feature: { pr: 7 } })
    expect(text).toBe("7")
  })
})
