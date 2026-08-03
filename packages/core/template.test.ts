import { describe, expect, it } from "bun:test"
import { render } from "./src/template"

describe("render", () => {
  it("substitutes nested paths", () => {
    const result = render("PR #{{feature.pr}} on {{feature.branch}}", {
      feature: { pr: 42, branch: "feat/x" },
    })
    expect(result.text).toBe("PR #42 on feat/x")
    expect(result.missing).toEqual([])
  })

  it("reports missing variables and renders them empty", () => {
    const result = render("Fix this: {{steps.gate.output}}!", { steps: {} })
    expect(result.text).toBe("Fix this: !")
    expect(result.missing).toEqual(["steps.gate.output"])
  })

  it("tolerates whitespace inside braces", () => {
    const result = render("{{ feature.slug }}", { feature: { slug: "s" } })
    expect(result.text).toBe("s")
  })

  it("stringifies non-string values", () => {
    const result = render("{{data}}", { data: { a: 1 } })
    expect(result.text).toBe('{"a":1}')
  })

  it("leaves text without variables untouched", () => {
    const result = render("no vars here", {})
    expect(result.text).toBe("no vars here")
  })
})
