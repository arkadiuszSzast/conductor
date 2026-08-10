/**
 * Project configuration registry — loads, validates and caches each
 * registered project's `EngineConfig`, and exposes a stable
 * `ConfigResolver` for the pipeline engine.
 *
 * Precedence (lowest → highest), mirroring opencode-conductor's seed
 * `config.ts`:
 *   1. preset named by `extends` (a bundled preset name, or a path
 *      relative to the project config file)
 *   2. global config file (`globalConfigPath`, e.g.
 *      `~/.config/conductor/conductor.json` — the daemon decides the
 *      path; this module only reads what it is given)
 *   3. project config file (`<projectDir>/.opencode/conductor.json`)
 *
 * Merge semantics: scalar fields override; `roles` merge per-key;
 * `pipeline` REPLACES wholesale — splicing two step lists produces a
 * pipeline nobody wrote; if a layer defines steps, it owns all of them.
 *
 * `register`/`reload`/`unregister` are the only mutating operations, and
 * are explicit and synchronous — the registry does not watch the
 * filesystem. `resolve`/`resolver` never touch disk: lookups go through
 * an in-memory alias map (literal path → canonical path, populated at
 * registration time) to the last successfully loaded snapshot, so the
 * returned `ConfigResolver` is a safe, disk-free closure to hand to
 * `Engine`. A `reload` that fails to produce a valid config — including
 * a transient failure to stat/canonicalize the project directory —
 * leaves the previous valid snapshot in place: an edited-but-broken
 * config file must never blank out a live project's pipeline out from
 * under active features.
 */

import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { validatePipeline } from "./engine/validate.ts"
import type { BuiltinAction, EngineConfig, PublishDef, RoleDef, StepDef } from "./engine/types.ts"
import type { ConfigResolver } from "./engine/ports.ts"

const DEFAULTS = {
  baseBranch: "main",
  runTtlMs: 3_600_000,
  nudgeIdleCycles: 2,
  maxNudges: 2,
} as const

const PROJECT_CONFIG_RELATIVE_PATH = join(".opencode", "conductor.json")
const MAX_CONFIG_BYTES = 1_048_576

const KNOWN_LAYER_KEYS = new Set([
  "$comment",
  "extends",
  "roles",
  "pipeline",
  "workflows",
  "repo",
  "baseBranch",
  "worktreeDir",
  "reviewPublish",
  "skipSteps",
  "runTtlMs",
  "nudgeIdleCycles",
  "maxNudges",
])

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

const BUILTIN_ACTIONS: readonly BuiltinAction[] = [
  "worktree.create",
  "worktree.remove",
  "git.push",
  "pr.create",
  "pr.await_checks",
  "pr.merge",
  "threads.check_resolved",
  "findings.sync",
  "findings.check",
]

export interface ProjectConfigRegistryOptions {
  /**
   * Global config file layered beneath every project's config. Explicit
   * daemon configuration — the registry never infers a home directory.
   * Omitted → no global layer.
   */
  readonly globalConfigPath?: string
  /** Directory containing the bundled `conductor:<name>` presets. Defaults to `packages/server/presets` next to this module. */
  readonly bundledPresetDir?: string
}

export interface ProjectConfigSnapshot {
  readonly projectDir: string
  readonly config: EngineConfig
  /** Config/preset files this snapshot was assembled from, in read order. */
  readonly sources: readonly string[]
  /** Non-fatal warnings surfaced by structural validation. */
  readonly warnings: readonly string[]
  readonly loadedAt: number
}

export interface ProjectConfigDiagnostic {
  readonly sourcePath: string
  readonly message: string
}

export type LoadResult =
  | { readonly ok: true; readonly snapshot: ProjectConfigSnapshot }
  | { readonly ok: false; readonly diagnostics: readonly ProjectConfigDiagnostic[] }

export type ProjectConfigStatus =
  | { readonly state: "unregistered" }
  /** Registered, loaded and currently valid. */
  | { readonly state: "valid"; readonly snapshot: ProjectConfigSnapshot }
  /**
   * A prior valid load exists and is still what `resolve` returns, but
   * the most recent `reload` failed — the stale snapshot is being served
   * deliberately, not accidentally.
   */
  | {
      readonly state: "stale"
      readonly snapshot: ProjectConfigSnapshot
      readonly diagnostics: readonly ProjectConfigDiagnostic[]
    }
  /** Registered, but no valid load has ever succeeded. */
  | { readonly state: "invalid"; readonly diagnostics: readonly ProjectConfigDiagnostic[] }

interface RegistryEntry {
  /** Canonical (realpath'd) project directory — the resolver key. */
  readonly canonicalDir: string
  status: ProjectConfigStatus
}

/**
 * Raw, unvalidated shape a project/global/preset JSON file may declare.
 * Every field is read defensively — the file is untrusted JSON, not a
 * typed value, until validation confirms its shape.
 */
interface RawLayer {
  readonly extends?: unknown
  readonly roles?: unknown
  readonly pipeline?: unknown
  readonly workflows?: unknown
  readonly repo?: unknown
  readonly baseBranch?: unknown
  readonly worktreeDir?: unknown
  readonly reviewPublish?: unknown
  readonly skipSteps?: unknown
  readonly runTtlMs?: unknown
  readonly nudgeIdleCycles?: unknown
  readonly maxNudges?: unknown
}

/** A `RawLayer` narrowed just enough to merge and validate — still not `EngineConfig`. */
interface MergedLayer {
  extends?: string
  roles?: Record<string, RoleDef>
  pipeline?: readonly StepDef[]
  workflows?: Record<string, { extends?: string; pipeline?: readonly StepDef[] }>
  repo?: string
  baseBranch?: string
  worktreeDir?: string
  reviewPublish?: Partial<PublishDef>
  skipSteps?: readonly string[]
  runTtlMs?: number
  nudgeIdleCycles?: number
  maxNudges?: number
}

export class ProjectConfigRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  /** Literal (as-registered) path → canonical entry key. Populated only by explicit operations, so lookups stay disk-free. */
  private readonly aliases = new Map<string, string>()
  private readonly globalConfigPath: string | null
  private readonly bundledPresetDir: string

  /**
   * Stable, disk-free `ConfigResolver` closure — bind once and hand to
   * `Engine`. Reads only in-memory maps; never touches the filesystem.
   */
  readonly resolver: ConfigResolver = (projectDir: string) => this.resolve(projectDir)

  constructor(options: ProjectConfigRegistryOptions = {}) {
    this.globalConfigPath = options.globalConfigPath ?? null
    this.bundledPresetDir = options.bundledPresetDir ?? resolve(import.meta.dirname, "..", "presets")
  }

  /**
   * Load a project for the first time (or re-load an already-registered
   * one — equivalent to `reload`). The project directory must exist;
   * canonicalization (`realpathSync`) happens before any config file is
   * read, so a project is always keyed by its real, symlink-resolved
   * path, and the literal registration path becomes a disk-free alias.
   */
  register(projectDir: string): LoadResult {
    return this.reload(projectDir)
  }

  /**
   * Re-read and re-validate a project's config from disk. On success the
   * new snapshot replaces whatever was cached. On failure — including a
   * transient failure to stat/canonicalize the project directory — the
   * LAST VALID snapshot (if any) is preserved and reported as `"stale"`
   * by `getStatus`/`resolve`: a broken edit never blanks a live
   * project's pipeline.
   */
  reload(projectDir: string): LoadResult {
    let canonicalDir: string
    try {
      canonicalDir = canonicalizeProjectDir(projectDir)
    } catch (error) {
      const diagnostics = [{ sourcePath: projectDir, message: canonicalizationErrorMessage(error, projectDir) }]
      this.recordFailure(this.entryKey(projectDir), diagnostics)
      return { ok: false, diagnostics }
    }

    this.aliases.set(projectDir, canonicalDir)
    if (projectDir !== canonicalDir) this.entries.delete(projectDir)
    const result = loadProjectConfig(canonicalDir, this.globalConfigPath, this.bundledPresetDir)

    if (result.ok) {
      this.entries.set(canonicalDir, { canonicalDir, status: { state: "valid", snapshot: result.snapshot } })
      return result
    }
    this.recordFailure(canonicalDir, result.diagnostics)
    return result
  }

  /** Remove a project from the registry. `resolve`/`getStatus` treat it as unregistered afterward. */
  unregister(projectDir: string): void {
    const key = this.entryKey(projectDir)
    this.entries.delete(key)
    for (const [alias, canonical] of this.aliases) {
      if (alias === projectDir || canonical === key) this.aliases.delete(alias)
    }
  }

  /**
   * Synchronous, disk-free lookup: the engine's `ConfigResolver` shape.
   * Returns the last valid config (even if the most recent reload
   * failed and the entry is `"stale"`), or `null` if the project was
   * never successfully loaded.
   */
  resolve(projectDir: string): EngineConfig | null {
    const entry = this.entries.get(this.entryKey(projectDir))
    if (!entry) return null
    if (entry.status.state === "valid" || entry.status.state === "stale") return entry.status.snapshot.config
    return null
  }

  /** Status for one project — `"unregistered"` if it was never `register`ed (or was `unregister`ed). */
  getStatus(projectDir: string): ProjectConfigStatus {
    return this.entries.get(this.entryKey(projectDir))?.status ?? { state: "unregistered" }
  }

  /** All registered projects (canonical directories) and their current status. */
  list(): ReadonlyArray<{ readonly projectDir: string; readonly status: ProjectConfigStatus }> {
    return [...this.entries.values()]
      .map(entry => ({ projectDir: entry.canonicalDir, status: entry.status }))
      .sort((left, right) => compareText(left.projectDir, right.projectDir))
  }

  private entryKey(projectDir: string): string {
    return this.aliases.get(projectDir) ?? projectDir
  }

  private recordFailure(key: string, diagnostics: readonly ProjectConfigDiagnostic[]): void {
    const existing = this.entries.get(key)
    if (existing && (existing.status.state === "valid" || existing.status.state === "stale")) {
      this.entries.set(key, {
        canonicalDir: existing.canonicalDir,
        status: { state: "stale", snapshot: existing.status.snapshot, diagnostics },
      })
      return
    }
    this.entries.set(key, { canonicalDir: key, status: { state: "invalid", diagnostics } })
  }
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

function canonicalizeProjectDir(projectDir: string): string {
  const info = statSync(projectDir)
  if (!info.isDirectory()) throw new Error(`not a directory: ${projectDir}`)
  return realpathSync(projectDir)
}

function canonicalizationErrorMessage(error: unknown, projectDir: string): string {
  const code = (error as { code?: string } | null)?.code
  if (code === "ENOENT") return `project directory does not exist: ${projectDir}`
  return `cannot resolve project directory: ${errorMessage(error)}`
}

// ---------------------------------------------------------------------------
// Loading + merging
// ---------------------------------------------------------------------------

function loadProjectConfig(canonicalDir: string, globalConfigPath: string | null, bundledPresetDir: string): LoadResult {
  const diagnostics: ProjectConfigDiagnostic[] = []
  const warnings: string[] = []
  const sources: string[] = []

  const projectFile = join(canonicalDir, PROJECT_CONFIG_RELATIVE_PATH)
  const globalLayer = globalConfigPath !== null ? readLayer(globalConfigPath, diagnostics, warnings) : undefined
  if (globalLayer !== undefined && globalConfigPath !== null) sources.push(globalConfigPath)
  const projectLayer = readLayer(projectFile, diagnostics, warnings)
  if (projectLayer !== undefined) sources.push(projectFile)

  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const global = globalLayer ?? {}
  const project = projectLayer ?? {}

  const extendsSpec = project.extends ?? global.extends
  let presetLayer: MergedLayer = {}
  if (extendsSpec !== undefined) {
    const relativeTo = project.extends !== undefined || globalConfigPath === null ? dirname(projectFile) : dirname(globalConfigPath)
    const presetFile = resolvePresetSpec(extendsSpec, relativeTo, bundledPresetDir, diagnostics, projectFile)
    if (presetFile === undefined) return { ok: false, diagnostics }
    const before = diagnostics.length
    const loaded = readLayer(presetFile, diagnostics, warnings)
    if (loaded === undefined) {
      if (diagnostics.length === before) {
        diagnostics.push({ sourcePath: presetFile, message: `extends target not found: ${presetFile}` })
      }
      return { ok: false, diagnostics }
    }
    sources.unshift(presetFile)
    presetLayer = loaded
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const merged = mergeLayers(mergeLayers(presetLayer, global), project)

  const workflowSpecs = { ...(global.workflows ?? {}), ...(project.workflows ?? {}) }
  const resolvedWorkflows: Record<string, readonly StepDef[]> = {}
  for (const [name, spec] of Object.entries(workflowSpecs)) {
    if (spec.pipeline !== undefined) {
      resolvedWorkflows[name] = spec.pipeline
      continue
    }
    if (spec.extends !== undefined) {
      const declaredInProject = project.workflows?.[name] !== undefined || globalConfigPath === null
      const declaringFile = declaredInProject ? projectFile : globalConfigPath
      const file = resolvePresetSpec(spec.extends, dirname(declaringFile), bundledPresetDir, diagnostics, declaringFile)
      if (file === undefined) continue
      const before = diagnostics.length
      const loaded = readLayer(file, diagnostics, warnings)
      if (loaded?.pipeline === undefined) {
        if (diagnostics.length === before) {
          diagnostics.push({ sourcePath: file, message: `workflow "${name}" extends ${file} which has no pipeline` })
        }
        continue
      }
      sources.push(file)
      resolvedWorkflows[name] = loaded.pipeline
      continue
    }
    diagnostics.push({ sourcePath: projectFile, message: `workflow "${name}" needs either "pipeline" or "extends"` })
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const config: EngineConfig = {
    pipeline: merged.pipeline ?? [],
    roles: merged.roles ?? {},
    ...(Object.keys(workflowSpecs).length > 0 ? { workflows: workflowSpecs } : {}),
    resolvedWorkflows,
    ...(merged.repo !== undefined ? { repo: merged.repo } : {}),
    baseBranch: merged.baseBranch ?? DEFAULTS.baseBranch,
    ...(merged.worktreeDir !== undefined ? { worktreeDir: merged.worktreeDir } : {}),
    ...(merged.reviewPublish !== undefined ? { reviewPublish: merged.reviewPublish } : {}),
    ...(merged.skipSteps !== undefined ? { skipSteps: merged.skipSteps } : {}),
    runTtlMs: merged.runTtlMs ?? DEFAULTS.runTtlMs,
    nudgeIdleCycles: merged.nudgeIdleCycles ?? DEFAULTS.nudgeIdleCycles,
    maxNudges: merged.maxNudges ?? DEFAULTS.maxNudges,
  }

  const validation = validatePipeline(config)
  warnings.push(...validation.warnings)
  if (validation.errors.length > 0) {
    diagnostics.push(...validation.errors.map(message => ({ sourcePath: projectFile, message: `invalid pipeline: ${message}` })))
  }
  for (const [name, pipeline] of Object.entries(resolvedWorkflows)) {
    const wfValidation = validatePipeline({ pipeline, roles: config.roles })
    if (wfValidation.errors.length > 0) {
      diagnostics.push(
        ...wfValidation.errors.map(message => ({ sourcePath: projectFile, message: `invalid workflow "${name}": ${message}` })),
      )
    }
    warnings.push(...wfValidation.warnings.map(message => `workflow "${name}": ${message}`))
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const snapshot: ProjectConfigSnapshot = deepFreeze({
    projectDir: canonicalDir,
    config,
    sources,
    warnings,
    loadedAt: Date.now(),
  })
  return { ok: true, snapshot }
}

/**
 * Scalar fields override; `roles`/`workflows` merge per-key; `pipeline`
 * REPLACES wholesale — never spliced (a project that defines steps owns
 * all of them, matching the seed's semantics exactly).
 */
function mergeLayers(base: MergedLayer, over: MergedLayer): MergedLayer {
  const merged: MergedLayer = {
    ...base,
    ...over,
    roles: { ...(base.roles ?? {}), ...(over.roles ?? {}) },
  }
  const pipeline = over.pipeline ?? base.pipeline
  if (pipeline !== undefined) merged.pipeline = pipeline
  return merged
}

function resolvePresetSpec(
  spec: string,
  relativeTo: string,
  bundledPresetDir: string,
  diagnostics: ProjectConfigDiagnostic[],
  sourcePath: string,
): string | undefined {
  if (spec.startsWith("conductor:")) {
    const name = spec.slice("conductor:".length)
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      diagnostics.push({ sourcePath, message: `bundled preset name "${name}" must match [A-Za-z0-9_-]+` })
      return undefined
    }
    return join(bundledPresetDir, `${name}.json`)
  }
  return isAbsolute(spec) ? resolve(spec) : resolve(relativeTo, spec)
}

// ---------------------------------------------------------------------------
// File reading + defensive shape validation
// ---------------------------------------------------------------------------

/**
 * Reads and shape-validates one JSON config layer. Returns `undefined`
 * (not an error) when the file simply does not exist — every layer
 * except an explicit `extends` target is optional. Pushes diagnostics
 * and returns `undefined` for any other failure (unreadable, too large,
 * invalid JSON, wrong shape).
 */
function readLayer(file: string, diagnostics: ProjectConfigDiagnostic[], warnings: string[]): MergedLayer | undefined {
  let raw: string
  try {
    const info = statSync(file)
    if (!info.isFile()) {
      diagnostics.push({ sourcePath: file, message: "config path exists but is not a file" })
      return undefined
    }
    if (info.size > MAX_CONFIG_BYTES) {
      diagnostics.push({ sourcePath: file, message: `config file exceeds ${MAX_CONFIG_BYTES} bytes` })
      return undefined
    }
    raw = readFileSync(file, "utf8")
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    if (code === "ENOENT") return undefined
    diagnostics.push({ sourcePath: file, message: `cannot read config file: ${errorMessage(error)}` })
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    diagnostics.push({ sourcePath: file, message: `cannot parse JSON: ${errorMessage(error).slice(0, 200)}` })
    return undefined
  }

  return validateRawLayer(parsed, file, diagnostics, warnings)
}

/**
 * Defensively narrows arbitrary parsed JSON into `MergedLayer`. Every
 * field from an untrusted file is checked before it is ever cast or
 * assigned — a malformed field is reported as a diagnostic and the
 * layer is rejected outright rather than silently coerced or dropped.
 */
function validateRawLayer(
  value: unknown,
  file: string,
  diagnostics: ProjectConfigDiagnostic[],
  warnings: string[],
): MergedLayer | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({ sourcePath: file, message: "config must be a JSON object" })
    return undefined
  }
  const raw = value as RawLayer
  const before = diagnostics.length
  const layer: MergedLayer = {}

  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) {
      diagnostics.push({ sourcePath: file, message: `unsafe key "${key}" is not allowed` })
    } else if (!KNOWN_LAYER_KEYS.has(key)) {
      warnings.push(`${file}: unknown field "${key}" is ignored`)
    }
  }

  if (raw.extends !== undefined) {
    if (typeof raw.extends !== "string" || raw.extends.trim() === "") {
      diagnostics.push({ sourcePath: file, message: `"extends" must be a non-empty string` })
    } else {
      layer.extends = raw.extends
    }
  }

  if (raw.roles !== undefined) {
    const roles = validateRoles(raw.roles, file, diagnostics)
    if (roles !== undefined) layer.roles = roles
  }

  if (raw.pipeline !== undefined) {
    const pipeline = validatePipelineSteps(raw.pipeline, `${file}#pipeline`, file, diagnostics)
    if (pipeline !== undefined) layer.pipeline = pipeline
  }

  if (raw.workflows !== undefined) {
    const workflows = validateWorkflows(raw.workflows, file, diagnostics)
    if (workflows !== undefined) layer.workflows = workflows
  }

  if (raw.repo !== undefined) {
    if (typeof raw.repo !== "string") diagnostics.push({ sourcePath: file, message: `"repo" must be a string` })
    else layer.repo = raw.repo
  }

  if (raw.baseBranch !== undefined) {
    if (typeof raw.baseBranch !== "string") diagnostics.push({ sourcePath: file, message: `"baseBranch" must be a string` })
    else layer.baseBranch = raw.baseBranch
  }

  if (raw.worktreeDir !== undefined) {
    if (typeof raw.worktreeDir !== "string") diagnostics.push({ sourcePath: file, message: `"worktreeDir" must be a string` })
    else layer.worktreeDir = raw.worktreeDir
  }

  if (raw.reviewPublish !== undefined) {
    const reviewPublish = validateReviewPublish(raw.reviewPublish, file, diagnostics)
    if (reviewPublish !== undefined) layer.reviewPublish = reviewPublish
  }

  if (raw.skipSteps !== undefined) {
    if (!isStringArray(raw.skipSteps)) diagnostics.push({ sourcePath: file, message: `"skipSteps" must be an array of strings` })
    else layer.skipSteps = raw.skipSteps
  }

  if (raw.runTtlMs !== undefined) {
    if (!isPositiveNumber(raw.runTtlMs)) diagnostics.push({ sourcePath: file, message: `"runTtlMs" must be a positive number` })
    else layer.runTtlMs = raw.runTtlMs
  }

  if (raw.nudgeIdleCycles !== undefined) {
    if (!isPositiveNumber(raw.nudgeIdleCycles)) diagnostics.push({ sourcePath: file, message: `"nudgeIdleCycles" must be a positive number` })
    else layer.nudgeIdleCycles = raw.nudgeIdleCycles
  }

  if (raw.maxNudges !== undefined) {
    if (!isPositiveNumber(raw.maxNudges)) diagnostics.push({ sourcePath: file, message: `"maxNudges" must be a positive number` })
    else layer.maxNudges = raw.maxNudges
  }

  return diagnostics.length === before ? layer : undefined
}

function validateRoles(value: unknown, file: string, diagnostics: ProjectConfigDiagnostic[]): Record<string, RoleDef> | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({ sourcePath: file, message: `"roles" must be an object` })
    return undefined
  }
  const roles: Record<string, RoleDef> = {}
  const before = diagnostics.length
  for (const [name, raw] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(name)) {
      diagnostics.push({ sourcePath: file, message: `unsafe role name "${name}" is not allowed` })
      continue
    }
    if (!isPlainObject(raw) || typeof raw.agent !== "string" || raw.agent.trim() === "") {
      diagnostics.push({ sourcePath: file, message: `role "${name}" must be an object with a non-empty "agent" string` })
      continue
    }
    if (raw.model !== undefined && typeof raw.model !== "string") {
      diagnostics.push({ sourcePath: file, message: `role "${name}": "model" must be a string` })
      continue
    }
    if (raw.variant !== undefined && typeof raw.variant !== "string") {
      diagnostics.push({ sourcePath: file, message: `role "${name}": "variant" must be a string` })
      continue
    }
    if (raw.session !== undefined && raw.session !== "fresh" && raw.session !== "feature") {
      diagnostics.push({ sourcePath: file, message: `role "${name}": "session" must be "fresh" or "feature"` })
      continue
    }
    roles[name] = {
      agent: raw.agent,
      ...(raw.model !== undefined ? { model: raw.model as string } : {}),
      ...(raw.variant !== undefined ? { variant: raw.variant as string } : {}),
      ...(raw.session !== undefined ? { session: raw.session as "fresh" | "feature" } : {}),
    }
  }
  return diagnostics.length === before ? roles : undefined
}

/**
 * Validates raw JSON steps into `StepDef[]` shape-wise only — semantic
 * routing correctness (goto targets exist, roles exist, no unbounded
 * loops) is `validatePipeline`'s job and runs after the whole config is
 * assembled. This only rejects a step that could not safely be cast to
 * `StepDef` at all.
 */
function validatePipelineSteps(
  value: unknown,
  where: string,
  file: string,
  diagnostics: ProjectConfigDiagnostic[],
): readonly StepDef[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push({ sourcePath: file, message: `"pipeline" must be an array` })
    return undefined
  }
  const steps: StepDef[] = []
  const before = diagnostics.length
  for (const [index, raw] of value.entries()) {
    const step = validateStep(raw, `${where}[${index}]`, file, diagnostics)
    if (step !== undefined) steps.push(step)
  }
  return diagnostics.length === before ? steps : undefined
}

function validateStep(value: unknown, where: string, file: string, diagnostics: ProjectConfigDiagnostic[]): StepDef | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({ sourcePath: file, message: `${where}: a step must be an object` })
    return undefined
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    diagnostics.push({ sourcePath: file, message: `${where}: step "id" must be a non-empty string` })
    return undefined
  }
  if (value.type !== "builtin" && value.type !== "command" && value.type !== "agent") {
    diagnostics.push({ sourcePath: file, message: `${where}: step "type" must be "builtin", "command" or "agent"` })
    return undefined
  }
  const base = extractStepBase(value, where, file, diagnostics)
  if (base === undefined) return undefined

  if (value.type === "builtin") {
    if (typeof value.action !== "string" || !(BUILTIN_ACTIONS as readonly string[]).includes(value.action)) {
      diagnostics.push({ sourcePath: file, message: `${where}: builtin step "action" must be one of: ${BUILTIN_ACTIONS.join(", ")}` })
      return undefined
    }
    if (value.params !== undefined && !isStringRecord(value.params)) {
      diagnostics.push({ sourcePath: file, message: `${where}: "params" must be an object of strings` })
      return undefined
    }
    return {
      ...base,
      type: "builtin",
      action: value.action as BuiltinAction,
      ...(value.params !== undefined ? { params: value.params as Readonly<Record<string, string>> } : {}),
    }
  }

  if (value.type === "command") {
    if (!isStringArray(value.run) || value.run.length === 0) {
      diagnostics.push({ sourcePath: file, message: `${where}: command step requires "run" as a non-empty array of strings` })
      return undefined
    }
    if (value.cwd !== undefined && typeof value.cwd !== "string") {
      diagnostics.push({ sourcePath: file, message: `${where}: "cwd" must be a string` })
      return undefined
    }
    if (value.timeout_ms !== undefined && !isPositiveNumber(value.timeout_ms)) {
      diagnostics.push({ sourcePath: file, message: `${where}: "timeout_ms" must be a positive number` })
      return undefined
    }
    return {
      ...base,
      type: "command",
      run: value.run,
      ...(value.cwd !== undefined ? { cwd: value.cwd as string } : {}),
      ...(value.timeout_ms !== undefined ? { timeout_ms: value.timeout_ms as number } : {}),
    } as StepDef
  }

  // agent
  if (typeof value.role !== "string" || value.role.trim() === "") {
    diagnostics.push({ sourcePath: file, message: `${where}: agent step requires a non-empty "role" string` })
    return undefined
  }
  if (value.prompt !== undefined && typeof value.prompt !== "string") {
    diagnostics.push({ sourcePath: file, message: `${where}: "prompt" must be a string` })
    return undefined
  }
  if (value.rounds_with !== undefined && typeof value.rounds_with !== "string") {
    diagnostics.push({ sourcePath: file, message: `${where}: "rounds_with" must be a string` })
    return undefined
  }
  if (value.max_rounds !== undefined && !isPositiveNumber(value.max_rounds)) {
    diagnostics.push({ sourcePath: file, message: `${where}: "max_rounds" must be a positive number` })
    return undefined
  }
  const onVerdict = value.on_verdict !== undefined ? validateOnVerdict(value.on_verdict, where, file, diagnostics) : undefined
  if (value.on_verdict !== undefined && onVerdict === undefined) return undefined
  const publish = value.publish !== undefined ? validatePublishDef(value.publish, where, file, diagnostics) : undefined
  if (value.publish !== undefined && publish === undefined) return undefined

  return {
    ...base,
    type: "agent",
    role: value.role,
    ...(value.prompt !== undefined ? { prompt: value.prompt as string } : {}),
    ...(onVerdict !== undefined ? { on_verdict: onVerdict } : {}),
    ...(publish !== undefined ? { publish } : {}),
    ...(value.rounds_with !== undefined ? { rounds_with: value.rounds_with as string } : {}),
    ...(value.max_rounds !== undefined ? { max_rounds: value.max_rounds as number } : {}),
  } as StepDef
}

function extractStepBase(
  value: Record<string, unknown>,
  where: string,
  file: string,
  diagnostics: ProjectConfigDiagnostic[],
): { id: string; optional?: boolean; then?: string; on_fail?: { goto?: string; max_attempts?: number; escalate?: boolean }; requires_human?: boolean; on_reject?: { goto: string } } | undefined {
  const before = diagnostics.length
  if (value.optional !== undefined && typeof value.optional !== "boolean") {
    diagnostics.push({ sourcePath: file, message: `${where}: "optional" must be a boolean` })
  }
  if (value.then !== undefined && typeof value.then !== "string") {
    diagnostics.push({ sourcePath: file, message: `${where}: "then" must be a string` })
  }
  if (value.requires_human !== undefined && typeof value.requires_human !== "boolean") {
    diagnostics.push({ sourcePath: file, message: `${where}: "requires_human" must be a boolean` })
  }
  let onFail: { goto?: string; max_attempts?: number; escalate?: boolean } | undefined
  if (value.on_fail !== undefined) {
    if (!isPlainObject(value.on_fail)) {
      diagnostics.push({ sourcePath: file, message: `${where}: "on_fail" must be an object` })
    } else {
      const raw = value.on_fail
      if (raw.goto !== undefined && typeof raw.goto !== "string") {
        diagnostics.push({ sourcePath: file, message: `${where}: on_fail.goto must be a string` })
      }
      if (raw.max_attempts !== undefined && !isPositiveNumber(raw.max_attempts)) {
        diagnostics.push({ sourcePath: file, message: `${where}: on_fail.max_attempts must be a positive number` })
      }
      if (raw.escalate !== undefined && typeof raw.escalate !== "boolean") {
        diagnostics.push({ sourcePath: file, message: `${where}: on_fail.escalate must be a boolean` })
      }
      onFail = {
        ...(raw.goto !== undefined ? { goto: raw.goto as string } : {}),
        ...(raw.max_attempts !== undefined ? { max_attempts: raw.max_attempts as number } : {}),
        ...(raw.escalate !== undefined ? { escalate: raw.escalate as boolean } : {}),
      }
    }
  }
  let onReject: { goto: string } | undefined
  if (value.on_reject !== undefined) {
    if (!isPlainObject(value.on_reject) || typeof value.on_reject.goto !== "string") {
      diagnostics.push({ sourcePath: file, message: `${where}: "on_reject" must be an object with a string "goto"` })
    } else {
      onReject = { goto: value.on_reject.goto }
    }
  }
  if (diagnostics.length !== before) return undefined
  return {
    id: value.id as string,
    ...(value.optional !== undefined ? { optional: value.optional as boolean } : {}),
    ...(value.then !== undefined ? { then: value.then as string } : {}),
    ...(onFail !== undefined ? { on_fail: onFail } : {}),
    ...(value.requires_human !== undefined ? { requires_human: value.requires_human as boolean } : {}),
    ...(onReject !== undefined ? { on_reject: onReject } : {}),
  }
}

function validateOnVerdict(
  value: unknown,
  where: string,
  file: string,
  diagnostics: ProjectConfigDiagnostic[],
): Record<string, { goto?: string; next?: boolean }> | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({ sourcePath: file, message: `${where}: "on_verdict" must be an object` })
    return undefined
  }
  const before = diagnostics.length
  const result: Record<string, { goto?: string; next?: boolean }> = {}
  for (const [verdict, route] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(verdict)) {
      diagnostics.push({ sourcePath: file, message: `${where}: unsafe verdict name "${verdict}" is not allowed` })
      continue
    }
    if (!isPlainObject(route)) {
      diagnostics.push({ sourcePath: file, message: `${where}: on_verdict["${verdict}"] must be an object` })
      continue
    }
    if (route.goto !== undefined && typeof route.goto !== "string") {
      diagnostics.push({ sourcePath: file, message: `${where}: on_verdict["${verdict}"].goto must be a string` })
      continue
    }
    if (route.next !== undefined && typeof route.next !== "boolean") {
      diagnostics.push({ sourcePath: file, message: `${where}: on_verdict["${verdict}"].next must be a boolean` })
      continue
    }
    result[verdict] = {
      ...(route.goto !== undefined ? { goto: route.goto as string } : {}),
      ...(route.next !== undefined ? { next: route.next as boolean } : {}),
    }
  }
  return diagnostics.length === before ? result : undefined
}

function validatePublishDef(value: unknown, where: string, file: string, diagnostics: ProjectConfigDiagnostic[]): PublishDef | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({ sourcePath: file, message: `${where}: "publish" must be an object` })
    return undefined
  }
  if (value.mode !== "github-review" && value.mode !== "comment-only" && value.mode !== "none") {
    diagnostics.push({ sourcePath: file, message: `${where}: publish.mode must be "github-review", "comment-only" or "none"` })
    return undefined
  }
  if (value.tokenCommand !== undefined && typeof value.tokenCommand !== "string") {
    diagnostics.push({ sourcePath: file, message: `${where}: publish.tokenCommand must be a string` })
    return undefined
  }
  return {
    mode: value.mode,
    ...(value.tokenCommand !== undefined ? { tokenCommand: value.tokenCommand as string } : {}),
  }
}

function validateReviewPublish(value: unknown, file: string, diagnostics: ProjectConfigDiagnostic[]): Partial<PublishDef> | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({ sourcePath: file, message: `"reviewPublish" must be an object` })
    return undefined
  }
  if (value.mode !== undefined && value.mode !== "github-review" && value.mode !== "comment-only" && value.mode !== "none") {
    diagnostics.push({ sourcePath: file, message: `reviewPublish.mode must be "github-review", "comment-only" or "none"` })
    return undefined
  }
  if (value.tokenCommand !== undefined && typeof value.tokenCommand !== "string") {
    diagnostics.push({ sourcePath: file, message: `reviewPublish.tokenCommand must be a string` })
    return undefined
  }
  return {
    ...(value.mode !== undefined ? { mode: value.mode as PublishDef["mode"] } : {}),
    ...(value.tokenCommand !== undefined ? { tokenCommand: value.tokenCommand as string } : {}),
  }
}

function validateWorkflows(
  value: unknown,
  file: string,
  diagnostics: ProjectConfigDiagnostic[],
): Record<string, { extends?: string; pipeline?: readonly StepDef[] }> | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({ sourcePath: file, message: `"workflows" must be an object` })
    return undefined
  }
  const before = diagnostics.length
  const workflows: Record<string, { extends?: string; pipeline?: readonly StepDef[] }> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(name)) {
      diagnostics.push({ sourcePath: file, message: `unsafe workflow name "${name}" is not allowed` })
      continue
    }
    if (!isPlainObject(raw)) {
      diagnostics.push({ sourcePath: file, message: `workflow "${name}" must be an object` })
      continue
    }
    if (raw.extends !== undefined && typeof raw.extends !== "string") {
      diagnostics.push({ sourcePath: file, message: `workflow "${name}": "extends" must be a string` })
      continue
    }
    let pipeline: readonly StepDef[] | undefined
    if (raw.pipeline !== undefined) {
      pipeline = validatePipelineSteps(raw.pipeline, `workflows.${name}.pipeline`, file, diagnostics)
      if (pipeline === undefined) continue
    }
    workflows[name] = {
      ...(raw.extends !== undefined ? { extends: raw.extends as string } : {}),
      ...(pipeline !== undefined ? { pipeline } : {}),
    }
  }
  return diagnostics.length === before ? workflows : undefined
}

// ---------------------------------------------------------------------------
// Shape guards
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every(item => typeof item === "string")
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Deep-freezes a config candidate so no engine/builtin code can mutate a cached snapshot in place. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
