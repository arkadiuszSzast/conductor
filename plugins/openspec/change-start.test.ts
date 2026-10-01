import { describe, expect, it } from "bun:test"
import { parseYamlObject } from "../../packages/core/src/index.ts"
import { MAX_OPENSPEC_YAML_BYTES, deriveChangeStart, parseDependsOn, readDependsOn, resolveChangeInput } from "./change-start.ts"

const PROPOSAL = "# Title\n\n## Why\n\nBecause reasons.\n\n## What Changes\n\n- stuff\n"

describe("deriveChangeStart", () => {
  it("derives the title from the change name and the description from the Why section", () => {
    expect(deriveChangeStart("add-change_queue", PROPOSAL)).toEqual({
      title: "Add Change Queue",
      description: "Because reasons.",
    })
  })

  it("falls back to the whole trimmed proposal when there is no Why section", () => {
    expect(deriveChangeStart("x", "  just text \n").description).toBe("just text")
  })

  it("omits the description when there is no proposal", () => {
    expect(deriveChangeStart("a-b", null)).toEqual({ title: "A B" })
    expect(deriveChangeStart("a-b", undefined)).toEqual({ title: "A B" })
  })

  it("fills change_slug, then change, only when declared as a string input", () => {
    expect(deriveChangeStart("c", PROPOSAL, { change_slug: { type: "string" } }).inputs).toEqual({ change_slug: "c" })
    expect(deriveChangeStart("c", PROPOSAL, { change: { type: "string" } }).inputs).toEqual({ change: "c" })
    expect(
      deriveChangeStart("c", PROPOSAL, { change: { type: "string" }, change_slug: { type: "string" } }).inputs,
    ).toEqual({ change_slug: "c" })
  })

  it("has no inputs field when nothing matches", () => {
    for (const projection of [undefined, null, "x", [], {}, { change: { type: "number" } }, { other: { type: "string" } }]) {
      expect("inputs" in deriveChangeStart("c", PROPOSAL, projection)).toBe(false)
      expect(resolveChangeInput("c", projection)).toBeNull()
    }
  })
})

describe("readDependsOn", () => {
  it("is [] when absent", () => {
    expect(readDependsOn(null)).toEqual({ ok: true, dependsOn: [] })
    expect(readDependsOn({ schema: "spec-driven" })).toEqual({ ok: true, dependsOn: [] })
    expect(readDependsOn({ depends_on: null })).toEqual({ ok: true, dependsOn: [] })
  })

  it("returns a list of strings", () => {
    expect(readDependsOn({ depends_on: ["a", "b"] })).toEqual({ ok: true, dependsOn: ["a", "b"] })
    expect(readDependsOn({ depends_on: [] })).toEqual({ ok: true, dependsOn: [] })
  })

  it("returns typed errors for malformed shapes without throwing", () => {
    expect(readDependsOn("text")).toMatchObject({ ok: false, error: { code: "not_a_mapping" } })
    expect(readDependsOn([1])).toMatchObject({ ok: false, error: { code: "not_a_mapping" } })
    expect(readDependsOn({ depends_on: "a" })).toMatchObject({ ok: false, error: { code: "not_a_list" } })
    expect(readDependsOn({ depends_on: { a: 1 } })).toMatchObject({ ok: false, error: { code: "not_a_list" } })
  })

  it("rejects non-string and empty items", () => {
    expect(readDependsOn({ depends_on: ["a", 1] })).toMatchObject({ ok: false, error: { code: "non_string_item" } })
    expect(readDependsOn({ depends_on: [null] })).toMatchObject({ ok: false, error: { code: "non_string_item" } })
    expect(readDependsOn({ depends_on: [{ a: 1 }] })).toMatchObject({ ok: false, error: { code: "non_string_item" } })
    expect(readDependsOn({ depends_on: ["  "] })).toMatchObject({ ok: false, error: { code: "non_string_item" } })
  })
})

describe("parseDependsOn with core's YAML parser", () => {
  it("parses a real .openspec.yaml", () => {
    expect(parseDependsOn("schema: spec-driven\ncreated: 2026-01-01\ndepends_on:\n  - a\n  - b\n", parseYamlObject)).toEqual({
      ok: true,
      dependsOn: ["a", "b"],
    })
    expect(parseDependsOn("depends_on: [a]\n", parseYamlObject)).toEqual({ ok: true, dependsOn: ["a"] })
  })

  it("is [] for an empty document or a missing key", () => {
    expect(parseDependsOn("", parseYamlObject)).toEqual({ ok: true, dependsOn: [] })
    expect(parseDependsOn("schema: spec-driven\n", parseYamlObject)).toEqual({ ok: true, dependsOn: [] })
  })

  it("maps unparsable YAML and a throwing parser to invalid_yaml", () => {
    expect(parseDependsOn("depends_on: [a\n", parseYamlObject)).toMatchObject({ ok: false, error: { code: "invalid_yaml" } })
    expect(
      parseDependsOn("x", () => {
        throw new Error("boom")
      }),
    ).toEqual({ ok: false, error: { code: "invalid_yaml", message: "boom" } })
  })

  it("flags non-string items from YAML", () => {
    expect(parseDependsOn("depends_on:\n  - a\n  - 3\n", parseYamlObject)).toMatchObject({
      ok: false,
      error: { code: "non_string_item" },
    })
  })
})

describe("parseDependsOn hardening", () => {
  it("refuses a file over 64 KiB without calling the parser", () => {
    let parsed = false
    const big = `depends_on: [a]\n# ${"x".repeat(MAX_OPENSPEC_YAML_BYTES)}\n`
    const result = parseDependsOn(big, () => {
      parsed = true
      return { ok: true, value: {} }
    })
    expect(result).toMatchObject({ ok: false, error: { code: "too_large" } })
    expect(parsed).toBe(false)
    expect(parseDependsOn(`depends_on: [a]\n# ${"x".repeat(1000)}\n`, parseYamlObject)).toEqual({ ok: true, dependsOn: ["a"] })
  })

  it("refuses anchors and aliases before parsing", () => {
    for (const source of [
      "base: &anchor [a]\ndepends_on: *anchor\n",
      "depends_on: &x [a, b]\n",
      "depends_on:\n  - *x\n",
      "depends_on: [*x]\n",
    ]) {
      let parsed = false
      const result = parseDependsOn(source, () => {
        parsed = true
        return { ok: true, value: {} }
      })
      expect(result).toMatchObject({ ok: false, error: { code: "yaml_anchors" } })
      expect(parsed).toBe(false)
    }
  })

  it("does not mistake comments or quoted text for anchors", () => {
    expect(parseDependsOn("# see &foo and *bar\ndepends_on: [a] # *note\n", parseYamlObject)).toEqual({ ok: true, dependsOn: ["a"] })
    expect(parseDependsOn("schema: spec-driven\ndescription: a&b*c\n", parseYamlObject)).toEqual({ ok: true, dependsOn: [] })
  })
})
