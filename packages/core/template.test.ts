import { describe, expect, it } from "bun:test"
import { render } from "./src/template.ts"

describe("render", () => {
  it("renders a simple placeholder", () => {
    expect(render("hello {{name}}", { name: "world" }).text).toBe("hello world")
  })

  it("leaves text without placeholders untouched", () => {
    expect(render("plain text", {}).text).toBe("plain text")
  })

  it("replaces missing placeholders with empty string and reports them", () => {
    const r = render("a={{a}} b={{b}}", { a: 1 })
    expect(r.text).toBe("a=1 b=")
    expect(r.missing).toEqual(["b"])
  })
})
