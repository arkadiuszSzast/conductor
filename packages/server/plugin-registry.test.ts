import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PluginRegistry } from "./src/plugin-registry.ts"
import type { PluginRegistryConfig } from "./src/plugin-registry.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "conductor-plugins-"))
  temporaryDirectories.push(path)
  return path
}

function manifest(id: string, opts: { version?: number; title?: string } = {}): string {
  return `plugin: ${id}\nversion: ${opts.version ?? 1}\npanel:\n  title: ${opts.title ?? id}\n`
}

async function writePlugin(root: string, id: string, source: string): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "plugin.yaml"), source)
  return dir
}

async function scan(config: PluginRegistryConfig): Promise<PluginRegistry> {
  return PluginRegistry.scan(config)
}

describe("PluginRegistry.scan: discovery", () => {
  it("discovers a valid global plugin", async () => {
    const globalDir = await temporaryDir()
    const dir = await writePlugin(globalDir, "openspec", manifest("openspec", { title: "OpenSpec" }))
    const registry = await scan({ globalDir })

    expect(registry.loadDiagnostics()).toEqual([])
    const plugins = registry.list()
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ id: "openspec", scope: "global", dir })
    expect(plugins[0]!.manifest.panel.title).toBe("OpenSpec")
  })

  it("discovers a valid project plugin", async () => {
    const projectRoot = await temporaryDir()
    const pluginsDir = join(projectRoot, ".conductor", "plugins")
    const dir = await writePlugin(pluginsDir, "openspec", manifest("openspec"))
    const registry = await scan({ globalDir: null, projects: [{ id: "proj-1", root: projectRoot }] })

    expect(registry.loadDiagnostics()).toEqual([])
    const plugins = registry.list()
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ id: "openspec", scope: "project", dir, projectId: "proj-1", projectRoot })
  })

  it("scans configured extra search paths as part of the global scope", async () => {
    const extraDir = await temporaryDir()
    const dir = await writePlugin(extraDir, "extra-plugin", manifest("extra-plugin"))
    const registry = await scan({ globalDir: null, extraPaths: [extraDir] })

    const plugins = registry.list()
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ id: "extra-plugin", scope: "global", dir })
  })

  it("treats missing directories as silent — no diagnostic, no plugins", async () => {
    const missingGlobal = join(await temporaryDir(), "does-not-exist")
    const projectRoot = await temporaryDir()
    const registry = await scan({ globalDir: missingGlobal, projects: [{ id: "proj-1", root: projectRoot }] })

    expect(registry.loadDiagnostics()).toEqual([])
    expect(registry.list()).toEqual([])
  })
})

describe("PluginRegistry.scan: scoping and precedence", () => {
  it("a project plugin shadows a global plugin with the same id", async () => {
    const globalDir = await temporaryDir()
    const globalPluginDir = await writePlugin(globalDir, "openspec", manifest("openspec", { title: "Global" }))
    const projectRoot = await temporaryDir()
    const projectPluginDir = await writePlugin(join(projectRoot, ".conductor", "plugins"), "openspec", manifest("openspec", { title: "Project" }))
    const registry = await scan({ globalDir, projects: [{ id: "proj-1", root: projectRoot }] })

    expect(registry.loadDiagnostics()).toEqual([])
    expect(registry.list()).toHaveLength(2)

    const scoped = registry.listPlugins("proj-1")
    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ id: "openspec", scope: "project", project: "proj-1" })
    expect(scoped[0]!.panel.title).toBe("Project")

    const unscoped = registry.listPlugins("other-project")
    expect(unscoped).toHaveLength(1)
    expect(unscoped[0]).toMatchObject({ id: "openspec", scope: "global" })
    expect(unscoped[0]!.panel.title).toBe("Global")

    const global = registry.list().find(plugin => plugin.scope === "global")!
    const project = registry.list().find(plugin => plugin.scope === "project")!
    expect(global.diagnostics.some(diagnostic => diagnostic.message.includes("shadowed for project"))).toBe(true)
    expect(project.diagnostics.some(diagnostic => diagnostic.message.includes(`shadows the global "openspec" plugin at ${globalPluginDir}`))).toBe(true)
    expect(project.dir).toBe(projectPluginDir)
  })

  it("rejects a same-scope duplicate id via two search paths, registering neither", async () => {
    const rootA = await temporaryDir()
    const rootB = await temporaryDir()
    const dirA = await writePlugin(rootA, "openspec", manifest("openspec", { title: "A" }))
    const dirB = await writePlugin(rootB, "openspec", manifest("openspec", { title: "B" }))
    const registry = await scan({ globalDir: null, extraPaths: [rootA, rootB] })

    expect(registry.list()).toEqual([])
    const diagnostics = registry.loadDiagnostics()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain('duplicate plugin id "openspec"')
    const [first, second] = [dirA, dirB].sort()
    expect(diagnostics[0]!.message).toContain(first!)
    expect(diagnostics[0]!.message).toContain(second!)
  })

  it("listing filtered by project excludes other projects' plugins", async () => {
    const projectA = await temporaryDir()
    const projectB = await temporaryDir()
    await writePlugin(join(projectA, ".conductor", "plugins"), "a-only", manifest("a-only"))
    await writePlugin(join(projectB, ".conductor", "plugins"), "b-only", manifest("b-only"))
    const registry = await scan({
      globalDir: null,
      projects: [{ id: "proj-a", root: projectA }, { id: "proj-b", root: projectB }],
    })

    const scopedA = registry.listPlugins("proj-a")
    expect(scopedA.map(plugin => plugin.id)).toEqual(["a-only"])
    const scopedB = registry.listPlugins("proj-b")
    expect(scopedB.map(plugin => plugin.id)).toEqual(["b-only"])
    const unscoped = registry.listPlugins()
    expect(unscoped.map(plugin => plugin.id).sort()).toEqual(["a-only", "b-only"])
  })
})

describe("PluginRegistry.scan: hygiene and diagnostics", () => {
  it("skips a broken manifest but still registers a valid sibling", async () => {
    const globalDir = await temporaryDir()
    await writePlugin(globalDir, "broken", "plugin: broken\nplugin: broken\nversion: 1\npanel:\n  title: X\n")
    await writePlugin(globalDir, "valid", manifest("valid"))
    const registry = await scan({ globalDir })

    const plugins = registry.list()
    expect(plugins.map(plugin => plugin.id)).toEqual(["valid"])
    const diagnostics = registry.loadDiagnostics()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain("duplicate mapping key")
    expect(diagnostics[0]!.path).toContain(join("broken", "plugin.yaml"))
  })

  it("skips a manifest whose declared id does not match its directory", async () => {
    const globalDir = await temporaryDir()
    const dir = await writePlugin(globalDir, "foo", manifest("bar"))
    const registry = await scan({ globalDir })

    expect(registry.list()).toEqual([])
    const diagnostics = registry.loadDiagnostics()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain('declares plugin id "bar"')
    expect(diagnostics[0]!.message).toContain('directory is named "foo"')
    expect(diagnostics[0]!.path).toBe(join(dir, "plugin.yaml"))
  })

  it("rejects the reserved plugin id 'session'", async () => {
    const globalDir = await temporaryDir()
    await writePlugin(globalDir, "session", manifest("session"))
    const registry = await scan({ globalDir })

    expect(registry.list()).toEqual([])
    const diagnostics = registry.loadDiagnostics()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain('plugin id "session" is reserved')
  })

  it("skips a manifest with an unsupported schema version", async () => {
    const globalDir = await temporaryDir()
    await writePlugin(globalDir, "future", manifest("future", { version: 999 }))
    const registry = await scan({ globalDir })

    expect(registry.list()).toEqual([])
    const diagnostics = registry.loadDiagnostics()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain("version 999 is newer than supported")
    expect(diagnostics[0]!.message).toContain("up to version 1")
  })

  it("rejects a symlinked plugin directory", async () => {
    const globalDir = await temporaryDir()
    const target = await temporaryDir()
    await writePlugin(target, "openspec", manifest("openspec"))
    const link = join(globalDir, "openspec")
    await symlink(join(target, "openspec"), link)
    const registry = await scan({ globalDir })

    expect(registry.list()).toEqual([])
    const diagnostics = registry.loadDiagnostics()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toBe("symbolic links are not allowed for plugin directories")
    expect(diagnostics[0]!.path).toBe(link)
  })

  it("rejects a symlinked plugin manifest file", async () => {
    const globalDir = await temporaryDir()
    const target = await temporaryDir()
    await writePlugin(target, "shared", manifest("openspec"))
    const dir = join(globalDir, "openspec")
    await mkdir(dir, { recursive: true })
    await symlink(join(target, "shared", "plugin.yaml"), join(dir, "plugin.yaml"))
    const registry = await scan({ globalDir })

    expect(registry.list()).toEqual([])
    const diagnostics = registry.loadDiagnostics()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toBe("symbolic links are not allowed for plugin manifests")
  })
})

describe("PluginRegistry.listPlugins: state and disabled plugins", () => {
  it("lists a disabled plugin with state 'disabled' regardless of a state lookup", async () => {
    const globalDir = await temporaryDir()
    await writePlugin(globalDir, "openspec", manifest("openspec"))
    const registry = await scan({ globalDir, disabled: ["openspec"] })

    const listing = registry.listPlugins(undefined, () => "running")
    expect(listing).toHaveLength(1)
    expect(listing[0]!.state).toBe("disabled")
  })

  it("defaults an enabled plugin's state to 'stopped' with no state lookup", async () => {
    const globalDir = await temporaryDir()
    await writePlugin(globalDir, "openspec", manifest("openspec"))
    const registry = await scan({ globalDir })

    const listing = registry.listPlugins()
    expect(listing[0]!.state).toBe("stopped")
  })

  it("uses the caller-supplied state lookup for an enabled plugin", async () => {
    const globalDir = await temporaryDir()
    await writePlugin(globalDir, "openspec", manifest("openspec"))
    const registry = await scan({ globalDir })

    const listing = registry.listPlugins(undefined, () => "error")
    expect(listing[0]!.state).toBe("error")
  })
})
