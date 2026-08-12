/**
 * conductor.yaml → WorkflowDef.
 *
 * The parser owns shape and syntax: it turns the authoring surface of
 * `docs/workflow-reference.md` into the normalised IR (empty collections
 * filled, discriminated unions built, "required xor default" enforced by
 * construction). Graph and reference semantics stay in `validate.ts` —
 * feed the returned workflow to `validateWorkflow`.
 *
 * Strictness is deliberate: duplicate keys, anchors, aliases, tags and
 * multiple documents are rejected outright (aliases banned means no
 * expansion bombs), depth and size are bounded, and unknown fields fail
 * with their source location and the closest valid field.
 */

import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, stringify as stringifyYaml, visit } from "yaml"
import type { Node, YAMLMap, YAMLSeq } from "yaml"
import type {
  BackoffDef,
  InputDef,
  InputType,
  JobDef,
  Outcomes,
  RetryPolicy,
  RoleDef,
  Route,
  StepDef,
  TriggerDef,
  WorkflowDef,
} from "./types.ts"

export interface ParseError {
  readonly message: string
  /** 1-based source position of the offending node. */
  readonly line: number
  readonly col: number
}

export type ParseWorkflowResult =
  | { readonly ok: true; readonly workflow: WorkflowDef }
  | { readonly ok: false; readonly errors: readonly ParseError[] }

const MAX_SOURCE_LENGTH = 1_048_576
const MAX_DEPTH = 64

const INPUT_TYPES: readonly InputType[] = ["string", "number", "boolean"]
const STEP_KINDS = ["agent", "command", "action", "human"] as const

export interface YamlObjectParseError {
  readonly message: string
  readonly line: number
  readonly col: number
}

export type ParseYamlObjectResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly YamlObjectParseError[] }

/**
 * Generic YAML → plain data, with the same safety posture as
 * `parseWorkflow`: duplicate keys, multiple documents, anchors, aliases
 * and custom tags are rejected, depth and size are bounded. The result
 * is whatever the document contains (`null`, a scalar, an array or a
 * plain object) — shape validation is the caller's job. Used by the CLI
 * to load the daemon configuration file; `yaml` stays a core-owned
 * dependency so no consumer needs it directly.
 */
export function parseYamlObject(source: string): ParseYamlObjectResult {
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

  if (doc.contents === null) return { ok: true, value: null }

  rejectUnsafeNodes(doc.contents, reader)
  if (reader.errors.length > 0) return { ok: false, errors: reader.errors }

  try {
    const value = doc.toJS({ maxAliasCount: 0 })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, errors: [{ message: error instanceof Error ? error.message : String(error), line: 1, col: 1 }] }
  }
}

export function parseWorkflow(source: string): ParseWorkflowResult {
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
    reader.error(root, "the workflow document must be a mapping with name, on, inputs, roles, jobs")
    return { ok: false, errors: reader.errors }
  }

  const workflow = readWorkflow(root, reader)
  return reader.errors.length > 0 ? { ok: false, errors: reader.errors } : { ok: true, workflow }
}

function describeYamlIssue(code: string, message: string): string {
  switch (code) {
    case "DUPLICATE_KEY":
      return "duplicate mapping key — every key must be unique"
    case "MULTIPLE_DOCS":
      return "multiple YAML documents in one file — a workflow is a single document"
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

// ---------------------------------------------------------------------------
// Error collection with source positions
// ---------------------------------------------------------------------------

class Reader {
  readonly errors: ParseError[] = []

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

// ---------------------------------------------------------------------------
// Map field access: unknown-field rejection with closest-match suggestion
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Typed scalar readers — undefined means "already reported"
// ---------------------------------------------------------------------------

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

function readEnum<T extends string>(
  node: Node | null,
  where: string,
  values: readonly T[],
  reader: Reader,
): T | undefined {
  if (node !== null && isScalar(node) && typeof node.value === "string" && (values as readonly string[]).includes(node.value)) {
    return node.value as T
  }
  reader.error(node, `${where} must be one of: ${values.join(", ")}`)
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

function requireField(
  fields: Fields,
  name: string,
  owner: YAMLMap,
  where: string,
  reader: Reader,
): Node | null | undefined {
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

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

function readWorkflow(root: YAMLMap, reader: Reader): WorkflowDef {
  const fields = readFields(root, "workflow", ["name", "on", "inputs", "roles", "jobs"], reader)

  const nameNode = requireField(fields, "name", root, "workflow", reader)
  const name = nameNode === undefined ? "" : readString(nameNode, "workflow: name", reader) ?? ""

  const on = fields.has("on") ? readTriggers(fields.get("on")!.value, reader) : []
  const inputs = fields.has("inputs") ? readInputs(fields.get("inputs")!.value, reader) : {}
  const roles = fields.has("roles") ? readRoles(fields.get("roles")!.value, reader) : {}

  const jobsNode = requireField(fields, "jobs", root, "workflow", reader)
  const jobs = jobsNode === undefined ? {} : readJobs(jobsNode, reader)

  return { name, on, inputs, jobs, roles }
}

function readTriggers(node: Node | null, reader: Reader): readonly TriggerDef[] {
  const seq = readSeq(node, "on", reader)
  if (seq === undefined) return []
  const triggers: TriggerDef[] = []
  for (const [index, rawItem] of seq.items.entries()) {
    const item = (rawItem ?? null) as Node | null
    const where = `on[${index}]`
    if (isScalar(item)) {
      if (item.value === "manual") {
        triggers.push({ kind: "manual" })
      } else {
        reader.error(item, `${where}: unknown trigger "${String(item.value)}" — expected manual, { schedule: ... } or { event: ... }`)
      }
      continue
    }
    if (!isMap(item)) {
      reader.error(item, `${where}: a trigger is "manual", { schedule: ... } or { event: ... }`)
      continue
    }
    const fields = readFields(item, where, ["schedule", "event"], reader)
    if (fields.size !== 1) {
      reader.error(item, `${where}: a trigger mapping has exactly one key — schedule or event`)
      continue
    }
    const schedule = fields.get("schedule")
    if (schedule !== undefined) {
      const trigger = readSchedule(schedule.value, `${where}: schedule`, reader)
      if (trigger !== undefined) triggers.push(trigger)
      continue
    }
    const event = readString(fields.get("event")!.value, `${where}: event`, reader)
    if (event !== undefined) triggers.push({ kind: "event", event })
  }
  return triggers
}

function readSchedule(node: Node | null, where: string, reader: Reader): TriggerDef | undefined {
  const map = readMap(node, where, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, where, ["cron", "missedFire"], reader)
  const cronNode = requireField(fields, "cron", map, where, reader)
  const missedFireNode = requireField(fields, "missedFire", map, where, reader)
  const cron = cronNode === undefined ? undefined : readString(cronNode, `${where}: cron`, reader)
  const missedFire = missedFireNode === undefined
    ? undefined
    : readEnum(missedFireNode, `${where}: missedFire`, ["skip", "catch-up"] as const, reader)
  if (cron === undefined || missedFire === undefined) return undefined
  return { kind: "schedule", cron, missedFire }
}

function readInputs(node: Node | null, reader: Reader): Readonly<Record<string, InputDef>> {
  const map = readMap(node, "inputs", reader)
  if (map === undefined) return {}
  const inputs: Record<string, InputDef> = {}
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

function readInput(name: string, node: Node | null, reader: Reader): InputDef | undefined {
  const where = `input "${name}"`
  const map = readMap(node, where, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, where, ["type", "required", "default"], reader)

  const typeNode = requireField(fields, "type", map, where, reader)
  const type = typeNode === undefined ? undefined : readEnum(typeNode, `${where}: type`, INPUT_TYPES, reader)

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

function readDefault(
  node: Node | null,
  type: InputType,
  where: string,
  reader: Reader,
): string | number | boolean | undefined {
  if (node !== null && isScalar(node) && typeof node.value === type) {
    return node.value as string | number | boolean
  }
  reader.error(node, `${where}: default must be a ${type} to match the declared type`)
  return undefined
}

function readRoles(node: Node | null, reader: Reader): Readonly<Record<string, RoleDef>> {
  const map = readMap(node, "roles", reader)
  if (map === undefined) return {}
  const roles: Record<string, RoleDef> = {}
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, "roles: mapping keys must be strings")
      continue
    }
    const where = `role "${key.value}"`
    const roleMap = readMap((pair.value ?? null) as Node | null, where, reader)
    if (roleMap === undefined) continue
    const fields = readFields(roleMap, where, ["agent", "model", "variant"], reader)
    const agentNode = requireField(fields, "agent", roleMap, where, reader)
    const agent = agentNode === undefined ? undefined : readString(agentNode, `${where}: agent`, reader)
    if (agent === undefined) continue
    const model = fields.has("model") ? readString(fields.get("model")!.value, `${where}: model`, reader) : undefined
    const variant = fields.has("variant") ? readString(fields.get("variant")!.value, `${where}: variant`, reader) : undefined
    roles[key.value] = {
      agent,
      ...(model !== undefined ? { model } : {}),
      ...(variant !== undefined ? { variant } : {}),
    }
  }
  return roles
}

// ---------------------------------------------------------------------------
// Jobs and steps
// ---------------------------------------------------------------------------

function readJobs(node: Node | null, reader: Reader): Readonly<Record<string, JobDef>> {
  const map = readMap(node, "jobs", reader)
  if (map === undefined) return {}
  const jobs: Record<string, JobDef> = {}
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, "jobs: mapping keys must be strings")
      continue
    }
    const job = readJob(key.value, (pair.value ?? null) as Node | null, reader)
    if (job !== undefined) jobs[key.value] = job
  }
  return jobs
}

function readJob(jobId: string, node: Node | null, reader: Reader): JobDef | undefined {
  const where = `job "${jobId}"`
  const map = readMap(node, where, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, where, ["needs", "if", "outputs", "steps"], reader)

  const needs = fields.has("needs") ? readStringSeq(fields.get("needs")!.value, `${where}: needs`, reader) ?? [] : []
  const jobIf = fields.has("if") ? readString(fields.get("if")!.value, `${where}: if`, reader) : undefined
  const outputs = fields.has("outputs") ? readOutputs(fields.get("outputs")!.value, where, reader) : {}

  const stepsNode = requireField(fields, "steps", map, where, reader)
  const steps = stepsNode === undefined ? [] : readSteps(stepsNode, where, reader)

  return { needs, steps, outputs, ...(jobIf !== undefined ? { if: jobIf } : {}) }
}

function readOutputs(node: Node | null, where: string, reader: Reader): Readonly<Record<string, string>> {
  const map = readMap(node, `${where}: outputs`, reader)
  if (map === undefined) return {}
  const outputs: Record<string, string> = {}
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, `${where}: outputs keys must be strings`)
      continue
    }
    const value = readString((pair.value ?? null) as Node | null, `${where}: outputs["${key.value}"]`, reader)
    if (value !== undefined) outputs[key.value] = value
  }
  return outputs
}

function readSteps(node: Node | null, jobWhere: string, reader: Reader): readonly StepDef[] {
  const seq = readSeq(node, `${jobWhere}: steps`, reader)
  if (seq === undefined) return []
  const steps: StepDef[] = []
  for (const [index, item] of seq.items.entries()) {
    const step = readStep((item ?? null) as Node | null, index, jobWhere, reader)
    if (step !== undefined) steps.push(step)
  }
  return steps
}

function readStep(node: Node | null, index: number, jobWhere: string, reader: Reader): StepDef | undefined {
  const map = readMap(node, `${jobWhere} steps[${index}]`, reader)
  if (map === undefined) return undefined
  const allowed = ["id", "if", "outcomes", "onFail", "retry", ...STEP_KINDS]
  const provisional = `${jobWhere} steps[${index}]`
  const fields = readFields(map, provisional, allowed, reader)

  const idNode = requireField(fields, "id", map, provisional, reader)
  const id = idNode === undefined ? undefined : readString(idNode, `${provisional}: id`, reader)
  const where = id === undefined ? provisional : `${jobWhere} step "${id}"`

  const kinds = STEP_KINDS.filter(kind => fields.has(kind))
  if (kinds.length !== 1) {
    reader.error(
      map,
      kinds.length === 0
        ? `${where}: a step is exactly one kind — add one of: ${STEP_KINDS.join(", ")}`
        : `${where}: a step is exactly one kind — found conflicting keys: ${kinds.join(", ")}`,
    )
    return undefined
  }

  const stepIf = fields.has("if") ? readString(fields.get("if")!.value, `${where}: if`, reader) : undefined
  const outcomes = fields.has("outcomes") ? readOutcomes(fields.get("outcomes")!.value, where, reader) : {}
  const onFail = fields.has("onFail") ? readRoute(fields.get("onFail")!.value, `${where}: onFail`, reader) : undefined
  const retry = fields.has("retry")
    ? readRetry(fields.get("retry")!.value, `${where}: retry`, reader)
    : ({ strategy: "none" } as const)

  if (id === undefined || retry === undefined) return undefined

  const base = {
    id,
    outcomes,
    retry,
    ...(stepIf !== undefined ? { if: stepIf } : {}),
    ...(onFail !== undefined ? { onFail } : {}),
  }

  const kind = kinds[0]!
  const body = fields.get(kind)!.value
  switch (kind) {
    case "agent":
      return readAgentBody(body, base, where, reader)
    case "command":
      return readCommandBody(body, base, where, reader)
    case "action":
      return readActionBody(body, base, where, reader)
    case "human":
      return readHumanBody(body, base, where, reader)
  }
}

type StepBase = Pick<StepDef, "id" | "if" | "outcomes" | "onFail" | "retry">

function readAgentBody(node: Node | null, base: StepBase, where: string, reader: Reader): StepDef | undefined {
  const map = readMap(node, `${where}: agent`, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, `${where}: agent`, ["role", "prompt", "interactive"], reader)
  const roleNode = requireField(fields, "role", map, `${where}: agent`, reader)
  const promptNode = requireField(fields, "prompt", map, `${where}: agent`, reader)
  const role = roleNode === undefined ? undefined : readString(roleNode, `${where}: agent: role`, reader)
  const prompt = promptNode === undefined ? undefined : readString(promptNode, `${where}: agent: prompt`, reader)
  let interactive: boolean | undefined
  if (fields.has("interactive")) {
    interactive = readBoolean(fields.get("interactive")!.value, `${where}: agent: interactive`, reader)
    if (interactive === undefined) return undefined
  }
  if (role === undefined || prompt === undefined) return undefined
  return { ...base, type: "agent", role, prompt, ...(interactive !== undefined ? { interactive } : {}) }
}

function readCommandBody(node: Node | null, base: StepBase, where: string, reader: Reader): StepDef | undefined {
  const map = readMap(node, `${where}: command`, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, `${where}: command`, ["run", "cwd", "timeoutMs"], reader)
  const runNode = requireField(fields, "run", map, `${where}: command`, reader)
  const run = runNode === undefined ? undefined : readStringSeq(runNode, `${where}: command: run`, reader)
  const cwd = fields.has("cwd") ? readString(fields.get("cwd")!.value, `${where}: command: cwd`, reader) : undefined
  let timeoutMs: number | undefined
  if (fields.has("timeoutMs")) {
    timeoutMs = readInteger(fields.get("timeoutMs")!.value, `${where}: command: timeoutMs`, reader)
    if (timeoutMs !== undefined && timeoutMs < 1) {
      reader.error(fields.get("timeoutMs")!.value, `${where}: command: timeoutMs must be ≥ 1 — omit it for no timeout`)
      return undefined
    }
  }
  if (run === undefined) return undefined
  return {
    ...base,
    type: "command",
    run,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

function readActionBody(node: Node | null, base: StepBase, where: string, reader: Reader): StepDef | undefined {
  const map = readMap(node, `${where}: action`, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, `${where}: action`, ["uses", "with"], reader)
  const usesNode = requireField(fields, "uses", map, `${where}: action`, reader)
  const uses = usesNode === undefined ? undefined : readString(usesNode, `${where}: action: uses`, reader)
  const withValue = fields.has("with")
    ? readWith(fields.get("with")!.value, `${where}: action: with`, reader)
    : {}
  if (uses === undefined) return undefined
  return { ...base, type: "action", uses, with: withValue }
}

function readWith(node: Node | null, where: string, reader: Reader): Readonly<Record<string, unknown>> {
  const map = readMap(node, where, reader)
  if (map === undefined) return {}
  const values: Record<string, unknown> = {}
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, `${where}: mapping keys must be strings`)
      continue
    }
    values[key.value] = plainValue((pair.value ?? null) as Node | null, `${where}.${key.value}`, reader)
  }
  return values
}

function plainValue(node: Node | null, where: string, reader: Reader): unknown {
  if (isEmptyValue(node)) return null
  if (isScalar(node)) return node.value
  if (isSeq(node)) {
    return node.items.map((item, index) => plainValue((item ?? null) as Node | null, `${where}[${index}]`, reader))
  }
  if (isMap(node)) {
    const values: Record<string, unknown> = {}
    for (const pair of node.items) {
      const key = pair.key as Node
      if (!isScalar(key) || typeof key.value !== "string") {
        reader.error(key ?? node, `${where}: mapping keys must be strings`)
        continue
      }
      values[key.value] = plainValue((pair.value ?? null) as Node | null, `${where}.${key.value}`, reader)
    }
    return values
  }
  reader.error(node, `${where}: unsupported value`)
  return null
}

function readHumanBody(node: Node | null, base: StepBase, where: string, reader: Reader): StepDef | undefined {
  if (isEmptyValue(node)) return { ...base, type: "human" }
  if (isMap(node)) {
    const fields = readFields(node, `${where}: human`, ["prompt"], reader)
    if (node.items.length > fields.size) return undefined
    if (!fields.has("prompt")) return { ...base, type: "human" }
    const prompt = readString(fields.get("prompt")!.value, `${where}: human: prompt`, reader)
    if (prompt === undefined) return undefined
    return { ...base, type: "human", prompt }
  }
  reader.error(node, `${where}: human is a gate — write human: {} or human: { prompt: ... }`)
  return undefined
}

// ---------------------------------------------------------------------------
// Routes and retry
// ---------------------------------------------------------------------------

function readOutcomes(node: Node | null, where: string, reader: Reader): Outcomes {
  const map = readMap(node, `${where}: outcomes`, reader)
  if (map === undefined) return {}
  const outcomes: Record<string, Route> = {}
  for (const pair of map.items) {
    const key = pair.key as Node
    if (!isScalar(key) || typeof key.value !== "string") {
      reader.error(key ?? map, `${where}: outcome names must be strings`)
      continue
    }
    const route = readRoute((pair.value ?? null) as Node | null, `${where}: outcomes["${key.value}"]`, reader)
    if (route !== undefined) outcomes[key.value] = route
  }
  return outcomes
}

function readRoute(node: Node | null, where: string, reader: Reader): Route | undefined {
  if (isScalar(node)) {
    if (node.value === "next") return { kind: "next" }
    reader.error(node, `${where}: a route is next, { goto: <step> } or { rerun: { ... } }`)
    return undefined
  }
  if (!isMap(node)) {
    reader.error(node, `${where}: a route is next, { goto: <step> } or { rerun: { ... } }`)
    return undefined
  }
  const fields = readFields(node, where, ["goto", "rerun"], reader)
  if (fields.size !== 1) {
    reader.error(node, `${where}: a route has exactly one key — goto or rerun`)
    return undefined
  }
  const goto = fields.get("goto")
  if (goto !== undefined) {
    const stepId = readString(goto.value, `${where}: goto`, reader)
    return stepId === undefined ? undefined : { kind: "goto", stepId }
  }
  return readRerun(fields.get("rerun")!.value, `${where}: rerun`, reader)
}

function readRerun(node: Node | null, where: string, reader: Reader): Route | undefined {
  const map = readMap(node, where, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, where, ["scope", "stepIds", "jobIds", "maxRounds"], reader)

  const scopeNode = requireField(fields, "scope", map, where, reader)
  const scope = scopeNode === undefined ? undefined : readEnum(scopeNode, `${where}: scope`, ["steps", "jobs"] as const, reader)
  const maxRoundsNode = requireField(fields, "maxRounds", map, where, reader)
  const maxRounds = maxRoundsNode === undefined ? undefined : readInteger(maxRoundsNode, `${where}: maxRounds`, reader)
  if (scope === undefined || maxRounds === undefined) return undefined

  if (scope === "steps") {
    if (fields.has("jobIds")) {
      reader.error(fields.get("jobIds")!.key, `${where}: jobIds is for scope: jobs — scope: steps takes stepIds`)
      return undefined
    }
    const stepIdsNode = requireField(fields, "stepIds", map, where, reader)
    const stepIds = stepIdsNode === undefined ? undefined : readStringSeq(stepIdsNode, `${where}: stepIds`, reader)
    if (stepIds === undefined) return undefined
    return { kind: "rerun", target: { scope: "steps", stepIds, maxRounds } }
  }

  if (fields.has("stepIds")) {
    reader.error(fields.get("stepIds")!.key, `${where}: stepIds is for scope: steps — scope: jobs takes jobIds`)
    return undefined
  }
  const jobIdsNode = requireField(fields, "jobIds", map, where, reader)
  const jobIds = jobIdsNode === undefined ? undefined : readStringSeq(jobIdsNode, `${where}: jobIds`, reader)
  if (jobIds === undefined) return undefined
  return { kind: "rerun", target: { scope: "jobs", jobIds, maxRounds } }
}

function readRetry(node: Node | null, where: string, reader: Reader): RetryPolicy | undefined {
  const map = readMap(node, where, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, where, ["maxAttempts", "maxElapsed", "backoff"], reader)

  const maxAttemptsNode = requireField(fields, "maxAttempts", map, where, reader)
  const maxAttempts = maxAttemptsNode === undefined ? undefined : readInteger(maxAttemptsNode, `${where}: maxAttempts`, reader)
  const maxElapsed = fields.has("maxElapsed")
    ? readString(fields.get("maxElapsed")!.value, `${where}: maxElapsed`, reader)
    : undefined
  const backoffNode = requireField(fields, "backoff", map, where, reader)
  const backoff = backoffNode === undefined ? undefined : readBackoff(backoffNode, `${where}: backoff`, reader)

  if (maxAttempts === undefined || backoff === undefined) return undefined
  return {
    strategy: "backoff",
    maxAttempts,
    backoff,
    ...(maxElapsed !== undefined ? { maxElapsed } : {}),
  }
}

function readBackoff(node: Node | null, where: string, reader: Reader): BackoffDef | undefined {
  const map = readMap(node, where, reader)
  if (map === undefined) return undefined
  const fields = readFields(map, where, ["strategy", "delay", "initial", "multiplier", "max", "jitter"], reader)

  const strategyNode = requireField(fields, "strategy", map, where, reader)
  const strategy = strategyNode === undefined
    ? undefined
    : readEnum(strategyNode, `${where}: strategy`, ["constant", "exponential"] as const, reader)
  if (strategy === undefined) return undefined

  if (strategy === "constant") {
    for (const name of ["initial", "multiplier", "max", "jitter"]) {
      if (fields.has(name)) {
        reader.error(fields.get(name)!.key, `${where}: ${name} is for strategy: exponential — strategy: constant takes delay`)
        return undefined
      }
    }
    const delayNode = requireField(fields, "delay", map, where, reader)
    const delay = delayNode === undefined ? undefined : readInteger(delayNode, `${where}: delay`, reader)
    return delay === undefined ? undefined : { strategy: "constant", delay }
  }

  if (fields.has("delay")) {
    reader.error(fields.get("delay")!.key, `${where}: delay is for strategy: constant — strategy: exponential takes initial, multiplier, max`)
    return undefined
  }
  const initialNode = requireField(fields, "initial", map, where, reader)
  const multiplierNode = requireField(fields, "multiplier", map, where, reader)
  const maxNode = requireField(fields, "max", map, where, reader)
  const initial = initialNode === undefined ? undefined : readInteger(initialNode, `${where}: initial`, reader)
  const multiplier = multiplierNode === undefined ? undefined : readNumber(multiplierNode, `${where}: multiplier`, reader)
  const max = maxNode === undefined ? undefined : readInteger(maxNode, `${where}: max`, reader)
  const jitter = fields.has("jitter")
    ? readEnum(fields.get("jitter")!.value, `${where}: jitter`, ["none", "full", "equal"] as const, reader)
    : undefined
  if (initial === undefined || multiplier === undefined || max === undefined) return undefined
  return {
    strategy: "exponential",
    initial,
    multiplier,
    max,
    ...(jitter !== undefined ? { jitter } : {}),
  }
}

/**
 * Plain data → YAML text. The write-side counterpart of
 * `parseYamlObject`, for tooling that round-trips configuration files
 * (the CLI's daemon config updates). Comments are not preserved —
 * callers own that trade-off.
 */
export function stringifyYamlObject(value: unknown): string {
  return stringifyYaml(value)
}
