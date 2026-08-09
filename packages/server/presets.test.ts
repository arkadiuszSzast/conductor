import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { validatePipeline } from "./src/engine/validate.ts"
import type { PipelineDef } from "./src/engine/types.ts"

const PRESET_DIR = path.join(import.meta.dirname, "presets")

describe("shipped presets", () => {
  const presets = readdirSync(PRESET_DIR).filter(f => f.endsWith(".json"))

  it("ships at least the three documented presets", () => {
    expect(presets).toContain("pr-loop-only.json")
    expect(presets).toContain("full-quality.json")
    expect(presets).toContain("solo-dev.json")
  })

  for (const file of presets) {
    it(`${file} parses and validates with zero errors`, () => {
      const def = JSON.parse(readFileSync(path.join(PRESET_DIR, file), "utf-8")) as PipelineDef
      const result = validatePipeline(def)
      expect(result.errors).toEqual([])
    })
  }
})
