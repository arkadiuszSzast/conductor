import { describe, expect, it } from "bun:test"
import {
  buildActionRegistry,
  computeActionDigest,
  parseActionRef,
  resolveAction,
  validateActionInputs,
  validateActionManifest,
} from "./src/action.ts"
import { parseActionManifest } from "./src/action-manifest.ts"
import type {
  ActionCapability,
  ActionManifest,
  ActionRegistry,
  ActionRegistryEntry,
} from "./src/action.ts"

const fixture = (name: string): Promise<string> =>
  Bun.file(new URL(`fixtures/actions/${name}`, import.meta.url)).text()

function manifest(overrides: Partial<ActionManifest> = {}): ActionManifest {
  return {
    name: "git/push",
    version: "1.0.0",
    inputs: {},
    outputs: {},
    capabilities: [],
    run: { kind: "process", command: ["bun", "run", "main.ts"] },
    ...overrides,
  }
}

function entry(value: ActionManifest, sourcePath?: string): ActionRegistryEntry {
  return { manifest: value, ...(sourcePath !== undefined ? { sourcePath } : {}) }
}

function pushRegistry(sourcePath?: string): ActionRegistry {
  return buildActionRegistry([
    entry(manifest({ version: "1.0.0" }), sourcePath),
    entry(manifest({ version: "1.0.1" }), sourcePath),
    entry(manifest({ version: "1.2.0" }), sourcePath),
    entry(manifest({ version: "2.0.0" }), sourcePath),
  ])
}

function pushV1Registry(sourcePath?: string): ActionRegistry {
  return buildActionRegistry([
    entry(manifest({ version: "1.0.0" }), sourcePath),
    entry(manifest({ version: "1.0.1" }), sourcePath),
    entry(manifest({ version: "1.2.0" }), sourcePath),
  ])
}

// ---------------------------------------------------------------------------
// parseActionRef
// ---------------------------------------------------------------------------

describe("parseActionRef", () => {
  it("parses a major reference", () => {
    const result = parseActionRef("git/push@v1")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref).toEqual({ name: "git/push", versionRef: [1] })
  })

  it("parses minor and exact references", () => {
    const result = parseActionRef("git/push@v1.2.3")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.versionRef).toEqual([1, 2, 3])
    const minor = parseActionRef("git/push@v1.2")
    expect(minor.ok).toBe(true)
    if (minor.ok) expect(minor.ref.versionRef).toEqual([1, 2])
  })

  it("accepts a single-segment name", () => {
    const result = parseActionRef("worktree@v1")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.name).toBe("worktree")
  })

  it("rejects a reference without a version", () => {
    const result = parseActionRef("git/push")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('expected <name>@v<version>')
  })

  it("rejects an empty name", () => {
    const result = parseActionRef("@v1")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('invalid action name ""')
  })

  it("rejects an empty or malformed version", () => {
    for (const uses of ["git/push@", "git/push@v", "git/push@1", "git/push@v1.2.3.4"]) {
      const result = parseActionRef(uses)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("invalid action version")
    }
  })

  it("rejects an uppercase name", () => {
    const result = parseActionRef("Git/Push@v1")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('invalid action name "Git/Push"')
  })
})

// ---------------------------------------------------------------------------
// resolveAction
// ---------------------------------------------------------------------------

describe("resolveAction", () => {
  it("resolves a major reference to the highest version on the line", () => {
    const result = resolveAction("git/push@v1", pushRegistry())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.version).toBe("1.2.0")
  })

  it("resolves minor and exact references", () => {
    const registry = pushRegistry()
    const minor = resolveAction("git/push@v1.0", registry)
    expect(minor.ok).toBe(true)
    if (minor.ok) expect(minor.manifest.version).toBe("1.0.1")
    const exact = resolveAction("git/push@v1.0.0", registry)
    expect(exact.ok).toBe(true)
    if (exact.ok) expect(exact.manifest.version).toBe("1.0.0")
  })

  it("returns a deterministic content digest", () => {
    const first = resolveAction("git/push@v1", pushRegistry())
    const second = resolveAction("git/push@v1", pushRegistry())
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.digest).toBe(second.digest)
      expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("computes the same digest regardless of key insertion order", () => {
    const reordered = manifest({
      version: "1.2.0",
      inputs: { force: { type: "boolean", presence: "optional", default: false }, remote: { type: "string", presence: "optional", default: "origin" } },
    })
    const baseline = manifest({
      inputs: { remote: { type: "string", presence: "optional", default: "origin" }, force: { type: "boolean", presence: "optional", default: false } },
      version: "1.2.0",
    })
    expect(computeActionDigest(reordered)).toBe(computeActionDigest(baseline))
  })

  it("changes the digest when the manifest content changes", () => {
    const baseline = computeActionDigest(manifest({ version: "1.0.0" }))
    const bumped = computeActionDigest(manifest({ version: "1.0.1" }))
    const extraCapability = computeActionDigest(manifest({ capabilities: ["git"] }))
    expect(bumped).not.toBe(baseline)
    expect(extraCapability).not.toBe(baseline)
  })

  it("names the searched paths when the action is missing", () => {
    const registry = buildActionRegistry([
      entry(manifest({ name: "git/worktree", version: "1.0.0" }), "actions/git/worktree@v1.0.0/action.yaml"),
    ])
    const result = resolveAction("git/push@v1", registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('no entry named "git/push"')
      expect(result.error).toContain("searched paths: actions/git/worktree@v1.0.0/action.yaml")
      expect(result.error).toContain("registry provides: git/worktree")
    }
  })

  it("reports an empty registry explicitly", () => {
    const result = resolveAction("git/push@v1", {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('action "git/push@v1" is not in the registry')
      expect(result.error).toContain("searched paths: none — the registry is empty")
    }
  })

  it("names the searched paths and available versions when the version is missing", () => {
    const registry = buildActionRegistry([
      entry(manifest({ version: "1.10.0" }), "bundled:git/push"),
      ...Object.values(pushV1Registry("bundled:git/push")).flat(),
    ])
    const result = resolveAction("git/push@v2", registry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('"git/push" has no v2')
      expect(result.error).toContain("searched paths: bundled:git/push")
      expect(result.error).toContain("available: v1 (1.0.0, 1.0.1, 1.2.0, 1.10.0)")
    }
  })

  it("falls back to name@version when an entry has no source path", () => {
    const result = resolveAction("git/push@v2", pushV1Registry())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("searched paths: git/push@v1.0.0")
  })

  it("surfaces a malformed reference", () => {
    const result = resolveAction("git/push", pushRegistry())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('invalid action reference "git/push"')
  })

  it("resolves without an available version when the registry has an unrelated name", () => {
    const result = resolveAction("git/push@v1", buildActionRegistry([entry(manifest({ name: "git/worktree" }))]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no entry named "git/push"')
  })

  it("safeError for a missing action omits every searched path while keeping the reference, name and registry contents", () => {
    const registry = buildActionRegistry([
      entry(manifest({ name: "git/worktree", version: "1.0.0" }), "/opt/conductor/actions/bundled/git-worktree/action.yaml"),
    ])
    const result = resolveAction("git/push@v1", registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.safeError).toContain('no entry named "git/push"')
    expect(result.safeError).toContain("registry provides: git/worktree")
    expect(result.safeError).not.toContain("/opt/conductor/actions")
    expect(result.safeError).not.toContain("searched paths")
    // The rich `error` still names the path — only `safeError` strips it.
    expect(result.error).toContain("/opt/conductor/actions")
  })

  it("safeError for an empty registry omits the empty-registry path phrasing but keeps the reason", () => {
    const result = resolveAction("git/push@v1", {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.safeError).toContain('action "git/push@v1" is not in the registry')
    expect(result.safeError).not.toContain("searched paths")
  })

  it("safeError for a missing version omits every searched path while keeping the available versions", () => {
    const registry = buildActionRegistry([
      entry(manifest({ version: "1.10.0" }), "/opt/conductor/actions/bundled/git-push/action.yaml"),
      ...Object.values(pushV1Registry("/opt/conductor/actions/bundled/git-push/action.yaml")).flat(),
    ])
    const result = resolveAction("git/push@v2", registry)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.safeError).toContain('"git/push" has no v2')
    expect(result.safeError).toContain("available: v1 (1.0.0, 1.0.1, 1.2.0, 1.10.0)")
    expect(result.safeError).not.toContain("/opt/conductor/actions")
    expect(result.safeError).not.toContain("searched paths")
    expect(result.error).toContain("/opt/conductor/actions")
  })

  it("safeError for a malformed reference equals error — parsing never produced a path", () => {
    const result = resolveAction("git/push", pushRegistry())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.safeError).toBe(result.error)
    expect(result.safeError).toContain('invalid action reference "git/push"')
  })
})

// ---------------------------------------------------------------------------
// validateActionManifest
// ---------------------------------------------------------------------------

describe("validateActionManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateActionManifest(manifest({
      inputs: {
        remote: { type: "string", presence: "required" },
        paths: { type: "string[]", presence: "optional", default: [] },
      },
      outputs: { sha: "string" },
      capabilities: ["git", "filesystem"] as readonly ActionCapability[],
    }))).toEqual([])
  })

  it("rejects an uppercase or empty name", () => {
    expect(validateActionManifest(manifest({ name: "Git/Push" })).join("\n")).toContain('"name" must be lowercase')
    expect(validateActionManifest(manifest({ name: "" })).join("\n")).toContain('"name" must be lowercase')
  })

  it("rejects a version that is not major.minor.patch", () => {
    for (const version of ["1.2", "1", "v1.2.0", "1.2.3.4"]) {
      expect(validateActionManifest(manifest({ version })).join("\n")).toContain('"version" must be "<major>.<minor>.<patch>"')
    }
  })

  it("rejects an unknown capability", () => {
    const errors = validateActionManifest(manifest({ capabilities: ["network", "root"] as unknown as readonly ActionCapability[] }))
    expect(errors.join("\n")).toContain('capability "root" is not in the capability vocabulary')
    expect(errors.join("\n")).toContain("filesystem, process, network, git, credentials")
  })

  it("rejects inputs with both required and default, and with neither", () => {
    const errors = validateActionManifest({
      ...manifest(),
      inputs: {
        remote: { type: "string", presence: "required", default: "origin" },
        branch: { type: "string", presence: "optional" },
      },
    } as unknown as ActionManifest)
    expect(errors.join("\n")).toContain('input "remote": required and default are mutually exclusive')
    expect(errors.join("\n")).toContain('input "branch": an optional input must declare a default')
    const unknownPresence = validateActionManifest({
      ...manifest(),
      inputs: { remote: { type: "string", presence: "bogus" } },
    } as unknown as ActionManifest)
    expect(unknownPresence.join("\n")).toContain('input "remote": presence must be "required" or "optional"')
  })

  it("rejects a default that mismatches the declared type", () => {
    const errors = validateActionManifest({
      ...manifest(),
      inputs: { remote: { type: "number", presence: "optional", default: "origin" } },
    })
    expect(errors.join("\n")).toContain('input "remote": default must match the declared type number')
  })

  it("rejects unknown input and output types", () => {
    const inputs = validateActionManifest({
      ...manifest(),
      inputs: { remote: { type: "regexp" } as unknown as never },
    })
    expect(inputs.join("\n")).toContain('input "remote": type must be one of: string, number, boolean')
    const outputs = validateActionManifest({ ...manifest(), outputs: { sha: "blob" } })
    expect(outputs.join("\n")).toContain('output "sha": type must be one of: string, number, boolean')
  })

  it("rejects a malformed execution entry point", () => {
    expect(validateActionManifest({ ...manifest(), run: {} }).join("\n")).toContain('manifest "run" must be')
    expect(validateActionManifest({ ...manifest(), run: { kind: "process", command: [] } }).join("\n")).toContain("non-empty list")
    expect(validateActionManifest({ ...manifest(), run: { kind: "inprocess", handler: "  " } }).join("\n")).toContain("non-empty string")
  })

  it("rejects a non-mapping manifest", () => {
    expect(validateActionManifest([]).join("\n")).toContain("an action manifest must be a mapping")
  })
})

// ---------------------------------------------------------------------------
// validateActionInputs — the `with:` check at reservation
// ---------------------------------------------------------------------------

describe("validateActionInputs", () => {
  const push = manifest({
    inputs: {
      remote: { type: "string", presence: "required" },
      force: { type: "boolean", presence: "optional", default: false },
      paths: { type: "string[]", presence: "optional", default: [] },
    },
  })

  it("accepts literal values matching the typed inputs", () => {
    expect(validateActionInputs(push, { remote: "origin", force: true, paths: ["a", "b"] })).toEqual([])
  })

  it("rejects an undeclared input naming the declared ones", () => {
    const errors = validateActionInputs(push, { remote: "origin", force2: true })
    expect(errors.join("\n")).toContain('input "force2" is not declared')
    expect(errors.join("\n")).toContain("declared inputs: remote, force, paths")
  })

  it("rejects a missing required input", () => {
    expect(validateActionInputs(push, { force: true }).join("\n")).toContain('input "remote" is required')
  })

  it("rejects a value of the wrong type", () => {
    const errors = validateActionInputs(push, { remote: 123 })
    expect(errors.join("\n")).toContain('input "remote" must be a string — got 123')
    expect(validateActionInputs(push, { remote: "origin", force: "yes" }).join("\n")).toContain('input "force" must be a boolean')
    expect(validateActionInputs(push, { remote: "origin", paths: "single" }).join("\n")).toContain('input "paths" must be a string[]')
  })

  it("rejects an explicit null as a type mismatch", () => {
    const errors = validateActionInputs(push, { remote: null })
    expect(errors.join("\n")).toContain('input "remote" must be a string — got null')
  })

  it("rejects non-finite numbers in scalar and array inputs", () => {
    const numeric = manifest({
      inputs: {
        count: { type: "number", presence: "required" },
        values: { type: "number[]", presence: "required" },
      },
    })
    expect(validateActionInputs(numeric, { count: Number.NaN, values: [1] }).join("\n")).toContain('input "count" must be a number')
    expect(validateActionInputs(numeric, { count: 1, values: [Number.POSITIVE_INFINITY] }).join("\n")).toContain('input "values" must be a number[]')
  })

  it("defers the type check of a template value", () => {
    expect(validateActionInputs(manifest({ inputs: { count: { type: "number", presence: "required" } } }), {
      count: "{{ inputs.count }}",
    })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Golden fixtures
// ---------------------------------------------------------------------------

describe("action manifest fixtures", () => {
  it("parses and validates the valid fixtures", async () => {
    const cases = ["git-push", "minimal", "git-worktree"]
    for (const name of cases) {
      const parsed = parseActionManifest(await fixture(`valid/${name}.yaml`))
      expect(parsed.ok, `${name} parses`).toBe(true)
      if (!parsed.ok) continue
      expect(validateActionManifest(parsed.manifest), `${name} validates`).toEqual([])
    }
  })

  it("resolves a valid fixture through the registry with a deterministic digest", async () => {
    const parsed = parseActionManifest(await fixture("valid/git-push.yaml"))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const registry = buildActionRegistry([entry(parsed.manifest, "actions/git/push@v1.2.0/action.yaml")])
    const resolved = resolveAction("git/push@v1", registry)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.manifest.version).toBe("1.2.0")
      expect(resolved.digest).toBe(computeActionDigest(parsed.manifest))
    }
  })

  it("rejects the invalid fixtures with actionable diagnostics", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["unknown-field", "did you mean \"capabilities\""],
      ["bad-capability", "capabilities[1] must be one of"],
      ["bad-input-type", "default must be a number"],
      ["bad-run", "a subprocess needs a non-empty command"],
      ["input-xor", "required and default are mutually exclusive"],
    ]
    for (const [name, expected] of cases) {
      const parsed = parseActionManifest(await fixture(`invalid/${name}.yaml`))
      expect(parsed.ok, `${name} rejects`).toBe(false)
      if (!parsed.ok) {
        const text = parsed.errors.map(error => error.message).join("\n")
        expect(text).toContain(expected)
      }
    }
  })

  it("rejects version/name shape in validation, not parsing", async () => {
    for (const name of ["bad-version", "bad-name"]) {
      const parsed = parseActionManifest(await fixture(`invalid/${name}.yaml`))
      expect(parsed.ok, `${name} parses`).toBe(true)
      if (parsed.ok) expect(validateActionManifest(parsed.manifest).length).toBeGreaterThan(0)
    }
  })
})
