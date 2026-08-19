import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadActionRegistry } from "./src/action-registry.ts"
import {
  actionBindingsForReconciler,
  checkWorkflowReservation,
} from "./src/workflow-reservation.ts"
import type { LoadedActionRegistry } from "./src/action-registry.ts"
import { resolveAction } from "@conductor/core"
import type { ActionStep, WorkflowDef } from "@conductor/core"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryRegistry(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "conductor-actions-"))
  temporaryDirectories.push(path)
  return path
}

async function writeManifest(root: string, directory: string, source: string): Promise<string> {
  const path = join(root, directory)
  await mkdir(path, { recursive: true })
  const sourcePath = join(path, "action.yaml")
  await writeFile(sourcePath, source)
  return sourcePath
}

function manifest(name: string, version: string, input = ""): string {
  return `name: ${name}
version: "${version}"
inputs:${input === "" ? " {}" : `\n${input}`}
outputs: {}
capabilities: []
run: [bun, run, main.ts]
`
}

function workflow(...steps: ActionStep[]): WorkflowDef {
  return {
    name: "reservation",
    on: [],
    inputs: {},
    roles: {},
    jobs: {
      main: {
        needs: [],
        outputs: {},
        steps,
      },
    },
  }
}

function actionStep(id: string, uses: string, withValues: Readonly<Record<string, unknown>> = {}): ActionStep {
  return {
    id,
    type: "action",
    uses,
    with: withValues,
    outcomes: {},
    retry: { strategy: "none" },
  }
}

async function load(
  baseDir: string,
  bundledPath: string,
  localPaths: readonly string[] = [],
): Promise<LoadedActionRegistry> {
  const result = await loadActionRegistry({ baseDir, bundledPath, localPaths })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.diagnostics.map(diagnostic => diagnostic.message).join("\n"))
  return result.value
}

describe("loadActionRegistry", () => {
  it("loads bundled and local registries in explicit precedence order", async () => {
    const root = await temporaryRegistry()
    const bundledSource = await writeManifest(root, "bundled/git-push", manifest("git/push", "1.0.0"))
    const localSource = await writeManifest(root, "local/github-pr", manifest("github/pr", "1.0.0"))
    const loaded = await load(root, "bundled", ["local"])

    expect(loaded.searchPaths).toEqual([
      { kind: "bundled", path: join(root, "bundled"), precedence: 0 },
      { kind: "local", path: join(root, "local"), precedence: 1 },
    ])
    expect(loaded.registry["git/push"]?.[0]?.sourcePath).toBe(bundledSource)
    expect(loaded.registry["github/pr"]?.[0]?.sourcePath).toBe(localSource)
  })

  it("loads action names that overlap object prototype properties", async () => {
    const root = await temporaryRegistry()
    await writeManifest(root, "bundled/constructor", manifest("constructor", "1.0.0"))
    await writeManifest(root, "bundled/proto", manifest("__proto__", "1.0.0"))
    const loaded = await load(root, "bundled")

    expect(loaded.registry["constructor"]?.[0]?.manifest.name).toBe("constructor")
    expect(loaded.registry["__proto__"]?.[0]?.manifest.name).toBe("__proto__")
  })

  it("lets later local paths override the same exact action version", async () => {
    const root = await temporaryRegistry()
    await writeManifest(root, "bundled/git-push", manifest("git/push", "1.0.0"))
    await writeManifest(root, "project/git-push", manifest("git/push", "1.0.0"))
    const localSource = await writeManifest(root, "local/git-push", manifest("git/push", "1.0.0"))
    const loaded = await load(root, "bundled", ["project", "local"])

    expect(loaded.registry["git/push"]).toHaveLength(1)
    expect(loaded.registry["git/push"]?.[0]?.sourcePath).toBe(localSource)
  })

  it("reports missing paths and malformed manifests", async () => {
    const root = await temporaryRegistry()
    const malformed = await writeManifest(root, "bundled/bad", "name: bad\nname: duplicate\n")
    const missing = join(root, "missing")
    const result = await loadActionRegistry({ baseDir: root, bundledPath: "bundled", localPaths: ["missing"] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map(diagnostic => diagnostic.sourcePath)).toEqual([malformed, missing])
    expect(result.diagnostics[0]?.message).toContain("duplicate mapping key")
    expect(result.diagnostics[1]?.message).toContain("cannot access registry search path")
  })

  it("reports symbolic links instead of silently skipping registry entries", async () => {
    const root = await temporaryRegistry()
    const target = await temporaryRegistry()
    await mkdir(join(root, "bundled"), { recursive: true })
    await writeManifest(target, "shared", manifest("git/push", "1.0.0"))
    const link = join(root, "bundled", "shared")
    await symlink(join(target, "shared"), link)
    const result = await loadActionRegistry({ baseDir: root, bundledPath: "bundled" })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([{
      sourcePath: link,
      message: "symbolic links are not allowed in action registry paths",
    }])
  })

  it("rejects duplicate manifests at the same precedence deterministically", async () => {
    const root = await temporaryRegistry()
    const first = await writeManifest(root, "bundled/a", manifest("git/push", "1.0.0"))
    const second = await writeManifest(root, "bundled/b", manifest("git/push", "1.0.0"))
    const result = await loadActionRegistry({ baseDir: root, bundledPath: "bundled" })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([{
      sourcePath: first,
      message: `duplicate action manifest "git/push@1.0.0" at the same precedence: ${first}, ${second}`,
    }])
  })
})

describe("checkWorkflowReservation", () => {
  it("resolves bindings for the reconciler with source provenance", async () => {
    const root = await temporaryRegistry()
    const sourcePath = await writeManifest(root, "bundled/git-push", manifest("git/push", "1.2.0"))
    const loaded = await load(root, "bundled")
    const result = checkWorkflowReservation(workflow(actionStep("push", "git/push@v1")), loaded)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const bindings = actionBindingsForReconciler(result.reservation.actionBindings)
    const binding = bindings.get("main", "push")
    expect(binding?.manifest.version).toBe("1.2.0")
    expect(binding?.sourcePath).toBe(sourcePath)
    expect(binding?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(result.reservation.actionBindings)).toBe(true)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding?.manifest)).toBe(true)
  })

  it("reports missing action and version with real source paths", async () => {
    const root = await temporaryRegistry()
    const sourcePath = await writeManifest(root, "bundled/git-push", manifest("git/push", "1.0.0"))
    const loaded = await load(root, "bundled")
    const result = checkWorkflowReservation(workflow(
      actionStep("missing", "git/worktree@v1"),
      actionStep("version", "git/push@v2"),
    ), loaded)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics[0]?.message).toContain(`searched paths: ${sourcePath}`)
    expect(result.diagnostics[0]?.message).toContain(`configured registry paths: ${join(root, "bundled")}`)
    expect(result.diagnostics[1]?.message).toContain(`searched paths: ${sourcePath}`)
    expect(result.diagnostics[1]?.message).toContain(`configured registry paths: ${join(root, "bundled")}`)
  })

  it("safeMessage omits the action manifest's source path and the configured registry search paths, for both a missing action and a missing version", async () => {
    const root = await temporaryRegistry()
    const sourcePath = await writeManifest(root, "bundled/git-push", manifest("git/push", "1.0.0"))
    const loaded = await load(root, "bundled")
    const result = checkWorkflowReservation(workflow(
      actionStep("missing", "git/worktree@v1"),
      actionStep("version", "git/push@v2"),
    ), loaded)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toHaveLength(2)
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.safeMessage).not.toContain(sourcePath)
      expect(diagnostic.safeMessage).not.toContain(join(root, "bundled"))
      expect(diagnostic.safeMessage).not.toContain("searched paths")
      expect(diagnostic.safeMessage).not.toContain("configured registry paths")
    }
    // Useful context survives: the job/step/uses identity is on the
    // diagnostic's own fields (the "job ... step ..." prose prefix is
    // added one layer up, by `workflow-registry.ts`'s `loadWorkflow`),
    // and `safeMessage` itself still names the reason.
    expect(result.diagnostics[0]?.jobId).toBe("main")
    expect(result.diagnostics[0]?.stepId).toBe("missing")
    expect(result.diagnostics[0]?.uses).toBe("git/worktree@v1")
    expect(result.diagnostics[0]?.safeMessage).toContain('no entry named "git/worktree"')
    expect(result.diagnostics[1]?.uses).toBe("git/push@v2")
    expect(result.diagnostics[1]?.safeMessage).toContain('"git/push" has no v2')
  })

  it("validates with payloads and aggregates all action diagnostics", async () => {
    const root = await temporaryRegistry()
    await writeManifest(root, "bundled/git-push", manifest("git/push", "1.0.0", "  remote: { type: string, required: true }"))
    const loaded = await load(root, "bundled")
    const result = checkWorkflowReservation(workflow(
      actionStep("wrong", "git/push@v1", { remote: 42, force: true }),
      actionStep("missing-input", "git/push@v1"),
      actionStep("missing-action", "git/worktree@v1"),
    ), loaded)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toHaveLength(4)
    expect(result.diagnostics.map(diagnostic => `${diagnostic.stepId}: ${diagnostic.message}`).join("\n")).toContain('wrong: input "force" is not declared')
    expect(result.diagnostics.map(diagnostic => diagnostic.message).join("\n")).toContain('input "remote" must be a string')
    expect(result.diagnostics.map(diagnostic => diagnostic.message).join("\n")).toContain('input "remote" is required')
    expect(result.diagnostics.map(diagnostic => diagnostic.message).join("\n")).toContain('no entry named "git/worktree"')
  })

  it("an input-validation diagnostic's safeMessage equals message — it never carried a path", async () => {
    const root = await temporaryRegistry()
    await writeManifest(root, "bundled/git-push", manifest("git/push", "1.0.0", "  remote: { type: string, required: true }"))
    const loaded = await load(root, "bundled")
    const result = checkWorkflowReservation(workflow(
      actionStep("wrong", "git/push@v1", { remote: 42 }),
    ), loaded)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.safeMessage).toBe(result.diagnostics[0]?.message)
    expect(result.diagnostics[0]?.safeMessage).toContain('input "remote" must be a string')
  })
})

describe("loadActionRegistry: the bundled actions directory", () => {
  it("finds and validates all six bundled actions", async () => {
    const result = await loadActionRegistry({ baseDir: import.meta.dirname, bundledPath: "actions" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.diagnostics.map(d => `${d.sourcePath}: ${d.message}`).join("\n"))
    expect(Object.keys(result.value.registry).sort()).toEqual([
      "git/push",
      "git/worktree",
      "git/worktree-remove",
      "github/await-checks",
      "github/pr-create",
      "github/pr-merge",
    ])
  })

  it("resolves git/worktree@v1 against the bundled registry", async () => {
    const result = await loadActionRegistry({ baseDir: import.meta.dirname, bundledPath: "actions" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const resolved = resolveAction("git/worktree@v1", result.value.registry)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.manifest.name).toBe("git/worktree")
    expect(resolved.manifest.run).toEqual({ kind: "inprocess", handler: "git/worktree" })
    expect(resolved.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
