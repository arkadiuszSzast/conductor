/**
 * Workflow registry — loads, validates and caches each registered
 * project's `conductor.yaml`, and exposes a stable, disk-free resolver
 * for the graph engine.
 *
 * `register`/`reload`/`unregister` are the only mutating operations, and
 * are explicit and synchronous — the registry does not watch the
 * filesystem. `resolve`/`resolver` never touch disk: lookups go through
 * an in-memory alias map (literal path → canonical path, populated at
 * registration time) to the last successfully published snapshot, so the
 * returned resolver is a safe, disk-free closure to hand to the engine.
 * A `reload` that fails to produce a valid workflow — including a
 * transient failure to stat/canonicalize the project directory — leaves
 * the previous valid snapshot in place: an edited-but-broken
 * `conductor.yaml` must never blank out a live project's workflow out
 * from under active features.
 *
 * One file per project — no `extends`, no bundled presets, no global
 * layering. That composition belonged to the deleted seed pipeline
 * format; `conductor.yaml` is one file, full stop.
 */

import { readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { parseWorkflow, validateWorkflow } from "@conductor/core"
import type { WorkflowDef } from "@conductor/core"
import { checkWorkflowReservation } from "./workflow-reservation.ts"
import type { ResolvedActionBindings } from "./workflow-reservation.ts"
import type { LoadedActionRegistry } from "./action-registry.ts"

const WORKFLOW_RELATIVE_PATH = "conductor.yaml"
const MAX_SOURCE_BYTES = 1_048_576

export interface WorkflowRegistryOptions {
  /** Resolves `action` steps at load time. Absent → any `action` step is invalid. */
  readonly actionRegistry?: LoadedActionRegistry
}

export interface WorkflowSnapshot {
  readonly projectDir: string
  readonly workflow: WorkflowDef
  readonly source: string
  /** Non-fatal warnings surfaced by structural validation. */
  readonly warnings: readonly string[]
  readonly loadedAt: number
  readonly actionBindings: ResolvedActionBindings
}

export interface WorkflowDiagnostic {
  readonly sourcePath: string
  /** Full diagnostic — for an action-resolution failure this can embed
   *  the action manifest's `sourcePath` and/or the daemon's configured
   *  action registry search paths, both absolute daemon-local
   *  filesystem paths, in addition to `sourcePath` above (the project's
   *  own `conductor.yaml`, already a known, deliberate exception the
   *  daemon's own operator-facing health surface reports as a
   *  structured field). Operator/log use only. */
  readonly message: string
  /** The same diagnostic with every embedded filesystem path removed —
   *  still names the failing job/step/action reference, the reason, and
   *  (for a missing action version) the available versions. Every
   *  diagnostic kind other than action-resolution never embedded a path
   *  in `message` to begin with, so `safeMessage` equals `message` for
   *  those. The one browser-facing consumer (`GET /v1/projects/workflow`)
   *  must always read `safeMessage`, never `message`. */
  readonly safeMessage: string
}

export type LoadResult =
  | { readonly ok: true; readonly snapshot: WorkflowSnapshot }
  | { readonly ok: false; readonly diagnostics: readonly WorkflowDiagnostic[] }

export type WorkflowStatus =
  | { readonly state: "unregistered" }
  /** Registered, loaded and currently valid. */
  | { readonly state: "valid"; readonly snapshot: WorkflowSnapshot }
  /**
   * A prior valid load exists and is still what `resolve` returns, but
   * the most recent `reload` failed — the stale snapshot is being served
   * deliberately, not accidentally.
   */
  | { readonly state: "stale"; readonly snapshot: WorkflowSnapshot; readonly diagnostics: readonly WorkflowDiagnostic[] }
  /** Registered, but no valid load has ever succeeded. */
  | { readonly state: "invalid"; readonly diagnostics: readonly WorkflowDiagnostic[] }

interface RegistryEntry {
  /** Canonical (realpath'd) project directory — the resolver key. */
  readonly canonicalDir: string
  status: WorkflowStatus
}

/** Disk-free `projectDir → WorkflowSnapshot | null` closure the engine dispatches through. */
export type WorkflowResolver = (projectDir: string) => WorkflowSnapshot | null

export class WorkflowRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  /** Literal (as-registered) path → canonical entry key. Populated only by explicit operations, so lookups stay disk-free. */
  private readonly aliases = new Map<string, string>()
  private readonly actionRegistry: LoadedActionRegistry | undefined

  /**
   * Stable, disk-free resolver closure — bind once and hand to the
   * engine. Reads only in-memory maps; never touches the filesystem.
   */
  readonly resolver: WorkflowResolver = (projectDir: string) => this.resolve(projectDir)

  constructor(options: WorkflowRegistryOptions = {}) {
    this.actionRegistry = options.actionRegistry
  }

  /**
   * Load a project for the first time (or re-load an already-registered
   * one — equivalent to `reload`). The project directory must exist;
   * canonicalization (`realpathSync`) happens before the workflow file
   * is read, so a project is always keyed by its real, symlink-resolved
   * path, and the literal registration path becomes a disk-free alias.
   */
  register(projectDir: string): LoadResult {
    return this.reload(projectDir)
  }

  /**
   * Re-read and re-validate a project's `conductor.yaml` from disk. On
   * success the new snapshot replaces whatever was cached. On failure —
   * including a transient failure to stat/canonicalize the project
   * directory — the LAST VALID snapshot (if any) is preserved and
   * reported as `"stale"` by `getStatus`/`resolve`: a broken edit never
   * blanks a live project's workflow out from under active features.
   */
  reload(projectDir: string): LoadResult {
    let canonicalDir: string
    try {
      canonicalDir = canonicalizeProjectDir(projectDir)
    } catch (error) {
      // `canonicalizationErrorMessage` embeds `projectDir` — but that is
      // the SAME path the caller supplied via `?dir=` on this very
      // request, not daemon-configured deployment layout (unlike an
      // action registry's search paths, which the client has no way of
      // already knowing). `safeMessage` equals `message` here.
      const message = canonicalizationErrorMessage(error, projectDir)
      const diagnostics = [{ sourcePath: projectDir, message, safeMessage: message }]
      this.recordFailure(this.entryKey(projectDir), diagnostics)
      return { ok: false, diagnostics }
    }

    this.aliases.set(projectDir, canonicalDir)
    if (projectDir !== canonicalDir) this.entries.delete(projectDir)
    const result = loadWorkflow(canonicalDir, this.actionRegistry)

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
   * Synchronous, disk-free lookup: the engine's workflow resolver shape.
   * Returns the last valid snapshot (even if the most recent reload
   * failed and the entry is `"stale"`), or `null` if the project was
   * never successfully loaded.
   */
  resolve(projectDir: string): WorkflowSnapshot | null {
    const entry = this.entries.get(this.entryKey(projectDir))
    if (!entry) return null
    if (entry.status.state === "valid" || entry.status.state === "stale") return entry.status.snapshot
    return null
  }

  /** Status for one project — `"unregistered"` if it was never `register`ed (or was `unregister`ed). */
  getStatus(projectDir: string): WorkflowStatus {
    return this.entries.get(this.entryKey(projectDir))?.status ?? { state: "unregistered" }
  }

  /** All registered projects (canonical directories) and their current status. */
  list(): ReadonlyArray<{ readonly projectDir: string; readonly status: WorkflowStatus }> {
    return [...this.entries.values()]
      .map(entry => ({ projectDir: entry.canonicalDir, status: entry.status }))
      .sort((left, right) => compareText(left.projectDir, right.projectDir))
  }

  private entryKey(projectDir: string): string {
    return this.aliases.get(projectDir) ?? projectDir
  }

  private recordFailure(key: string, diagnostics: readonly WorkflowDiagnostic[]): void {
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
// Loading + validation
// ---------------------------------------------------------------------------

function loadWorkflow(canonicalDir: string, actionRegistry: LoadedActionRegistry | undefined): LoadResult {
  const sourcePath = join(canonicalDir, WORKFLOW_RELATIVE_PATH)

  // Every diagnostic in this function names `sourcePath` — the project's
  // OWN `conductor.yaml`, i.e. exactly the path the caller already
  // supplied via `?dir=`/registration, not daemon-configured deployment
  // layout — so `safeMessage` equals `message` for all of them EXCEPT
  // the action-reservation diagnostics below, which embed a resolved
  // action's `sourcePath` (a bundled/local action manifest file the
  // daemon operator configured, never supplied by the caller) and the
  // daemon's configured action registry search paths; those two must
  // use `diagnostic.safeMessage`, never `diagnostic.message`.
  let raw: string
  try {
    const info = statSync(sourcePath)
    if (!info.isFile()) {
      const message = "conductor.yaml exists but is not a file"
      return { ok: false, diagnostics: [{ sourcePath, message, safeMessage: message }] }
    }
    if (info.size > MAX_SOURCE_BYTES) {
      const message = `conductor.yaml exceeds ${MAX_SOURCE_BYTES} bytes`
      return { ok: false, diagnostics: [{ sourcePath, message, safeMessage: message }] }
    }
    raw = readFileSync(sourcePath, "utf8")
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    const message = code === "ENOENT" ? "conductor.yaml not found" : `cannot read conductor.yaml: ${errorMessage(error)}`
    return { ok: false, diagnostics: [{ sourcePath, message, safeMessage: message }] }
  }

  const parsed = parseWorkflow(raw)
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: parsed.errors.map(error => {
        const message = `${error.message} (line ${error.line}, col ${error.col})`
        return { sourcePath, message, safeMessage: message }
      }),
    }
  }

  const validation = validateWorkflow(parsed.workflow)
  if (validation.errors.length > 0) {
    return {
      ok: false,
      diagnostics: validation.errors.map(message => ({ sourcePath, message, safeMessage: message })),
    }
  }

  const hasActionSteps = Object.values(parsed.workflow.jobs).some(job =>
    job.steps.some(step => step.type === "action"),
  )

  let actionBindings: ResolvedActionBindings = {}
  if (hasActionSteps) {
    if (!actionRegistry) {
      const message = "action steps require a configured action registry"
      return { ok: false, diagnostics: [{ sourcePath, message, safeMessage: message }] }
    }
    const reservation = checkWorkflowReservation(parsed.workflow, actionRegistry)
    if (!reservation.ok) {
      return {
        ok: false,
        diagnostics: reservation.diagnostics.map(diagnostic => ({
          sourcePath,
          message: `job "${diagnostic.jobId}" step "${diagnostic.stepId}" (${diagnostic.uses}): ${diagnostic.message}`,
          // `diagnostic.safeMessage` — never the action-source or
          // registry-search-path detail carried in `diagnostic.message`.
          safeMessage: `job "${diagnostic.jobId}" step "${diagnostic.stepId}" (${diagnostic.uses}): ${diagnostic.safeMessage}`,
        })),
      }
    }
    actionBindings = reservation.reservation.actionBindings
  }

  const snapshot: WorkflowSnapshot = deepFreeze({
    projectDir: canonicalDir,
    workflow: parsed.workflow,
    source: sourcePath,
    warnings: validation.warnings,
    loadedAt: Date.now(),
    actionBindings,
  })
  return { ok: true, snapshot }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Deep-freezes a snapshot candidate so no engine code can mutate a cached snapshot in place. */
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
