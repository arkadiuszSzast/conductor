/**
 * Guards the graph engine's extraction constraints: no opencode SDK
 * imports, no process-wide globals/timers, no host-specific paths, no
 * hardcoded model gateway. Every side effect the engine performs must
 * cross an injected port (`ports.ts`), not a global.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ENGINE_FILE = join(import.meta.dirname, "src/engine.ts")
const PORTS_FILE = join(import.meta.dirname, "src/ports.ts")
const PROCESS_FILE = join(import.meta.dirname, "src/process.ts")

/** Strips block and line comments so assertions check actual code, not prose that explains a constraint. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("graph engine extraction constraints", () => {
  it("never imports the opencode SDK or plugin API", () => {
    const source = readFileSync(ENGINE_FILE, "utf-8")
    expect(source).not.toMatch(/from\s+["']@opencode-ai/)
    expect(source).not.toMatch(/from\s+["']opencode\/plugin/)
  })

  it("only ports.ts's systemClock touches Date.now() — the engine reads time through the injected Clock", () => {
    const source = codeOnly(readFileSync(ENGINE_FILE, "utf-8"))
    expect(source).not.toMatch(/Date\.now\(\)/)
    expect(source).toMatch(/this\.deps\.clock\.now\(\)/)
  })

  it("never falls back to process.cwd() as an implicit default", () => {
    const source = codeOnly(readFileSync(ENGINE_FILE, "utf-8"))
    expect(source).not.toMatch(/process\.cwd\(\)/)
  })

  it("never touches node:child_process directly — only the injected ProcessRunner", () => {
    const source = codeOnly(readFileSync(ENGINE_FILE, "utf-8"))
    expect(source).not.toMatch(/from\s+["']node:child_process["']/)
    expect(source).toMatch(/\bprocess\.(shell|exec)\(/)
  })

  it("never references a home directory or a hardcoded model gateway host", () => {
    const source = codeOnly(readFileSync(ENGINE_FILE, "utf-8"))
    expect(source).not.toMatch(/homedir\(\)/)
    expect(source).not.toMatch(/https?:\/\/[a-z0-9.-]*\.(openai|anthropic)\.com/i)
  })

  it("holds no setInterval/setTimeout — the daemon owns every timer", () => {
    const source = codeOnly(readFileSync(ENGINE_FILE, "utf-8"))
    expect(source).not.toMatch(/\bsetInterval\(/)
    expect(source).not.toMatch(/\bsetTimeout\(/)
  })

  it("process.ts is the only file touching node:child_process for real execution", () => {
    const source = readFileSync(PROCESS_FILE, "utf-8")
    expect(source).toMatch(/from\s+["']node:child_process["']/)
  })

  it("ports.ts defines systemClock as the sole real Date.now() reader", () => {
    const source = readFileSync(PORTS_FILE, "utf-8")
    expect(source).toMatch(/Date\.now\(\)/)
  })
})
