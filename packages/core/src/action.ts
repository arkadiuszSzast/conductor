/**
 * Local action registry — the pure core of workflow-format section 3.
 *
 * Actions are versioned, manifest-declared capabilities invoked from
 * `action` steps via `uses: <name>@v<version>`. This module owns the
 * immutable manifest IR, the registry shape, manifest validation, pure
 * resolution against the registry, `with:` input validation, the content
 * digest used to pin a resolved version in a run, and the JSON protocol
 * envelope types. Everything here is config-agnostic and I/O-free: the
 * daemon supplies the registry contents (bundled + configured paths) and
 * the executor (task 3.2+). The workflow validator stays registry-free —
 * resolution is a pre-start check, not a `validateWorkflow` concern.
 */

import { createHash } from "node:crypto"
import { extractExpressions } from "./template.ts"

// ---------------------------------------------------------------------------
// Capabilities and typed IO vocabulary
// ---------------------------------------------------------------------------

/** The capability vocabulary. Declarations are guardrails and audit, not a
 *  security boundary; enforcement is the daemon's (task 3.2). */
export type ActionCapability = "filesystem" | "process" | "network" | "git" | "credentials"

export const ACTION_CAPABILITIES: readonly ActionCapability[] = [
  "filesystem",
  "process",
  "network",
  "git",
  "credentials",
]

export type ActionInputType = "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]"

export const ACTION_INPUT_TYPES: readonly ActionInputType[] = [
  "string",
  "number",
  "boolean",
  "string[]",
  "number[]",
  "boolean[]",
]

/** A literal value an input can carry (before templates are rendered). */
export type ActionInputValue = string | number | boolean | readonly (string | number | boolean)[]

/** An input is either required or has a default — never both, never neither,
 *  mirroring the workflow `InputDef` pattern. */
export type ActionInputDef =
  | { readonly type: ActionInputType; readonly presence: "required" }
  | { readonly type: ActionInputType; readonly presence: "optional"; readonly default: ActionInputValue }

/** Declared output contract: output name → type. The executor must honour
 *  it; consumers read action outputs as dynamically-typed (unknown). */
export type ActionOutputs = Readonly<Record<string, ActionInputType>>

// ---------------------------------------------------------------------------
// Manifest IR
// ---------------------------------------------------------------------------

/** Where the action's implementation lives. A subprocess speaks the JSON
 *  protocol over stdio; an in-process action is a handler the daemon
 *  registers by name. The engine has no action-name switch either way. */
export type ActionExecution =
  | { readonly kind: "process"; readonly command: readonly string[] }
  | { readonly kind: "inprocess"; readonly handler: string }

export interface ActionManifest {
  readonly name: string
  /** "major.minor.patch" — resolved via `uses: <name>@v<major>`. */
  readonly version: string
  readonly description?: string
  readonly inputs: Readonly<Record<string, ActionInputDef>>
  readonly outputs: ActionOutputs
  readonly capabilities: readonly ActionCapability[]
  readonly run: ActionExecution
}

// ---------------------------------------------------------------------------
// Registry — immutable map name → versioned manifests
// ---------------------------------------------------------------------------

export interface ActionRegistryEntry {
  readonly manifest: ActionManifest
  /** Load-time provenance (where the daemon read the manifest from). The
   *  resolver never reads it; diagnostics quote it so pre-start errors name
   *  the registry paths that were searched. */
  readonly sourcePath?: string
}

export type ActionRegistry = Readonly<Record<string, readonly ActionRegistryEntry[]>>

/** Group entries by their manifest's name — the registry key a `uses`
 *  reference is resolved against. Keeps key ↔ manifest.name consistent. */
export function buildActionRegistry(entries: readonly ActionRegistryEntry[]): ActionRegistry {
  const registry = new Map<string, ActionRegistryEntry[]>()
  for (const entry of entries) {
    const list = registry.get(entry.manifest.name)
    if (list === undefined) registry.set(entry.manifest.name, [entry])
    else list.push(entry)
  }
  return Object.freeze(Object.fromEntries(
    [...registry.entries()].map(([name, grouped]) => [name, Object.freeze(grouped)]),
  ))
}

// ---------------------------------------------------------------------------
// Action reference parsing — `uses: <name>@v<version>`
// ---------------------------------------------------------------------------

export interface ActionRef {
  readonly name: string
  /** `[1]` for `@v1`, `[1, 2]` for `@v1.2`, `[1, 2, 3]` for `@v1.2.3`. */
  readonly versionRef: readonly number[]
}

export type ParseActionRefResult =
  | { readonly ok: true; readonly ref: ActionRef }
  | { readonly ok: false; readonly error: string }

const ACTION_NAME_PATTERN = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/
const ACTION_VERSION_REF_PATTERN = /^v[0-9]+(?:\.[0-9]+){0,2}$/

export function parseActionRef(uses: string): ParseActionRefResult {
  const at = uses.lastIndexOf("@")
  if (at === -1) {
    return {
      ok: false,
      error: `invalid action reference "${uses}" — expected <name>@v<version>, e.g. "git/push@v1"`,
    }
  }
  const name = uses.slice(0, at)
  const version = uses.slice(at + 1)
  if (!ACTION_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `invalid action name "${name}" in "${uses}" — names are lowercase segments joined by "/", e.g. "git/push"`,
    }
  }
  if (!ACTION_VERSION_REF_PATTERN.test(version)) {
    return {
      ok: false,
      error: `invalid action version "${version}" in "${uses}" — expected @v<major> or @v<major>.<minor>.<patch>, e.g. "@v1"`,
    }
  }
  return { ok: true, ref: { name, versionRef: version.slice(1).split(".").map(part => Number(part)) } }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolveActionResult =
  | { readonly ok: true; readonly manifest: ActionManifest; readonly digest: string }
  | { readonly ok: false; readonly error: string }

/** Resolve `uses` against the registry: exact name lookup, then the highest
 *  manifest matching the version reference (a major ref tracks the newest
 *  minor/patch on that line). Deterministic, I/O-free; the digest is computed
 *  from the resolved manifest's canonical content. */
export function resolveAction(uses: string, registry: ActionRegistry): ResolveActionResult {
  const parsed = parseActionRef(uses)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const entries = registry[parsed.ref.name]
  if (entries === undefined) {
    return { ok: false, error: missingActionDiagnostic(parsed.ref, uses, registry) }
  }

  const matched = matchVersion(entries, parsed.ref)
  if (matched === undefined) {
    return { ok: false, error: missingVersionDiagnostic(parsed.ref, uses, entries) }
  }

  return { ok: true, manifest: matched.manifest, digest: computeActionDigest(matched.manifest) }
}

function matchVersion(entries: readonly ActionRegistryEntry[], ref: ActionRef): ActionRegistryEntry | undefined {
  let best: ActionRegistryEntry | undefined
  let bestVersion: readonly number[] | undefined
  for (const entry of entries) {
    const candidate = parseManifestVersion(entry.manifest.version)
    if (candidate === undefined || !versionMatches(candidate, ref.versionRef)) continue
    if (best === undefined || compareVersions(candidate, bestVersion!) > 0) {
      best = entry
      bestVersion = candidate
    }
  }
  return best
}

function parseManifestVersion(version: string): readonly number[] | undefined {
  if (!/^[0-9]+(?:\.[0-9]+){2}$/.test(version)) return undefined
  return version.split(".").map(part => Number(part))
}

function versionMatches(candidate: readonly number[], ref: readonly number[]): boolean {
  if (ref.length > candidate.length) return false
  for (let i = 0; i < ref.length; i++) {
    if (candidate[i] !== ref[i]) return false
  }
  return true
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

// ---------------------------------------------------------------------------
// Resolution diagnostics — built purely from the reference and the registry
// ---------------------------------------------------------------------------

function missingActionDiagnostic(ref: ActionRef, uses: string, registry: ActionRegistry): string {
  const allEntries = Object.values(registry).flat()
  if (allEntries.length === 0) {
    return `action "${uses}" is not in the registry — no entry named "${ref.name}" (searched paths: none — the registry is empty); configure an action registry providing a "${ref.name}" action`
  }
  const names = [...new Set(allEntries.map(entry => entry.manifest.name))].sort().join(", ")
  return `action "${uses}" is not in the registry — no entry named "${ref.name}" (${describePaths(allEntries)}); registry provides: ${names}`
}

function missingVersionDiagnostic(ref: ActionRef, uses: string, entries: readonly ActionRegistryEntry[]): string {
  const available = formatAvailableVersions(entries)
  return (
    `action "${uses}" is not in the registry — "${ref.name}" has no ${formatVersionRef(ref.versionRef)} ` +
    `(${describePaths(entries)}); available: ${available}`
  )
}

function describePaths(entries: readonly ActionRegistryEntry[]): string {
  const paths = entries.map(entry => entry.sourcePath ?? `${entry.manifest.name}@v${entry.manifest.version}`)
  return `searched paths: ${paths.join(", ")}`
}

function formatVersionRef(ref: readonly number[]): string {
  return `v${ref.join(".")}`
}

function formatAvailableVersions(entries: readonly ActionRegistryEntry[]): string {
  const byMajor = new Map<number, (readonly number[])[]>()
  for (const entry of entries) {
    const version = parseManifestVersion(entry.manifest.version)
    if (version === undefined) continue
    const major = version[0] ?? 0
    let list = byMajor.get(major)
    if (list === undefined) {
      list = []
      byMajor.set(major, list)
    }
    list.push(version)
  }
  const lines: string[] = []
  for (const [major, versions] of [...byMajor.entries()].sort((a, b) => a[0] - b[0])) {
    const formatted = [...versions].sort(compareVersions).map(version => version.join("."))
    lines.push(`v${major} (${formatted.join(", ")})`)
  }
  return lines.length > 0 ? lines.join("; ") : "none"
}

// ---------------------------------------------------------------------------
// Content digest
// ---------------------------------------------------------------------------

/** SHA-256 of the manifest's canonical content (keys sorted, so the digest
 *  is independent of insertion order). Pins the exact resolved manifest —
 *  identity, version, IO contract, capabilities and entry point — for the
 *  run; the daemon records it (task 3.2). */
export function computeActionDigest(manifest: ActionManifest): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex")
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Manifest validation (semantic invariants — shape is the parser's job)
// ---------------------------------------------------------------------------

/** Validates a manifest IR (or any runtime-loaded value): name/version
 *  format, capability vocabulary, typed IO and the execution entry point. */
export function validateActionManifest(value: unknown): readonly string[] {
  const errors: string[] = []
  if (!isRecord(value)) {
    return ["an action manifest must be a mapping"]
  }

  const name = value.name
  if (typeof name !== "string" || !ACTION_NAME_PATTERN.test(name)) {
    errors.push(`manifest "name" must be lowercase segments joined by "/" (e.g. "git/push") — got ${describe(value.name)}`)
  }

  const version = value.version
  if (typeof version !== "string" || !/^[0-9]+(?:\.[0-9]+){2}$/.test(version)) {
    errors.push(`manifest "version" must be "<major>.<minor>.<patch>" (e.g. "1.2.0") — got ${describe(value.version)}`)
  }

  if (value.description !== undefined && typeof value.description !== "string") {
    errors.push('manifest "description" must be a string')
  }

  validateInputDefs(value.inputs, errors)
  validateOutputs(value.outputs, errors)
  validateCapabilities(value.capabilities, errors)
  validateExecution(value.run, errors)

  return errors
}

function validateInputDefs(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('manifest "inputs" must be a mapping of input name → { type, presence, default? }')
    return
  }
  for (const [name, def] of Object.entries(value)) {
    const where = `input "${name}"`
    if (!isRecord(def)) {
      errors.push(`${where}: must be a mapping — { type, presence, default? }`)
      continue
    }
    const type = def.type
    if (typeof type !== "string" || !(ACTION_INPUT_TYPES as readonly string[]).includes(type)) {
      errors.push(`${where}: type must be one of: ${ACTION_INPUT_TYPES.join(", ")} — got ${describe(type)}`)
      continue
    }
    const presence = def.presence
    if (presence === "required") {
      if ("default" in def) {
        errors.push(`${where}: required and default are mutually exclusive — an input is either required or has a default`)
      }
    } else if (presence === "optional") {
      if (!("default" in def)) {
        errors.push(`${where}: an optional input must declare a default — an input is never both, never neither`)
      } else if (!matchesInputType(def.default, type as ActionInputType)) {
        errors.push(`${where}: default must match the declared type ${type}`)
      }
    } else {
      errors.push(`${where}: presence must be "required" or "optional" — got ${describe(presence)}`)
    }
  }
}

function validateOutputs(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('manifest "outputs" must be a mapping of output name → type')
    return
  }
  for (const [name, type] of Object.entries(value)) {
    if (typeof type !== "string" || !(ACTION_INPUT_TYPES as readonly string[]).includes(type)) {
      errors.push(`output "${name}": type must be one of: ${ACTION_INPUT_TYPES.join(", ")} — got ${describe(type)}`)
    }
  }
}

function validateCapabilities(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('manifest "capabilities" must be a list')
    return
  }
  for (const capability of value) {
    if (typeof capability !== "string" || !(ACTION_CAPABILITIES as readonly string[]).includes(capability)) {
      errors.push(
        `capability ${describe(capability)} is not in the capability vocabulary — allowed: ${ACTION_CAPABILITIES.join(", ")}`,
      )
    }
  }
}

function validateExecution(value: unknown, errors: string[]): void {
  if (!isRecord(value) || (value.kind !== "process" && value.kind !== "inprocess")) {
    errors.push('manifest "run" must be { kind: "process", command: [...] } or { kind: "inprocess", handler: "..." }')
    return
  }
  if (value.kind === "process") {
    const command = value.command
    if (!Array.isArray(command) || command.length === 0) {
      errors.push('manifest "run.command" must be a non-empty list of command arguments')
      return
    }
    for (const [index, arg] of command.entries()) {
      if (typeof arg !== "string" || arg.trim() === "") {
        errors.push(`manifest "run.command[${index}]" must be a non-empty string`)
      }
    }
    return
  }
  if (typeof value.handler !== "string" || value.handler.trim() === "") {
    errors.push('manifest "run.handler" must be a non-empty string')
  }
}

// ---------------------------------------------------------------------------
// `with:` input validation — checked at reservation, not in validateWorkflow
// ---------------------------------------------------------------------------

export function matchesInputType(value: unknown, type: ActionInputType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "boolean":
      return typeof value === "boolean"
    case "string[]":
      return isScalarArray(value, "string")
    case "number[]":
      return isScalarArray(value, "number")
    case "boolean[]":
      return isScalarArray(value, "boolean")
  }
}

function isScalarArray(value: unknown, kind: "string" | "number" | "boolean"): boolean {
  if (!Array.isArray(value)) return false
  return value.every(item => typeof item === kind && (kind !== "number" || Number.isFinite(item)))
}

/** Validate a step's `with:` payload against the manifest's typed inputs.
 *  Unknown keys are rejected; required inputs must be present; literal
 *  values must match their declared type. A value that is a `{{ ... }}`
 *  template defers the type check — its rendered type is unknown before the
 *  run — to dispatch-time enforcement (task 3.2). */
export function validateActionInputs(
  manifest: ActionManifest,
  values: Readonly<Record<string, unknown>>,
): readonly string[] {
  const errors: string[] = []
  const where = `action "${manifest.name}@v${manifest.version}"`

  for (const name of Object.keys(values)) {
    if (!(name in manifest.inputs)) {
      const declared = Object.keys(manifest.inputs)
      errors.push(
        declared.length > 0
          ? `input "${name}" is not declared by ${where} — declared inputs: ${declared.join(", ")}`
          : `input "${name}" is not declared by ${where} — the action declares no inputs`,
      )
    }
  }

  for (const [name, def] of Object.entries(manifest.inputs)) {
    const inputWhere = `input "${name}"`
    const value = values[name]
    if (def.presence === "required") {
      if (value === undefined) {
        errors.push(`${inputWhere} is required by ${where}`)
        continue
      }
    } else if (value === undefined) {
      continue // the manifest's default applies
    }
    if (isDeferredTemplate(value)) continue
    if (!matchesInputType(value, def.type)) {
      errors.push(`${inputWhere} must be a ${def.type} — got ${describe(value)}`)
    }
  }

  return errors
}

/** A `{{ ... }}` template's rendered type is unknown until the run renders
 *  it, so its type check moves to dispatch-time enforcement. */
function isDeferredTemplate(value: unknown): boolean {
  return typeof value === "string" && extractExpressions(value).length > 0
}

function describe(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// JSON execution protocol — envelope types only (execution/enforcement: 3.2)
// ---------------------------------------------------------------------------

/** What an action receives: feature/step identity, its working directory,
 *  typed inputs after defaults are applied, and the capabilities its
 *  manifest declared (the daemon enforces them; the action never touches the
 *  interpreter or SQLite store). */
export interface ActionRunContext {
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly workdir: string
  readonly inputs: Readonly<Record<string, unknown>>
  readonly capabilities: readonly ActionCapability[]
}

/** What an action returns. `pending`/polling is deliberately absent — the
 *  durable pending protocol arrives with the polling work (task 3.2+). */
export type ActionResult =
  | { readonly status: "succeeded"; readonly outputs: Readonly<Record<string, unknown>> }
  | { readonly status: "failed"; readonly error: string }
