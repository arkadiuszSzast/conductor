import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ProjectConfigRegistry } from "./src/project-config-registry.ts"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { Engine } from "./src/engine/engine.ts"
import type { GhClient, CheckSummary, PrView, ProcessExecOptions, ProcessExecResult, ProcessRunner, SessionClient } from "./src/engine/ports.ts"

const temporaryDirectories: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeProjectConfig(projectDir: string, content: unknown): string {
  const configDir = join(projectDir, ".opencode")
  mkdirSync(configDir, { recursive: true })
  const file = join(configDir, "conductor.json")
  writeFileSync(file, JSON.stringify(content, null, 2))
  return file
}

function writeGlobalConfig(globalDir: string, content: unknown): string {
  mkdirSync(globalDir, { recursive: true })
  const file = join(globalDir, "conductor.json")
  writeFileSync(file, JSON.stringify(content, null, 2))
  return file
}

const minimalPipeline = {
  roles: { implementer: { agent: "build" } },
  pipeline: [{ id: "implement", type: "agent", role: "implementer" }],
}

describe("ProjectConfigRegistry: register/resolve", () => {
  it("registers a project with a valid config and resolves it", () => {
    const project = tempDir("conductor-registry-")
    writeProjectConfig(project, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })

    const result = registry.register(project)
    expect(result.ok).toBe(true)
    const resolved = registry.resolve(project)
    expect(resolved?.pipeline).toHaveLength(1)
    expect(resolved?.roles.implementer?.agent).toBe("build")
  })

  it("resolves an unregistered project to null", () => {
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.resolve("/tmp/never-registered")).toBeNull()
  })

  it("register fails loudly when the project directory does not exist", () => {
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(join(tmpdir(), "conductor-does-not-exist-xyz"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.message).toMatch(/does not exist/)
    expect(registry.getStatus(join(tmpdir(), "conductor-does-not-exist-xyz")).state).toBe("invalid")
  })

  it("register fails when the project has no config and no defaults produce a runnable pipeline", () => {
    const project = tempDir("conductor-empty-")
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(d => d.message.includes("pipeline is empty"))).toBe(true)
  })

  it("register rejects malformed JSON with a diagnostic naming the file", () => {
    const project = tempDir("conductor-badjson-")
    const configDir = join(project, ".opencode")
    mkdirSync(configDir, { recursive: true })
    const file = join(configDir, "conductor.json")
    writeFileSync(file, "{ not valid json")
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics[0]?.sourcePath).toBe(file)
      expect(result.diagnostics[0]?.message).toMatch(/cannot parse JSON/)
    }
  })

  it("rejects a config file that is not a JSON object", () => {
    const project = tempDir("conductor-notobj-")
    const configDir = join(project, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "conductor.json"), JSON.stringify(["not", "an", "object"]))
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.message).toMatch(/must be a JSON object/)
  })

  it("defensively rejects unknown JS shapes before casting (non-string role agent)", () => {
    const project = tempDir("conductor-badshape-")
    writeProjectConfig(project, { roles: { implementer: { agent: 42 } }, pipeline: [{ id: "s", type: "agent", role: "implementer" }] })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(d => d.message.includes('"agent"'))).toBe(true)
  })

  it("defensively rejects a pipeline that is not an array", () => {
    const project = tempDir("conductor-badpipeline-")
    writeProjectConfig(project, { roles: {}, pipeline: { not: "an array" } })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(d => d.message.includes('"pipeline" must be an array'))).toBe(true)
  })

  it("rejects an unknown builtin action rather than casting it blindly", () => {
    const project = tempDir("conductor-badaction-")
    writeProjectConfig(project, {
      roles: {},
      pipeline: [{ id: "s", type: "builtin", action: "definitely.not.a.real.action" }],
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(d => d.message.includes("must be one of"))).toBe(true)
  })

  it("runs structural validation after assembly and reports goto errors", () => {
    const project = tempDir("conductor-badgoto-")
    writeProjectConfig(project, {
      roles: { implementer: { agent: "build" } },
      pipeline: [{ id: "s", type: "agent", role: "implementer", then: "nowhere" }],
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(d => d.message.includes("does not exist"))).toBe(true)
  })
})

describe("ProjectConfigRegistry: merge semantics", () => {
  it("merges global and project roles per-key, project wins on overlap", () => {
    const globalDir = tempDir("conductor-global-")
    writeGlobalConfig(globalDir, { roles: { implementer: { agent: "build", model: "global-model" }, fixer: { agent: "build" } } })
    const project = tempDir("conductor-merge-")
    writeProjectConfig(project, {
      roles: { implementer: { agent: "build", model: "project-model" } },
      pipeline: [{ id: "implement", type: "agent", role: "implementer" }],
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(globalDir, "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(true)
    const config = registry.resolve(project)
    expect(config?.roles.implementer?.model).toBe("project-model")
    expect(config?.roles.fixer?.agent).toBe("build")
  })

  it("pipeline replaces wholesale rather than splicing global + project", () => {
    const globalDir = tempDir("conductor-global-")
    writeGlobalConfig(globalDir, {
      roles: { a: { agent: "build" } },
      pipeline: [{ id: "global-step", type: "agent", role: "a" }],
    })
    const project = tempDir("conductor-replace-")
    writeProjectConfig(project, {
      roles: { a: { agent: "build" } },
      pipeline: [{ id: "project-step", type: "agent", role: "a" }],
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(globalDir, "conductor.json") })
    registry.register(project)
    const config = registry.resolve(project)
    expect(config?.pipeline.map(s => s.id)).toEqual(["project-step"])
  })

  it("scalar fields (baseBranch) override lowest-to-highest: preset < global < project", () => {
    const bundled = tempDir("conductor-presets-")
    writeFileSync(join(bundled, "solo.json"), JSON.stringify({ ...minimalPipeline, baseBranch: "preset-base" }))
    const globalDir = tempDir("conductor-global-")
    writeGlobalConfig(globalDir, { extends: "conductor:solo", baseBranch: "global-base" })
    const project = tempDir("conductor-scalar-")
    writeProjectConfig(project, { baseBranch: "project-base" })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(globalDir, "conductor.json"), bundledPresetDir: bundled })
    const result = registry.register(project)
    expect(result.ok).toBe(true)
    expect(registry.resolve(project)?.baseBranch).toBe("project-base")
  })

  it("resolves a bundled preset via conductor:<name> extends", () => {
    const bundled = tempDir("conductor-presets-")
    writeFileSync(join(bundled, "solo.json"), JSON.stringify(minimalPipeline))
    const project = tempDir("conductor-preset-")
    writeProjectConfig(project, { extends: "conductor:solo" })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json"), bundledPresetDir: bundled })
    const result = registry.register(project)
    expect(result.ok).toBe(true)
    expect(registry.resolve(project)?.pipeline).toHaveLength(1)
  })

  it("resolves a path-relative extends target relative to the project config file", () => {
    const project = tempDir("conductor-relext-")
    writeFileSync(join(project, "base.json"), JSON.stringify(minimalPipeline))
    writeProjectConfig(project, { extends: "../base.json" })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(true)
    expect(registry.resolve(project)?.pipeline).toHaveLength(1)
  })

  it("resolves named workflows, merging global and project workflow maps", () => {
    const globalDir = tempDir("conductor-global-")
    writeGlobalConfig(globalDir, { workflows: { hotfix: { pipeline: [{ id: "h", type: "agent", role: "a" }] } } })
    const project = tempDir("conductor-workflows-")
    writeProjectConfig(project, {
      roles: { a: { agent: "build" } },
      pipeline: [{ id: "implement", type: "agent", role: "a" }],
      workflows: { bugfix: { pipeline: [{ id: "b", type: "agent", role: "a" }] } },
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(globalDir, "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(true)
    const config = registry.resolve(project)
    expect(config?.resolvedWorkflows.hotfix?.[0]?.id).toBe("h")
    expect(config?.resolvedWorkflows.bugfix?.[0]?.id).toBe("b")
  })
})

describe("ProjectConfigRegistry: reload preserves last valid snapshot", () => {
  it("reload with a broken edit keeps serving the last valid config and reports status=stale", () => {
    const project = tempDir("conductor-reload-")
    const file = writeProjectConfig(project, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(project).ok).toBe(true)

    writeFileSync(file, "{ broken")
    const reloadResult = registry.reload(project)
    expect(reloadResult.ok).toBe(false)

    const resolved = registry.resolve(project)
    expect(resolved?.pipeline).toHaveLength(1)
    const status = registry.getStatus(project)
    expect(status.state).toBe("stale")
  })

  it("reload with a valid edit replaces the cached snapshot", () => {
    const project = tempDir("conductor-reload-ok-")
    const file = writeProjectConfig(project, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    registry.register(project)

    writeFileSync(file, JSON.stringify({ roles: { implementer: { agent: "build" } }, pipeline: [
      { id: "implement", type: "agent", role: "implementer" },
      { id: "extra", type: "agent", role: "implementer" },
    ] }))
    const result = registry.reload(project)
    expect(result.ok).toBe(true)
    expect(registry.resolve(project)?.pipeline).toHaveLength(2)
    expect(registry.getStatus(project).state).toBe("valid")
  })

  it("reload on a project that never had a valid config stays invalid, not stale", () => {
    const project = tempDir("conductor-neverok-")
    writeProjectConfig(project, { pipeline: [] })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(project).ok).toBe(false)
    expect(registry.getStatus(project).state).toBe("invalid")

    const secondAttempt = registry.reload(project)
    expect(secondAttempt.ok).toBe(false)
    expect(registry.getStatus(project).state).toBe("invalid")
  })
})

describe("ProjectConfigRegistry: unregister", () => {
  it("unregister makes the project resolve to null and status unregistered", () => {
    const project = tempDir("conductor-unreg-")
    writeProjectConfig(project, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    registry.register(project)
    expect(registry.resolve(project)).not.toBeNull()

    registry.unregister(project)
    expect(registry.resolve(project)).toBeNull()
    expect(registry.getStatus(project).state).toBe("unregistered")
  })
})

describe("ProjectConfigRegistry: canonicalization", () => {
  it("registering via a symlink and resolving via the real path return the same config", () => {
    const real = tempDir("conductor-real-")
    writeProjectConfig(real, minimalPipeline)
    const linkParent = tempDir("conductor-linkparent-")
    const link = join(linkParent, "link-to-real")
    symlinkSync(real, link)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })

    const result = registry.register(link)
    expect(result.ok).toBe(true)
    expect(registry.resolve(real)?.pipeline).toHaveLength(1)
    expect(registry.resolve(link)?.pipeline).toHaveLength(1)
  })

  it("registering both a symlink alias and the real path yields one registry entry", () => {
    const real = tempDir("conductor-one-entry-")
    writeProjectConfig(real, minimalPipeline)
    const linkParent = tempDir("conductor-linkparent2-")
    const link = join(linkParent, "alias")
    symlinkSync(real, link)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(link).ok).toBe(true)
    expect(registry.register(real).ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  it("a project whose directory later vanishes keeps serving the last valid snapshot as stale", () => {
    const parent = tempDir("conductor-vanishdir-")
    const project = join(parent, "project")
    mkdirSync(project)
    writeProjectConfig(project, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(project).ok).toBe(true)

    rmSync(project, { recursive: true, force: true })
    expect(registry.resolve(project)?.pipeline).toHaveLength(1)
    const reload = registry.reload(project)
    expect(reload.ok).toBe(false)
    expect(registry.getStatus(project).state).toBe("stale")
    expect(registry.resolve(project)?.pipeline).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
  })

  it("rejects a bundled preset name that tries to escape the preset directory", () => {
    const project = tempDir("conductor-escape-")
    writeProjectConfig(project, { extends: "conductor:../../../etc/passwd" })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.message).toContain("must match")
  })

  it("rejects unsafe __proto__ keys instead of polluting prototypes", () => {
    const project = tempDir("conductor-proto-")
    const configDir = join(project, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, "conductor.json"),
      '{"roles":{"__proto__":{"agent":"build"}},"pipeline":[{"id":"s","type":"agent","role":"implementer"}]}',
    )
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(d => d.message.includes("unsafe role name"))).toBe(true)
  })

  it("warns on unknown top-level keys without failing the load", () => {
    const project = tempDir("conductor-unknown-")
    writeProjectConfig(project, { ...minimalPipeline, dashboardPort: 4767, notify: { url: "http://localhost" } })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const result = registry.register(project)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.snapshot.warnings.some(w => w.includes('unknown field "dashboardPort"'))).toBe(true)
      expect(result.snapshot.warnings.some(w => w.includes('unknown field "notify"'))).toBe(true)
    }
  })
})

describe("ProjectConfigRegistry: list/getStatus", () => {
  it("list reports every registered project sorted by canonical path", () => {
    const projectA = tempDir("conductor-list-a-")
    const projectB = tempDir("conductor-list-b-")
    writeProjectConfig(projectA, minimalPipeline)
    writeProjectConfig(projectB, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    registry.register(projectB)
    registry.register(projectA)

    const listed = registry.list()
    expect(listed).toHaveLength(2)
    expect(listed.map(entry => entry.projectDir)).toEqual([...listed.map(entry => entry.projectDir)].sort())
    for (const entry of listed) expect(entry.status.state).toBe("valid")
  })

  it("getStatus on an unregistered project returns unregistered without touching disk", () => {
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.getStatus("/tmp/some/never/registered/dir")).toEqual({ state: "unregistered" })
  })
})

describe("ProjectConfigRegistry: deep freeze", () => {
  it("the resolved config is frozen and cannot be mutated by callers", () => {
    const project = tempDir("conductor-freeze-")
    writeProjectConfig(project, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    registry.register(project)
    const config = registry.resolve(project)
    expect(config).not.toBeNull()
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config?.pipeline)).toBe(true)
    expect(Object.isFrozen(config?.pipeline[0])).toBe(true)
    expect(Object.isFrozen(config?.roles)).toBe(true)
    expect(() => {
      "use strict"
      ;(config as { baseBranch: string }).baseBranch = "mutated"
    }).toThrow()
  })
})

describe("ProjectConfigRegistry: resolver is stable and disk-free", () => {
  it("resolver is the same closure reference across calls", () => {
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const first = registry.resolver
    const second = registry.resolver
    expect(first).toBe(second)
  })

  it("resolver does not read from disk once loaded — deleting the whole project after register does not affect resolve", () => {
    const parent = tempDir("conductor-diskfree-")
    const project = join(parent, "project")
    mkdirSync(project)
    writeProjectConfig(project, minimalPipeline)
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    registry.register(project)
    rmSync(project, { recursive: true, force: true })
    expect(registry.resolver(project)?.pipeline).toHaveLength(1)
  })
})

// --------------------------------------------------------------- engine integration

describe("ProjectConfigRegistry: engine integration", () => {
  class FakeGh implements GhClient {
    checks: CheckSummary = { allConcluded: false, anyFailed: false, failedNames: [] }
    view: PrView = { number: 1, headSha: "sha", state: "OPEN", mergeable: "MERGEABLE" }
    async prChecks(): Promise<CheckSummary> { return this.checks }
    async prView(): Promise<PrView> { return this.view }
    async prCreate(): Promise<number> { return 1 }
    async prMerge(): Promise<void> {}
    async unresolvedThreadCount(): Promise<number> { return 0 }
    async unresolvedThreads() { return [] }
    async resolveThread(): Promise<void> {}
    async replyToThread(): Promise<void> {}
    async reviewActivitySince(): Promise<number> { return 0 }
    async postComment() { return { ok: true as const } }
    async postReview() { return { ok: true as const } }
  }

  class FakeSessions implements SessionClient {
    private counter = 0
    prompts: Array<{ sessionID: string; text: string; agent?: string; model?: string }> = []
    async createSession(): Promise<{ id: string }> { return { id: `ses-${++this.counter}` } }
    async prompt(input: { sessionID: string; text: string; agent?: string; model?: string }): Promise<void> {
      this.prompts.push(input)
    }
    async note(): Promise<void> {}
    async sessionExists(): Promise<boolean> { return true }
    async status(): Promise<"busy" | "idle" | "retry" | "missing"> { return "busy" }
  }

  class FakeProcess implements ProcessRunner {
    async exec(_command: readonly string[], _options: ProcessExecOptions): Promise<ProcessExecResult> {
      return { code: 0, stdout: "", stderr: "", output: "" }
    }
    async shell(_command: string, _options: ProcessExecOptions): Promise<ProcessExecResult> {
      return { code: 0, stdout: "", stderr: "", output: "" }
    }
  }

  let directory: string
  let connection: DatabaseConnection
  let store: Store

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "conductor-registry-engine-"))
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
    store = new Store(connection.db)
  })

  afterEach(() => {
    connection.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it("the registry's resolver drives a real Engine dispatch end to end", async () => {
    const project = tempDir("conductor-engine-project-")
    writeProjectConfig(project, {
      roles: { implementer: { agent: "build" } },
      pipeline: [
        { id: "implement", type: "agent", role: "implementer" },
        { id: "cleanup", type: "builtin", action: "worktree.remove" },
      ],
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(project).ok).toBe(true)

    const engine = new Engine({
      store,
      resolveConfig: registry.resolver,
      gh: new FakeGh(),
      sessions: new FakeSessions(),
      process: new FakeProcess(),
      clock: { now: () => Date.now() },
      log: { log: () => {} },
    })

    const feature = store.createFeature({ title: "F", slug: "f", projectDir: project })
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("implement")

    const run = store.getActiveRun(feature.id)
    expect(run).not.toBeNull()
    await engine.report({ runId: run?.id ?? "", outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.status).toBe("done")
    expect(store.getFeature(feature.id)?.currentStep).toBeNull()
  })

  it("a project the registry never loaded makes the engine skip the feature (no config, no crash)", async () => {
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    const engine = new Engine({
      store,
      resolveConfig: registry.resolver,
      gh: new FakeGh(),
      sessions: new FakeSessions(),
      process: new FakeProcess(),
      clock: { now: () => Date.now() },
      log: { log: () => {} },
    })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/tmp/unregistered-project" })
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.currentStep).toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("running")
  })

  it("a valid reload that removes the active step escalates the feature instead of guessing", async () => {
    const project = tempDir("conductor-vanish-")
    const file = writeProjectConfig(project, {
      roles: { implementer: { agent: "build" } },
      pipeline: [
        { id: "implement", type: "agent", role: "implementer" },
        { id: "cleanup", type: "builtin", action: "worktree.remove" },
      ],
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(project).ok).toBe(true)
    const engine = new Engine({
      store,
      resolveConfig: registry.resolver,
      gh: new FakeGh(),
      sessions: new FakeSessions(),
      process: new FakeProcess(),
      clock: { now: () => Date.now() },
      log: { log: () => {} },
    })
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: project })
    await engine.dispatch(feature.id, { kind: "feature.start" })
    expect(store.getFeature(feature.id)?.currentStep).toBe("implement")

    writeFileSync(file, JSON.stringify({
      roles: { implementer: { agent: "build" } },
      pipeline: [{ id: "renamed", type: "agent", role: "implementer" }],
    }))
    expect(registry.reload(project).ok).toBe(true)

    store.finishRun(store.getActiveRun(feature.id)?.id ?? "", "reaped")
    await engine.reconcile()
    const after = store.getFeature(feature.id)
    expect(after?.status).toBe("escalated")
    expect(after?.escalation).toContain('current step "implement" no longer exists')
  })

  it("two active features from different projects run under their own configs", async () => {
    const projectA = tempDir("conductor-iso-a-")
    const projectB = tempDir("conductor-iso-b-")
    writeProjectConfig(projectA, {
      roles: { implementer: { agent: "agent-a", model: "model/a" } },
      pipeline: [{ id: "implement", type: "agent", role: "implementer" }],
    })
    writeProjectConfig(projectB, {
      roles: { implementer: { agent: "agent-b", model: "model/b" } },
      pipeline: [{ id: "implement", type: "agent", role: "implementer" }],
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(projectA).ok).toBe(true)
    expect(registry.register(projectB).ok).toBe(true)

    const sessions = new FakeSessions()
    const engine = new Engine({
      store,
      resolveConfig: registry.resolver,
      gh: new FakeGh(),
      sessions,
      process: new FakeProcess(),
      clock: { now: () => Date.now() },
      log: { log: () => {} },
    })
    const featureA = store.createFeature({ title: "A", slug: "a", projectDir: projectA })
    const featureB = store.createFeature({ title: "B", slug: "b", projectDir: projectB })
    await engine.dispatch(featureA.id, { kind: "feature.start" })
    await engine.dispatch(featureB.id, { kind: "feature.start" })
    expect(sessions.prompts.map(prompt => ({ agent: prompt.agent, model: prompt.model }))).toEqual([
      { agent: "agent-a", model: "model/a" },
      { agent: "agent-b", model: "model/b" },
    ])
  })

  it("reviewPublish.tokenCommand survives disk loading and reaches the engine config (seed regression)", () => {
    const project = tempDir("conductor-tokencmd-")
    writeProjectConfig(project, {
      roles: { implementer: { agent: "build" } },
      pipeline: [{ id: "implement", type: "agent", role: "implementer" }],
      reviewPublish: { mode: "github-review", tokenCommand: "gh auth token" },
    })
    const registry = new ProjectConfigRegistry({ globalConfigPath: join(tempDir("conductor-global-"), "conductor.json") })
    expect(registry.register(project).ok).toBe(true)
    const config = registry.resolver(project)
    expect(config?.reviewPublish?.tokenCommand).toBe("gh auth token")
    expect(config?.reviewPublish?.mode).toBe("github-review")
  })
})
