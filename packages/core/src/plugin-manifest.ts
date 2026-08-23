/**
 * Plugin manifest YAML → PluginManifest.
 *
 * Mirrors `action-manifest.ts` for the plugin authoring surface: the
 * parser owns shape and syntax (required fields, panel metadata, optional
 * backend argv, capability list) with source-mapped, closest-field errors
 * and the same strictness (no aliases/anchors/tags, unique keys, bounded
 * size and depth). Semantic invariants (id format, version bounds,
 * capability vocabulary) stay in `validatePluginManifest` — the registry
 * validates after loading, exactly like `validateActionManifest` for
 * actions. Schema-version support (declared version vs. what the daemon
 * understands) is a registry concern, not a parse/validate one; only the
 * `SUPPORTED_PLUGIN_MANIFEST_VERSION` constant lives here for reuse.
 */

import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml"
import type { Node, YAMLMap, YAMLSeq } from "yaml"
import type { ActionCapability } from "./action.ts"
import { ACTION_CAPABILITIES } from "./action.ts"

export interface PluginManifestPanel {
  readonly title: string
  readonly icon?: string
}

export interface PluginManifestBackend {
  readonly run: readonly string[]
}

export interface PluginManifest {
  readonly id: string
  readonly version: number
  readonly panel: PluginManifestPanel
  readonly backend?: PluginManifestBackend
  readonly capabilities: readonly ActionCapability[]
}

export const SUPPORTED_PLUGIN_MANIFEST_VERSION = 1 as const

export interface ParsePluginManifestError {
  readonly message: string
  /** 1-based source position of the offending node. */
  readonly line: number
  readonly col: number
}

export type ParsePluginManifestResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly errors: readonly ParsePluginManifestError[] }

const MAX_SOURCE_LENGTH = 1_048_576
const MAX_DEPTH = 64

export function parsePluginManifest(source: string): ParsePluginManifestResult {
  if (new TextEncoder().encode(source).length > MAX_SOURCE_LENGTH) {
    return { ok: false, errors: [{ message: `document exceeds ${MAX_SOURCE_LENGTH} bytes`, line: 1, col: 1 }] }
  }

  const lineCounter = new LineCounter()
  const doc = parseDocument(source, { lineCounter, prettyErrors: false, stringKeys: true, uniqueKeys: true })
  const reader = new Reader(lineCounter)

  for (const issue of [...doc.errors, ...doc.warnings]) {
    reader.errorAtOffset(issue.pos[0], describeYamlIssue(issue.code, issue.message))
  }
  if (reader.errors.length > 0) return { ok: false, errors: reader.errors }

  rejectUnsafeNodes(doc.contents, reader)
  if (reader.errors.length > 0) return { ok: false, errors: reader.errors }

  const root = doc.contents
  if (!isMap(root)) {
    reader.error(root, "a plugin manifest must be a mapping with plugin, version, panel")
    return { ok: false, errors: reader.errors }
  }

  const manifest = readManifest(root, reader)
  return reader.errors.length > 0 ? { ok: false, errors: reader.errors } : { ok: true, manifest }
}

function describeYamlIssue(code: string, message: string): string {
  switch (code) {
    case "DUPLICATE_KEY":
      return "duplicate mapping key — every key must be unique"
    case "MULTIPLE_DOCS":
      return "multiple YAML documents in one file — a manifest is a single document"
    case "TAG_RESOLVE_FAILED":
      return "custom tags are not allowed"
    default:
      return message
  }
}

function rejectUnsafeNodes(contents: unknown, reader: Reader): void {
  let tooDeep = false
  visit(contents as Parameters<typeof visit>[0], (_key, node, path) => {
    if (path.length > MAX_DEPTH) {
      if (!tooDeep) {
        tooDeep = true
        reader.error(node, `document nests deeper than ${MAX_DEPTH} levels`)
      }
      return visit.BREAK
    }
    if (isAlias(node)) {
      reader.error(node, "YAML aliases are not allowed")
      return undefined
    }
    const marked = node as { anchor?: string; tag?: string }
    if (marked.anchor !== undefined) reader.error(node, "YAML anchors are not allowed")
    if (marked.tag !== undefined) reader.error(node, "YAML tags are not allowed")
    return undefined
  })
}

class Reader {
  readonly errors: ParsePluginManifestError[] = []

  constructor(private readonly lineCounter: LineCounter) {}

  error(node: unknown, message: string): void {
    const range = (node as { range?: readonly [number, number, number] } | null | undefined)?.range
    if (range) {
      this.errorAtOffset(range[0], message)
    } else {
      this.errors.push({ message, line: 1, col: 1 })
    }
  }

  errorAtOffset(offset: number, message: string): void {
    const { line, col } = this.lineCounter.linePos(offset)
    this.errors.push({ message, line, col })
  }
}

type Fields = Map<string, { readonly key: Node; readonly value: Node | null }>

function readFields(map: YAMLMap, where: string, allowed: readonly string[], reader: Reader): Fields {
  const fields: Fields = new Map()
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, `${where}: mapping keys must be strings`)
      continue
    }
    const name = key.value
    if (!allowed.includes(name)) {
      reader.error(key, `${where}: ${unknownField(name, allowed)}`)
      continue
    }
    fields.set(name, { key, value: (pair.value ?? null) as Node | null })
  }
  return fields
}

function unknownField(name: string, allowed: readonly string[]): string {
  if (allowed.length === 0) return `unknown field "${name}" — this block carries no fields`
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of allowed) {
    const distance = levenshtein(name, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(name.length / 3))
    ? `unknown field "${name}" — did you mean "${best}"?`
    : `unknown field "${name}" — allowed: ${allowed.join(", ")}`
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const substitution = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      diagonal = previous[j]!
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, substitution)
    }
  }
  return previous[b.length]!
}

function readString(node: Node | null, where: string, reader: Reader): string | undefined {
  if (node !== null && isScalar(node) && typeof node.value === "string") return node.value
  reader.error(node, `${where} must be a string`)
  return undefined
}

function readNumber(node: Node | null, where: string, reader: Reader): number | undefined {
  if (node !== null && isScalar(node) && typeof node.value === "number" && Number.isFinite(node.value)) {
    return node.value
  }
  reader.error(node, `${where} must be a number`)
  return undefined
}

function readInteger(node: Node | null, where: string, reader: Reader): number | undefined {
  const value = readNumber(node, where, reader)
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) {
    reader.error(node, `${where} must be an integer`)
    return undefined
  }
  return value
}

function readMap(node: Node | null, where: string, reader: Reader): YAMLMap | undefined {
  if (node !== null && isMap(node)) return node
  reader.error(node, `${where} must be a mapping`)
  return undefined
}

function readSeq(node: Node | null, where: string, reader: Reader): YAMLSeq | undefined {
  if (node !== null && isSeq(node)) return node
  reader.error(node, `${where} must be a list`)
  return undefined
}

function readStringSeq(node: Node | null, where: string, reader: Reader): readonly string[] | undefined {
  const seq = readSeq(node, where, reader)
  if (seq === undefined) return undefined
  const items: string[] = []
  for (const [index, item] of seq.items.entries()) {
    const value = readString((item ?? null) as Node | null, `${where}[${index}]`, reader)
    if (value !== undefined) items.push(value)
  }
  return items
}

function readEnum<T extends string>(node: Node | null, where: string, values: readonly T[], reader: Reader): T | undefined {
  if (node !== null && isScalar(node) && typeof node.value === "string" && (values as readonly string[]).includes(node.value)) {
    return node.value as T
  }
  reader.error(node, `${where} must be one of: ${values.join(", ")}`)
  return undefined
}

function requireField(fields: Fields, name: string, owner: YAMLMap, where: string, reader: Reader): Node | null | undefined {
  const field = fields.get(name)
  if (field === undefined) {
    reader.error(owner, `${where}: missing required field "${name}"`)
    return undefined
  }
  return field.value
}

function readManifest(root: YAMLMap, reader: Reader): PluginManifest {
  const fields = readFields(root, "manifest", ["plugin", "version", "panel", "backend", "capabilities"], reader)

  const idNode = requireField(fields, "plugin", root, "manifest", reader)
  const id = idNode === undefined ? "" : readString(idNode, "manifest: plugin", reader) ?? ""

  const versionNode = requireField(fields, "version", root, "manifest", reader)
  const version = versionNode === undefined ? 0 : readInteger(versionNode, "manifest: version", reader) ?? 0

  const panelNode = requireField(fields, "panel", root, "manifest", reader)
  const panel = panelNode === undefined ? undefined : readPanel(panelNode, reader)

  const backend = fields.has("backend") ? readBackend(fields.get("backend")!.value, reader) : undefined

  const capabilities = fields.has("capabilities")
    ? readCapabilities(fields.get("capabilities")!.value, reader)
    : []

  return {
    id,
    version,
    panel: panel ?? { title: "" },
    capabilities,
    ...(backend !== undefined ? { backend } : {}),
  }
}

function readPanel(node: Node | null, reader: Reader): PluginManifestPanel | undefined {
  const map = readMap(node, "panel", reader)
  if (map === undefined) return undefined
  const fields = readFields(map, "panel", ["title", "icon"], reader)

  const titleNode = requireField(fields, "title", map, "panel", reader)
  const title = titleNode === undefined ? undefined : readString(titleNode, "panel: title", reader)

  const icon = fields.has("icon") ? readString(fields.get("icon")!.value, "panel: icon", reader) : undefined

  if (title === undefined) return undefined
  return { title, ...(icon !== undefined ? { icon } : {}) }
}

function readBackend(node: Node | null, reader: Reader): PluginManifestBackend | undefined {
  const map = readMap(node, "backend", reader)
  if (map === undefined) return undefined
  const fields = readFields(map, "backend", ["run"], reader)

  const runNode = requireField(fields, "run", map, "backend", reader)
  const run = runNode === undefined ? undefined : readStringSeq(runNode, "backend: run", reader)
  if (run === undefined) return undefined
  if (run.length === 0) {
    reader.error(runNode, "backend: run must be a non-empty list of command arguments")
    return undefined
  }
  return { run }
}

function readCapabilities(node: Node | null, reader: Reader): readonly ActionCapability[] {
  const seq = readSeq(node, "capabilities", reader)
  if (seq === undefined) return []
  const capabilities: ActionCapability[] = []
  for (const [index, item] of seq.items.entries()) {
    const value = readEnum((item ?? null) as Node | null, `capabilities[${index}]`, ACTION_CAPABILITIES, reader)
    if (value !== undefined && !capabilities.includes(value)) capabilities.push(value)
  }
  return capabilities
}

// ---------------------------------------------------------------------------
// Manifest validation (semantic invariants — shape is the parser's job)
// ---------------------------------------------------------------------------

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Validates a manifest IR (or any runtime-loaded value): id format,
 *  version bounds, panel title, backend argv and capability vocabulary. */
export function validatePluginManifest(value: unknown): readonly string[] {
  const errors: string[] = []
  if (!isRecord(value)) {
    return ["a plugin manifest must be a mapping"]
  }

  const id = value.id
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
    errors.push(`manifest "id" must be kebab-case (e.g. "openspec") — got ${describe(value.id)}`)
  }

  const version = value.version
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    errors.push(`manifest "version" must be an integer >= 1 — got ${describe(value.version)}`)
  }

  validatePanel(value.panel, errors)
  if (value.backend !== undefined) validateBackend(value.backend, errors)
  validateCapabilities(value.capabilities, errors)

  return errors
}

function validatePanel(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('manifest "panel" must be a mapping — { title, icon? }')
    return
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    errors.push(`panel "title" must be a non-empty string — got ${describe(value.title)}`)
  }
  if (value.icon !== undefined && typeof value.icon !== "string") {
    errors.push('panel "icon" must be a string')
  }
}

function validateBackend(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('manifest "backend" must be a mapping — { run: [...] }')
    return
  }
  const run = value.run
  if (!Array.isArray(run) || run.length === 0) {
    errors.push('manifest "backend.run" must be a non-empty list of command arguments')
    return
  }
  for (const [index, arg] of run.entries()) {
    if (typeof arg !== "string" || arg.trim() === "") {
      errors.push(`manifest "backend.run[${index}]" must be a non-empty string`)
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

function describe(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
