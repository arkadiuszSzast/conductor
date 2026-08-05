/**
 * Action manifest YAML → ActionManifest.
 *
 * Mirrors `parse.ts` for the action authoring surface: the parser owns
 * shape and syntax (required fields, typed IO with "required xor default",
 * capability list, execution entry) with source-mapped, closest-field
 * errors and the same strictness (no aliases/anchors/tags, unique keys,
 * bounded size and depth). Semantic invariants (name/version format,
 * capability vocabulary) stay in `validateActionManifest` — the daemon
 * validates after loading, exactly like `validateWorkflow` for workflows.
 */

import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml"
import type { Node, YAMLMap, YAMLSeq } from "yaml"
import type {
  ActionCapability,
  ActionExecution,
  ActionInputDef,
  ActionInputType,
  ActionInputValue,
  ActionManifest,
} from "./action.ts"
import { ACTION_CAPABILITIES, ACTION_INPUT_TYPES } from "./action.ts"

export interface ParseActionManifestError {
  readonly message: string
  /** 1-based source position of the offending node. */
  readonly line: number
  readonly col: number
}

export type ParseActionManifestResult =
  | { readonly ok: true; readonly manifest: ActionManifest }
  | { readonly ok: false; readonly errors: readonly ParseActionManifestError[] }

const MAX_SOURCE_LENGTH = 1_048_576
const MAX_DEPTH = 64

export function parseActionManifest(source: string): ParseActionManifestResult {
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
    reader.error(root, "an action manifest must be a mapping with name, version, inputs, outputs, capabilities, run")
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
  readonly errors: ParseActionManifestError[] = []

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

function readBoolean(node: Node | null, where: string, reader: Reader): boolean | undefined {
  if (node !== null && isScalar(node) && typeof node.value === "boolean") return node.value
  reader.error(node, `${where} must be a boolean`)
  return undefined
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

function requireField(fields: Fields, name: string, owner: YAMLMap, where: string, reader: Reader): Node | null | undefined {
  const field = fields.get(name)
  if (field === undefined) {
    reader.error(owner, `${where}: missing required field "${name}"`)
    return undefined
  }
  return field.value
}

function isEmptyValue(node: Node | null): boolean {
  return node === null || (isScalar(node) && node.value === null)
}

function readManifest(root: YAMLMap, reader: Reader): ActionManifest {
  const fields = readFields(root, "manifest", ["name", "version", "description", "inputs", "outputs", "capabilities", "run"], reader)

  const nameNode = requireField(fields, "name", root, "manifest", reader)
  const name = nameNode === undefined ? "" : readString(nameNode, "manifest: name", reader) ?? ""

  const versionNode = requireField(fields, "version", root, "manifest", reader)
  const version = versionNode === undefined ? "" : readString(versionNode, "manifest: version", reader) ?? ""

  const description = fields.has("description")
    ? readString(fields.get("description")!.value, "manifest: description", reader)
    : undefined

  const inputs = fields.has("inputs") ? readInputs(fields.get("inputs")!.value, reader) : {}
  const outputs = fields.has("outputs") ? readOutputs(fields.get("outputs")!.value, reader) : {}
  const capabilities = fields.has("capabilities")
    ? readCapabilities(fields.get("capabilities")!.value, reader)
    : []

  const runNode = requireField(fields, "run", root, "manifest", reader)
  const run = runNode === undefined ? undefined : readExecution(runNode, reader)

  return {
    name,
    version,
    inputs,
    outputs,
    capabilities,
    run: run ?? { kind: "process", command: [] },
    ...(description !== undefined ? { description } : {}),
  }
}

function readInputs(node: Node | null, reader: Reader): Readonly<Record<string, ActionInputDef>> {
  const map = readMap(node, "inputs", reader)
  if (map === undefined) return {}
  const inputs: Record<string, ActionInputDef> = {}
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, "inputs: mapping keys must be strings")
      continue
    }
    const input = readInput(key.value, (pair.value ?? null) as Node | null, reader)
    if (input !== undefined) inputs[key.value] = input
  }
  return inputs
}

function readInput(name: string, node: Node | null, reader: Reader): ActionInputDef | undefined {
  const where = `input "${name}"`
  const map = readMap(node, where, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, where, ["type", "required", "default"], reader)

  const typeNode = requireField(fields, "type", map, where, reader)
  const type = typeNode === undefined
    ? undefined
    : readEnum(typeNode, `${where}: type`, ACTION_INPUT_TYPES, reader)

  const required = fields.get("required")
  const fallback = fields.get("default")
  if (required !== undefined && fallback !== undefined) {
    reader.error(required.key, `${where}: required and default are mutually exclusive — an input is either required or has a default`)
    return undefined
  }
  if (required === undefined && fallback === undefined) {
    reader.error(map, `${where}: declare either required: true or a default — an input is never both, never neither`)
    return undefined
  }
  if (type === undefined) return undefined

  if (required !== undefined) {
    const value = readBoolean(required.value, `${where}: required`, reader)
    if (value === undefined) return undefined
    if (!value) {
      reader.error(required.value, `${where}: required must be true — an optional input declares a default instead`)
      return undefined
    }
    return { type, presence: "required" }
  }

  const defaultValue = readDefault(fallback!.value, type, where, reader)
  if (defaultValue === undefined) return undefined
  return { type, presence: "optional", default: defaultValue }
}

function readEnum<T extends string>(node: Node | null, where: string, values: readonly T[], reader: Reader): T | undefined {
  if (node !== null && isScalar(node) && typeof node.value === "string" && (values as readonly string[]).includes(node.value)) {
    return node.value as T
  }
  reader.error(node, `${where} must be one of: ${values.join(", ")}`)
  return undefined
}

function readDefault(node: Node | null, type: ActionInputType, where: string, reader: Reader): ActionInputValue | undefined {
  const element = type.endsWith("[]") ? type.slice(0, -2) : undefined
  if (element !== undefined) {
    const seq = readSeq(node, `${where}: default`, reader)
    if (seq === undefined) return undefined
    const items: (string | number | boolean)[] = []
    for (const item of seq.items) {
      if (item !== null && isScalar(item) && typeof item.value === element) {
        items.push(item.value as string | number | boolean)
      } else {
        reader.error((item ?? null) as Node | null, `${where}: default items must be ${element}`)
      }
    }
    return items
  }
  if (node !== null && isScalar(node) && typeof node.value === type) {
    return node.value as string | number | boolean
  }
  reader.error(node, `${where}: default must be a ${type} to match the declared type`)
  return undefined
}

function readOutputs(node: Node | null, reader: Reader): Readonly<Record<string, ActionInputType>> {
  const map = readMap(node, "outputs", reader)
  if (map === undefined) return {}
  const outputs: Record<string, ActionInputType> = {}
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, "outputs: mapping keys must be strings")
      continue
    }
    const where = `output "${key.value}"`
    const outputMap = readMap((pair.value ?? null) as Node | null, where, reader)
    if (outputMap === undefined) continue
    const fields = readFields(outputMap, where, ["type"], reader)
    const typeNode = requireField(fields, "type", outputMap, where, reader)
    const type = typeNode === undefined
      ? undefined
      : readEnum(typeNode, `${where}: type`, ACTION_INPUT_TYPES, reader)
    if (type !== undefined) outputs[key.value] = type
  }
  return outputs
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

function readExecution(node: Node | null, reader: Reader): ActionExecution | undefined {
  if (isEmptyValue(node)) {
    reader.error(node, "run: missing required field — a list for a subprocess or { handler: <name> } for an in-process action")
    return undefined
  }
  if (isSeq(node)) {
    const command = readStringSeq(node, "run", reader)
    if (command === undefined) return undefined
    if (command.length === 0) {
      reader.error(node, "run: a subprocess needs a non-empty command")
      return undefined
    }
    return { kind: "process", command }
  }
  if (!isMap(node)) {
    reader.error(node, "run: a list for a subprocess or { handler: <name> } for an in-process action")
    return undefined
  }
  const fields = readFields(node, "run", ["handler"], reader)
  if (fields.size !== 1) {
    reader.error(node, "run: { handler: <name> } is the in-process form — the subprocess form is a list")
    return undefined
  }
  const handler = readString(fields.get("handler")!.value, "run: handler", reader)
  return handler === undefined ? undefined : { kind: "inprocess", handler }
}
