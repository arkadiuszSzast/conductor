/**
 * Guards the extraction constraints for the legacy compatibility engine:
 * no opencode SDK imports, no process-wide globals/timers, no daemon
 * lifecycle/API coupling, no host-specific paths, no hardcoded model
 * gateway. Every side effect must cross an injected port.
 */
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const LEGACY_DIR = join(import.meta.dirname, "src", "legacy")

function legacySourceFiles(): string[] {
  return readdirSync(LEGACY_DIR)
    .filter(name => name.endsWith(".ts"))
    .map(name => join(LEGACY_DIR, name))
}

/** Strips block and line comments so assertions check actual code, not prose that explains a constraint. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("legacy engine extraction constraints", () => {
  it("never imports the opencode SDK or plugin API", () => {
    for (const file of legacySourceFiles()) {
      const source = readFileSync(file, "utf-8")
      expect(source).not.toMatch(/from\s+["']@opencode-ai/)
      expect(source).not.toMatch(/from\s+["']opencode\/plugin/)
    }
  })

  it("only ports.ts's systemClock touches Date.now()", () => {
    for (const file of legacySourceFiles()) {
      if (file.endsWith("ports.ts")) continue
      const source = codeOnly(readFileSync(file, "utf-8"))
      expect(source).not.toMatch(/Date\.now\(\)/)
    }
  })

  it("never falls back to process.cwd() as an implicit default", () => {
    for (const file of legacySourceFiles()) {
      const source = codeOnly(readFileSync(file, "utf-8"))
      expect(source).not.toMatch(/process\.cwd\(\)/)
    }
  })

  it("only process.ts touches node:child_process directly", () => {
    for (const file of legacySourceFiles()) {
      if (file.endsWith("process.ts")) continue
      const source = codeOnly(readFileSync(file, "utf-8"))
      expect(source).not.toMatch(/from\s+["']node:child_process["']/)
    }
  })

  it("never references a home directory or a hardcoded model gateway host", () => {
    for (const file of legacySourceFiles()) {
      const source = codeOnly(readFileSync(file, "utf-8"))
      expect(source).not.toMatch(/homedir\(\)/)
      expect(source).not.toMatch(/https?:\/\/[a-z0-9.-]*\.(openai|anthropic)\.com/i)
    }
  })

  it("builtins never call a global runShell — only the injected ProcessRunner", () => {
    const source = codeOnly(readFileSync(join(LEGACY_DIR, "builtins.ts"), "utf-8"))
    expect(source).not.toMatch(/\brunShell\(/)
    expect(source).toMatch(/ctx\.process\.(shell|exec)\(/)
  })
})
