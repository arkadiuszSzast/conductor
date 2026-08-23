/**
 * Plugin discovery — the daemon-side scan mirroring `action-registry.ts`:
 * same hygiene (symlink rejection, 1 MiB manifest cap, diagnostics
 * accumulate instead of throwing), different failure posture. Unlike the
 * action registry's all-or-nothing load, a broken plugin must never keep
 * its valid siblings out of the listing — `scan` always succeeds and
 * returns both the discovered plugins and the diagnostics for whatever
 * was skipped. Manifest parse/validate stays in `@conductor/core`
 * (`plugin-manifest.ts`); this module owns the filesystem walk, scope
 * resolution (global vs. per-project, shadowing, same-scope conflicts)
 * and the listing projection. Process supervision and the HTTP surface
 * are later tasks (3.x) — this registry only answers "what plugins exist
 * and where".
 */

import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { parsePluginManifest, SUPPORTED_PLUGIN_MANIFEST_VERSION, validatePluginManifest } from "@conductor/core"
import type { PluginManifest, PluginManifestPanel } from "@conductor/core"

const MAX_MANIFEST_BYTES = 1_048_576

/** Ids whose proxy mount would collide with a fixed daemon route under
 *  `/v1/plugins/` (`POST /v1/plugins/session` is the cookie exchange). */
const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(["session"])

export type PluginScope = "global" | "project"

export interface PluginDiagnostic {
  readonly path: string
  readonly message: string
  readonly line?: number
  readonly col?: number
}

export interface DiscoveredPlugin {
  readonly id: string
  readonly scope: PluginScope
  /** Absolute path to the plugin's directory (contains `plugin.yaml`). */
  readonly dir: string
  readonly manifest: PluginManifest
  readonly projectId?: string
  readonly projectRoot?: string
  /** Diagnostics scoped to this specific plugin (e.g. shadowing another). */
  readonly diagnostics: readonly PluginDiagnostic[]
}

export interface PluginRegistryProject {
  readonly id: string
  readonly root: string
}

export interface PluginRegistryConfig {
  /** `<config-dir>/plugins`, or null when no global plugin directory applies. */
  readonly globalDir: string | null
  /** Additional absolute search paths, scanned as part of the global scope. */
  readonly extraPaths?: readonly string[]
  readonly projects?: readonly PluginRegistryProject[]
  /** Plugin ids disabled through daemon config — listed but inert. */
  readonly disabled?: readonly string[]
}

export type PluginState = "running" | "stopped" | "disabled" | "error"

export interface PluginStateKey {
  readonly scope: PluginScope
  readonly id: string
  readonly projectId?: string
}

/** The supervisor (task 3.x) feeds live state through this; absent → "stopped". */
export type PluginStateLookup = (key: PluginStateKey) => PluginState | undefined

export interface PluginListing {
  readonly id: string
  readonly scope: PluginScope
  readonly project?: string
  readonly panel: PluginManifestPanel
  readonly state: PluginState
  readonly diagnostics: readonly PluginDiagnostic[]
}

interface CandidatePlugin {
  readonly id: string
  readonly scope: PluginScope
  readonly dir: string
  readonly manifest: PluginManifest
  readonly projectId?: string
  readonly projectRoot?: string
}

export class PluginRegistry {
  private constructor(
    private readonly plugins: readonly DiscoveredPlugin[],
    private readonly diagnostics: readonly PluginDiagnostic[],
    private readonly disabledIdsSet: ReadonlySet<string>,
  ) {}

  static async scan(config: PluginRegistryConfig): Promise<PluginRegistry> {
    const diagnostics: PluginDiagnostic[] = []

    const globalRoots: string[] = []
    if (config.globalDir !== null) globalRoots.push(config.globalDir)
    for (const path of config.extraPaths ?? []) globalRoots.push(path)

    const globalCandidates: CandidatePlugin[] = []
    for (const root of globalRoots) {
      const found = await scanScopeRoot(root, diagnostics)
      for (const candidate of found) {
        globalCandidates.push({ ...candidate, scope: "global" })
      }
    }
    const globalSelected = dedupeScope(globalCandidates, diagnostics)

    const projectSelected = new Map<string, CandidatePlugin[]>()
    for (const project of config.projects ?? []) {
      const root = join(project.root, ".conductor", "plugins")
      const found = await scanScopeRoot(root, diagnostics)
      const candidates = found.map(candidate => ({
        ...candidate,
        scope: "project" as const,
        projectId: project.id,
        projectRoot: project.root,
      }))
      projectSelected.set(project.id, dedupeScope(candidates, diagnostics))
    }

    const extraDiagnostics = new Map<string, PluginDiagnostic[]>()
    const addExtra = (key: string, diagnostic: PluginDiagnostic): void => {
      const list = extraDiagnostics.get(key)
      if (list !== undefined) list.push(diagnostic)
      else extraDiagnostics.set(key, [diagnostic])
    }

    const globalById = new Map(globalSelected.map(candidate => [candidate.id, candidate]))
    for (const [projectId, candidates] of projectSelected) {
      for (const candidate of candidates) {
        const shadowed = globalById.get(candidate.id)
        if (shadowed === undefined) continue
        addExtra(keyOf("project", candidate.id, projectId), {
          path: candidate.dir,
          message: `shadows the global "${candidate.id}" plugin at ${shadowed.dir}`,
        })
        addExtra(keyOf("global", candidate.id, undefined), {
          path: shadowed.dir,
          message: `shadowed for project "${projectId}" by the plugin at ${candidate.dir}`,
        })
      }
    }

    const allCandidates: CandidatePlugin[] = [...globalSelected, ...[...projectSelected.values()].flat()]
    const plugins: DiscoveredPlugin[] = allCandidates.map(candidate => ({
      ...candidate,
      diagnostics: extraDiagnostics.get(keyOf(candidate.scope, candidate.id, candidate.projectId)) ?? [],
    }))

    return new PluginRegistry(plugins, diagnostics, new Set(config.disabled ?? []))
  }

  /** Every discovered plugin, unfiltered. */
  list(): readonly DiscoveredPlugin[] {
    return this.plugins
  }

  /** Diagnostics for manifests/directories that never became a registered
   *  plugin: unreadable, oversized, malformed, invalid, id/directory
   *  mismatch, unsupported version, symlinked, or a same-scope conflict. */
  loadDiagnostics(): readonly PluginDiagnostic[] {
    return this.diagnostics
  }

  /** Plugin ids disabled through daemon config — the supervisor consults
   *  this before spawning; the listing's own `disabledIds` check stays
   *  the state-precedence authority regardless. */
  disabledIds(): ReadonlySet<string> {
    return this.disabledIdsSet
  }

  /**
   * Scope resolution: with a `projectId`, global plugins shadowed for
   * that project are omitted and that project's own plugins are added;
   * without one, every discovered plugin is listed. `stateOf` lets a
   * caller (the supervisor) report live state; disabled-by-config always
   * wins over it, and the default is "stopped".
   */
  listPlugins(projectId?: string, stateOf?: PluginStateLookup): readonly PluginListing[] {
    const relevant = this.plugins.filter(plugin => {
      if (projectId === undefined) return true
      if (plugin.scope === "project") return plugin.projectId === projectId
      return !this.isShadowedForProject(plugin.id, projectId)
    })
    return relevant
      .map(plugin => this.toListing(plugin, stateOf))
      .sort((left, right) => {
        const scope = compareText(left.scope, right.scope)
        if (scope !== 0) return scope
        const project = compareText(left.project ?? "", right.project ?? "")
        if (project !== 0) return project
        return compareText(left.id, right.id)
      })
  }

  private isShadowedForProject(id: string, projectId: string): boolean {
    return this.plugins.some(plugin => plugin.scope === "project" && plugin.projectId === projectId && plugin.id === id)
  }

  private toListing(plugin: DiscoveredPlugin, stateOf?: PluginStateLookup): PluginListing {
    const state: PluginState = this.disabledIdsSet.has(plugin.id)
      ? "disabled"
      : stateOf?.({ scope: plugin.scope, id: plugin.id, ...(plugin.projectId !== undefined ? { projectId: plugin.projectId } : {}) }) ?? "stopped"
    return {
      id: plugin.id,
      scope: plugin.scope,
      ...(plugin.scope === "project" ? { project: plugin.projectId! } : {}),
      panel: plugin.manifest.panel,
      state,
      diagnostics: plugin.diagnostics,
    }
  }
}

function keyOf(scope: PluginScope, id: string, projectId: string | undefined): string {
  return `${scope}:${projectId ?? ""}:${id}`
}

interface ScannedCandidate {
  readonly id: string
  readonly dir: string
  readonly manifest: PluginManifest
}

async function scanScopeRoot(root: string, diagnostics: PluginDiagnostic[]): Promise<readonly ScannedCandidate[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isEnoent(error)) return []
    diagnostics.push({ path: root, message: `cannot read plugin directory: ${errorMessage(error)}` })
    return []
  }

  entries.sort((left, right) => compareText(left.name, right.name))
  const candidates: ScannedCandidate[] = []
  for (const entry of entries) {
    const dir = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      diagnostics.push({ path: dir, message: "symbolic links are not allowed for plugin directories" })
      continue
    }
    if (!entry.isDirectory()) continue

    const candidate = await readPluginDirectory(entry.name, dir, diagnostics)
    if (candidate !== undefined) candidates.push(candidate)
  }
  return candidates
}

async function readPluginDirectory(
  id: string,
  dir: string,
  diagnostics: PluginDiagnostic[],
): Promise<ScannedCandidate | undefined> {
  let dirEntries
  try {
    dirEntries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    diagnostics.push({ path: dir, message: `cannot read plugin directory: ${errorMessage(error)}` })
    return undefined
  }

  const manifestEntry = dirEntries.find(entry => entry.name === "plugin.yaml")
  if (manifestEntry === undefined) return undefined

  const manifestPath = join(dir, "plugin.yaml")
  if (manifestEntry.isSymbolicLink()) {
    diagnostics.push({ path: manifestPath, message: "symbolic links are not allowed for plugin manifests" })
    return undefined
  }
  if (!manifestEntry.isFile()) {
    diagnostics.push({ path: manifestPath, message: "plugin manifest is not a regular file" })
    return undefined
  }

  const source = await readManifestSource(manifestPath, diagnostics)
  if (source === undefined) return undefined

  const parsed = parsePluginManifest(source)
  if (!parsed.ok) {
    diagnostics.push(...parsed.errors.map(error => ({ path: manifestPath, message: error.message, line: error.line, col: error.col })))
    return undefined
  }

  const errors = validatePluginManifest(parsed.manifest)
  if (errors.length > 0) {
    diagnostics.push(...errors.map(message => ({ path: manifestPath, message })))
    return undefined
  }

  if (parsed.manifest.id !== id) {
    diagnostics.push({
      path: manifestPath,
      message: `manifest declares plugin id "${parsed.manifest.id}" but its directory is named "${id}" — the id must match the directory name`,
    })
    return undefined
  }

  if (RESERVED_PLUGIN_IDS.has(id)) {
    diagnostics.push({
      path: manifestPath,
      message: `plugin id "${id}" is reserved — "/v1/plugins/${id}" collides with a daemon route; pick another id`,
    })
    return undefined
  }

  if (parsed.manifest.version > SUPPORTED_PLUGIN_MANIFEST_VERSION) {
    diagnostics.push({
      path: manifestPath,
      message: `manifest version ${parsed.manifest.version} is newer than supported (up to version ${SUPPORTED_PLUGIN_MANIFEST_VERSION}) — skipping`,
    })
    return undefined
  }

  return { id, dir, manifest: parsed.manifest }
}

async function readManifestSource(manifestPath: string, diagnostics: PluginDiagnostic[]): Promise<string | undefined> {
  let file
  try {
    file = await open(manifestPath, "r")
    const info = await file.stat()
    if (info.size > MAX_MANIFEST_BYTES) {
      diagnostics.push({ path: manifestPath, message: `plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes` })
      return undefined
    }
    return await file.readFile("utf8")
  } catch (error) {
    diagnostics.push({ path: manifestPath, message: `cannot read plugin manifest: ${errorMessage(error)}` })
    return undefined
  } finally {
    await file?.close()
  }
}

function dedupeScope(candidates: readonly CandidatePlugin[], diagnostics: PluginDiagnostic[]): CandidatePlugin[] {
  const byId = new Map<string, CandidatePlugin[]>()
  for (const candidate of candidates) {
    const list = byId.get(candidate.id)
    if (list !== undefined) list.push(candidate)
    else byId.set(candidate.id, [candidate])
  }

  const selected: CandidatePlugin[] = []
  for (const [id, group] of [...byId.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (group.length > 1) {
      const dirs = group.map(candidate => candidate.dir).sort(compareText)
      diagnostics.push({
        path: dirs[0]!,
        message: `duplicate plugin id "${id}" at the same scope: ${dirs.join(", ")}`,
      })
      continue
    }
    selected.push(group[0]!)
  }
  return selected
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
