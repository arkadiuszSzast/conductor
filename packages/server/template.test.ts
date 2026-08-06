import { describe, expect, it } from "bun:test"
import { renderTemplate } from "./src/engine/template.ts"

describe("renderTemplate", () => {
  it("substitutes nested paths and reports missing variables", () => {
    const { text, missing } = renderTemplate("Hi {{feature.title}}, step {{steps.gate.output}}", {
      feature: { title: "Add login" },
    })
    expect(text).toBe("Hi Add login, step ")
    expect(missing).toEqual(["steps.gate.output"])
  })

  it("stringifies non-string values", () => {
    const { text } = renderTemplate("{{feature.pr}}", { feature: { pr: 7 } })
    expect(text).toBe("7")
  })
})
