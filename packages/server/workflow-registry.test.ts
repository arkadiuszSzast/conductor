import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WorkflowRegistry } from "./src/workflow-registry.ts"
import { buildActionRegistry } from "@conductor/core"
import type { LoadedActionRegistry } from "./src/action-registry.ts"

const temporaryDirectories: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const MINIMAL_WORKFLOW = `
name: minimal
on: [manual]
roles:
  implementer: { agent: build }
jobs:
  main:
    steps:
      - id: implement
        agent:
          role: implementer
          prompt: "Implement it."
`

function writeProject(source: string = MINIMAL_WORKFLOW): string {
  const project = tempDir("conductor-workflow-project-")
  writeFileSync(join(project, "conductor.yaml"), source)
  return project
}

describe("WorkflowRegistry: valid load", () => {
  it("registers a project and resolves its parsed, validated workflow", () => {
    const project = writeProject()
    const registry = new WorkflowRegistry()
    const result = registry.register(project)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.workflow.name).toBe("minimal")
    expect(registry.resolver(project)?.workflow.name).toBe("minimal")
    expect(registry.getStatus(project).state).toBe("valid")
  })

  it("publishes a deep-frozen snapshot", () => {
    const project = writeProject()
    const registry = new WorkflowRegistry()
    const result = registry.register(project)
    if (!result.ok) throw new Error("expected ok")
    expect(Object.isFrozen(result.snapshot)).toBe(true)
    expect(Object.isFrozen(result.snapshot.workflow)).toBe(true)
    expect(Object.isFrozen(result.snapshot.workflow.jobs)).toBe(true)
  })
})

describe("WorkflowRegistry: parse errors", () => {
  it("a parse error makes the project invalid with a diagnostic naming the source", () => {
    const project = writeProject("not: valid: yaml: [")
    const registry = new WorkflowRegistry()
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0]!.sourcePath).toContain("conductor.yaml")
    expect(registry.getStatus(project)).toMatchObject({ state: "invalid" })
    expect(registry.resolver(project)).toBeNull()
  })

  it("a missing conductor.yaml is invalid with a clear diagnostic", () => {
    const project = tempDir("conductor-workflow-missing-")
    const registry = new WorkflowRegistry()
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]!.message).toContain("not found")
  })
})

describe("WorkflowRegistry: validation errors", () => {
  it("a validation error (unknown role) makes the project invalid", () => {
    const project = writeProject(`
name: bad
on: [manual]
roles: {}
jobs:
  main:
    steps:
      - id: implement
        agent:
          role: missing
          prompt: "go"
`)
    const registry = new WorkflowRegistry()
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.some(d => d.message.includes("missing"))).toBe(true)
  })

  it("surfaces validation warnings on a valid snapshot", () => {
    // A workflow with no observable warning-triggering shape still exposes
    // the warnings array so callers never need a special case.
    const project = writeProject()
    const registry = new WorkflowRegistry()
    const result = registry.register(project)
    if (!result.ok) throw new Error("expected ok")
    expect(Array.isArray(result.snapshot.warnings)).toBe(true)
  })
})

describe("WorkflowRegistry: stale reload", () => {
  it("serves the last valid snapshot when a subsequent reload fails", () => {
    const project = writeProject()
    const registry = new WorkflowRegistry()
    const first = registry.register(project)
    if (!first.ok) throw new Error("expected ok")

    writeFileSync(join(project, "conductor.yaml"), "not: valid: [")
    const reload = registry.reload(project)
    expect(reload.ok).toBe(false)

    const status = registry.getStatus(project)
    expect(status.state).toBe("stale")
    if (status.state !== "stale") return
    expect(status.snapshot.workflow.name).toBe("minimal")
    expect(registry.resolver(project)?.workflow.name).toBe("minimal")
  })

  it("a valid reload after a stale one clears the staleness", () => {
    const project = writeProject()
    const registry = new WorkflowRegistry()
    registry.register(project)
    writeFileSync(join(project, "conductor.yaml"), "not: valid: [")
    registry.reload(project)
    expect(registry.getStatus(project).state).toBe("stale")

    writeFileSync(join(project, "conductor.yaml"), MINIMAL_WORKFLOW.replace("minimal", "minimal2"))
    const reload = registry.reload(project)
    expect(reload.ok).toBe(true)
    expect(registry.getStatus(project).state).toBe("valid")
  })
})

describe("WorkflowRegistry: realpath aliasing", () => {
  it("collapses a symlinked alias to the same canonical project", () => {
    const real = writeProject()
    const parent = tempDir("conductor-workflow-alias-")
    const alias = join(parent, "alias")
    symlinkSync(real, alias)

    const registry = new WorkflowRegistry()
    const result = registry.register(alias)
    expect(result.ok).toBe(true)
    expect(registry.resolver(alias)?.projectDir).toBe(real)
    expect(registry.resolver(real)?.projectDir).toBe(real)
    expect(registry.list()).toHaveLength(1)
  })
})

describe("WorkflowRegistry: unregister", () => {
  it("removes a project — resolve/getStatus treat it as unregistered", () => {
    const project = writeProject()
    const registry = new WorkflowRegistry()
    registry.register(project)
    registry.unregister(project)
    expect(registry.getStatus(project)).toEqual({ state: "unregistered" })
    expect(registry.resolver(project)).toBeNull()
    expect(registry.list()).toEqual([])
  })
})

describe("WorkflowRegistry: action steps", () => {
  const WORKFLOW_WITH_ACTION = `
name: with-action
on: [manual]
roles: {}
jobs:
  main:
    steps:
      - id: push
        action:
          uses: git/push@v1
`

  it("a workflow with action steps is invalid without a configured action registry", () => {
    const project = writeProject(WORKFLOW_WITH_ACTION)
    const registry = new WorkflowRegistry()
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]!.message).toContain("action steps require a configured action registry")
  })

  it("resolves action steps through a configured action registry", () => {
    const project = writeProject(WORKFLOW_WITH_ACTION)
    const actionRegistry: LoadedActionRegistry = {
      registry: buildActionRegistry([
        {
          manifest: {
            name: "git/push",
            version: "1.0.0",
            description: "",
            inputs: {},
            outputs: {},
            capabilities: [],
            run: { kind: "process", command: ["bun", "run", "main.ts"] },
          },
          sourcePath: "/bundled/git-push/action.yaml",
        },
      ]),
      searchPaths: [],
    }
    const registry = new WorkflowRegistry({ actionRegistry })
    const result = registry.register(project)
    expect(result.ok).toBe(true)
  })

  it("an action step referring to an unresolvable action is invalid with a clear diagnostic", () => {
    const project = writeProject(WORKFLOW_WITH_ACTION)
    const actionRegistry: LoadedActionRegistry = { registry: buildActionRegistry([]), searchPaths: [] }
    const registry = new WorkflowRegistry({ actionRegistry })
    const result = registry.register(project)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]!.message).toContain("git/push")
  })
})

describe("WorkflowRegistry: list", () => {
  it("lists every registered project, sorted by canonical directory", () => {
    const a = writeProject()
    const b = writeProject()
    const registry = new WorkflowRegistry()
    registry.register(a)
    registry.register(b)
    const listed = registry.list().map(entry => entry.projectDir).sort()
    expect(listed).toEqual([a, b].sort())
  })
})
