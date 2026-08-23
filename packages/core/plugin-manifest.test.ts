import { describe, expect, it } from "bun:test"
import { parsePluginManifest, SUPPORTED_PLUGIN_MANIFEST_VERSION, validatePluginManifest } from "./src/plugin-manifest.ts"
import type { ParsePluginManifestError, PluginManifest } from "./src/plugin-manifest.ts"

function parsed(source: string): PluginManifest {
  const result = parsePluginManifest(source)
  if (!result.ok) throw new Error(result.errors.map(error => error.message).join("\n"))
  return result.manifest
}

function failed(source: string): readonly ParsePluginManifestError[] {
  const result = parsePluginManifest(source)
  if (result.ok) throw new Error("expected parse errors, got a manifest")
  return result.errors
}

const messages = (errors: readonly ParsePluginManifestError[]): string => errors.map(error => error.message).join("\n")

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "openspec",
    version: 1,
    panel: { title: "OpenSpec" },
    capabilities: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parsePluginManifest
// ---------------------------------------------------------------------------

describe("parsePluginManifest", () => {
  it("parses a minimal manifest", () => {
    const manifest = parsed("plugin: openspec\nversion: 1\npanel:\n  title: OpenSpec\n")
    expect(manifest).toEqual({ id: "openspec", version: 1, panel: { title: "OpenSpec" }, capabilities: [] })
  })

  it("parses a full manifest with backend and capabilities", () => {
    const manifest = parsed(
      "plugin: openspec\n" +
        "version: 1\n" +
        "panel:\n  title: OpenSpec\n  icon: list\n" +
        "backend:\n  run: [bun, run, serve.ts]\n" +
        "capabilities: [filesystem, network]\n",
    )
    expect(manifest).toEqual({
      id: "openspec",
      version: 1,
      panel: { title: "OpenSpec", icon: "list" },
      backend: { run: ["bun", "run", "serve.ts"] },
      capabilities: ["filesystem", "network"],
    })
  })

  it("rejects a missing top-level field", () => {
    const errors = failed("version: 1\npanel:\n  title: OpenSpec\n")
    expect(messages(errors)).toContain('missing required field "plugin"')
  })

  it("rejects a missing panel.title", () => {
    const errors = failed("plugin: openspec\nversion: 1\npanel: {}\n")
    expect(messages(errors)).toContain('missing required field "title"')
  })

  it("rejects malformed YAML with the duplicate key's location", () => {
    const errors = failed("plugin: openspec\nplugin: openspec\nversion: 1\npanel:\n  title: OpenSpec\n")
    expect(messages(errors)).toContain("duplicate mapping key")
  })

  it("rejects an oversized document", () => {
    const source = `plugin: x\nversion: 1\npanel:\n  title: X\n# ${"a".repeat(1_100_000)}`
    expect(messages(failed(source))).toContain("exceeds")
  })

  it("rejects aliases and anchors", () => {
    const errors = failed(
      "plugin: openspec\nversion: 1\npanel: &p\n  title: OpenSpec\nextra: *p\n",
    )
    const text = messages(errors)
    expect(text.includes("anchors are not allowed") || text.includes("aliases are not allowed")).toBe(true)
  })

  it("rejects unknown top-level fields with a suggestion", () => {
    const errors = failed("pluging: openspec\nversion: 1\npanel:\n  title: OpenSpec\n")
    expect(messages(errors)).toContain('unknown field "pluging" — did you mean "plugin"?')
  })

  it("rejects a non-integer version", () => {
    const errors = failed("plugin: openspec\nversion: 1.5\npanel:\n  title: OpenSpec\n")
    expect(messages(errors)).toContain("manifest: version must be an integer")
  })

  it("rejects an empty backend.run", () => {
    const errors = failed("plugin: openspec\nversion: 1\npanel:\n  title: OpenSpec\nbackend:\n  run: []\n")
    expect(messages(errors)).toContain("backend: run must be a non-empty list")
  })

  it("rejects capabilities outside the vocabulary", () => {
    const errors = failed("plugin: openspec\nversion: 1\npanel:\n  title: OpenSpec\ncapabilities: [root]\n")
    expect(messages(errors)).toContain("capabilities[0] must be one of")
  })

  it("rejects a non-mapping document", () => {
    expect(messages(failed("- just\n- a\n- list\n"))).toContain("must be a mapping")
  })
})

// ---------------------------------------------------------------------------
// validatePluginManifest
// ---------------------------------------------------------------------------

describe("validatePluginManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validatePluginManifest(manifest())).toEqual([])
  })

  it("accepts a full manifest with backend and capabilities", () => {
    expect(validatePluginManifest(manifest({
      panel: { title: "OpenSpec", icon: "list" },
      backend: { run: ["bun", "run", "serve.ts"] },
      capabilities: ["filesystem", "network"],
    }))).toEqual([])
  })

  it("rejects a non-kebab-case id", () => {
    for (const id of ["OpenSpec", "open_spec", "open spec", "-openspec", "openspec-", ""]) {
      expect(validatePluginManifest(manifest({ id })).join("\n")).toContain('"id" must be kebab-case')
    }
  })

  it("rejects a non-integer or non-positive version", () => {
    for (const version of [0, -1, 1.5]) {
      expect(validatePluginManifest(manifest({ version })).join("\n")).toContain('"version" must be an integer >= 1')
    }
  })

  it("rejects an empty panel title", () => {
    expect(validatePluginManifest(manifest({ panel: { title: "" } })).join("\n")).toContain('"title" must be a non-empty string')
    expect(validatePluginManifest(manifest({ panel: { title: "   " } })).join("\n")).toContain('"title" must be a non-empty string')
  })

  it("rejects a non-mapping panel", () => {
    expect(validatePluginManifest({ ...manifest(), panel: null }).join("\n")).toContain('"panel" must be a mapping')
  })

  it("rejects empty backend.run", () => {
    expect(validatePluginManifest({ ...manifest(), backend: { run: [] } }).join("\n")).toContain('"backend.run" must be a non-empty list')
  })

  it("rejects non-string backend.run entries", () => {
    expect(validatePluginManifest({ ...manifest(), backend: { run: ["bun", ""] } }).join("\n")).toContain('"backend.run[1]" must be a non-empty string')
  })

  it("rejects capabilities outside the vocabulary", () => {
    const errors = validatePluginManifest(manifest({ capabilities: ["network", "root"] as unknown as PluginManifest["capabilities"] }))
    expect(errors.join("\n")).toContain('capability "root" is not in the capability vocabulary')
    expect(errors.join("\n")).toContain("filesystem, process, network, git, credentials")
  })

  it("rejects a non-mapping manifest", () => {
    expect(validatePluginManifest([]).join("\n")).toContain("a plugin manifest must be a mapping")
  })
})

// ---------------------------------------------------------------------------
// SUPPORTED_PLUGIN_MANIFEST_VERSION
// ---------------------------------------------------------------------------

describe("SUPPORTED_PLUGIN_MANIFEST_VERSION", () => {
  it("is 1", () => {
    expect(SUPPORTED_PLUGIN_MANIFEST_VERSION).toBe(1)
  })
})
