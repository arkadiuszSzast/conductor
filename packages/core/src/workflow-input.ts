/**
 * Canonical workflow-input resolution — the pure, deterministic gate every
 * manual start (UI, CLI, API client, and any future trigger ingress) runs
 * through before a feature exists. Given a workflow's declared `InputDef`s
 * and an unknown caller-supplied payload, it either returns the fully
 * resolved typed map (declared defaults applied) or ordered diagnostics
 * naming exactly what is wrong.
 *
 * No I/O, no ambient state: this module is safe to call before any
 * durable side effect and is shared by every client so validation and
 * defaulting behaviour never depends on the initiating transport.
 */

import type { InputDef, InputType } from "./types.ts"

export interface WorkflowInputDiagnostic {
  /** The offending input name — absent only for "the payload itself is not an object" (`kind: "invalid_payload"`). */
  readonly name?: string
  readonly kind: "invalid_payload" | "unknown_input" | "missing_required" | "wrong_type"
  readonly message: string
}

export type ResolveWorkflowInputsResult =
  | { readonly ok: true; readonly inputs: Readonly<Record<string, string | number | boolean>> }
  | { readonly ok: false; readonly diagnostics: readonly WorkflowInputDiagnostic[] }

/**
 * Resolve `supplied` against `defs`. Deterministic and side-effect-free:
 * diagnostics are always produced in the input's declared name order
 * (stable regardless of key order in `supplied`), so repeated calls with
 * the same arguments produce byte-identical output.
 *
 *  - `supplied` must be a genuine plain JSON object — not an array, not
 *    null, and not a `Date`/`Map`/class instance/any object whose
 *    prototype isn't `Object.prototype` or `null` — anything else is a
 *    single `invalid_payload` diagnostic and no per-input checks run.
 *  - A key in `supplied` that is not declared in `defs` → `unknown_input`.
 *  - A declared required input missing from `supplied` → `missing_required`.
 *  - A supplied value whose JSON type does not exactly match the declared
 *    `string`/`number`/`boolean` (including a non-finite number) →
 *    `wrong_type`.
 *  - An omitted optional input is filled from its declared default.
 *
 * Inputs are name-keyed JSON maps, so a declared or supplied name can
 * legally be any JSON string — including `constructor`, `toString` or
 * `__proto__`. Every lookup below reads OWN data properties only (never
 * an inherited one, e.g. `{}.toString`) and every accumulator is built
 * through `Object.fromEntries` rather than `obj[dynamicKey] = value` —
 * the latter is unsafe for a literal `"__proto__"` key on an ordinary
 * object (it invokes `Object.prototype`'s `__proto__` SETTER instead of
 * creating an own property, silently dropping the value). This keeps the
 * function total for any `unknown` input: it never throws, regardless of
 * what shape or own-property names the caller's JSON-like value has.
 *
 * `supplied` is also hardened against a hostile or revoked `Proxy`: a
 * malicious HTTP body can never itself BE a `Proxy` (it comes from
 * `JSON.parse`), but `unknown` promises nothing about how a caller built
 * this value in-process, and a trap that throws (`getPrototypeOf`,
 * `ownKeys` — which `Object.keys` invokes internally along with a
 * per-key `getOwnPropertyDescriptor` invariant check — or a direct
 * `getOwnPropertyDescriptor` probe for one specific declared name) must
 * degrade to a diagnostic, never an uncaught exception reaching the
 * caller before any durable state exists.
 */
export function resolveWorkflowInputs(
  defs: Readonly<Record<string, InputDef>>,
  supplied: unknown,
): ResolveWorkflowInputsResult {
  const plain = safePlainObject(supplied)
  if (!plain.ok) {
    return {
      ok: false,
      diagnostics: [
        { kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" },
      ],
    }
  }

  const diagnostics: WorkflowInputDiagnostic[] = []
  const declaredNames = Object.keys(defs).sort()
  const declared = new Set(declaredNames)

  // Enumerating `supplied`'s own keys is itself a trap invocation
  // (`ownKeys`, plus a `getOwnPropertyDescriptor` per candidate key for
  // the enumerability invariant check) — a hostile implementation of
  // either can throw. Nothing salvageable follows: without a reliable
  // key list, `unknown_input` detection cannot run, so this degrades to
  // the same coarse `invalid_payload` as a non-object payload.
  const suppliedKeys = safeOwnKeys(plain.value)
  if (!suppliedKeys.ok) {
    return {
      ok: false,
      diagnostics: [
        { kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" },
      ],
    }
  }

  for (const name of suppliedKeys.value.sort()) {
    if (!declared.has(name)) {
      diagnostics.push({
        name,
        kind: "unknown_input",
        message: declaredNames.length > 0
          ? `input "${name}" is not declared by this workflow — declared inputs: ${declaredNames.join(", ")}`
          : `input "${name}" is not declared by this workflow — the workflow declares no inputs`,
      })
    }
  }

  const resolvedEntries: Array<[string, string | number | boolean]> = []
  for (const name of declaredNames) {
    const def = ownValue(defs, name) as InputDef
    // Unlike the `ownKeys` scan above, a single declared name can be
    // probed independently of what `ownKeys` returned — a hostile trap
    // may throw only for names it never advertised as enumerable. That
    // failure is local to this one input: it becomes `wrong_type`
    // (the value could not be read, so it cannot be verified as the
    // declared type) rather than invalidating the whole payload.
    const read = safeOwnValue(plain.value, name)
    if (!read.ok) {
      diagnostics.push({
        name,
        kind: "wrong_type",
        message: `input "${name}" must be a ${def.type} — its value could not be read`,
      })
      continue
    }
    const value = read.value
    if (value === undefined) {
      if (def.presence === "required") {
        diagnostics.push({ name, kind: "missing_required", message: `input "${name}" is required (type: ${def.type})` })
      } else {
        resolvedEntries.push([name, def.default])
      }
      continue
    }
    if (!matchesInputType(value, def.type)) {
      diagnostics.push({
        name,
        kind: "wrong_type",
        message: `input "${name}" must be a ${def.type} — got ${describe(value)}`,
      })
      continue
    }
    resolvedEntries.push([name, value])
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics }
  return { ok: true, inputs: Object.fromEntries(resolvedEntries) }
}

function matchesInputType(value: unknown, type: InputType): value is string | number | boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "boolean":
      return typeof value === "boolean"
  }
}

/** A genuine plain JSON-shaped object: not an array, not `null`, and not
 *  a `Date`/`Map`/`RegExp`/class instance/anything else whose prototype
 *  chain carries behaviour a JSON payload never has. Both a
 *  `JSON.parse` result (`Object.prototype`) and a null-prototype object
 *  qualify. `Array.isArray` and `Object.getPrototypeOf` both invoke a
 *  `Proxy`'s traps (a revoked proxy throws on every trap; a hostile one
 *  may throw only from `getPrototypeOf`) — either failure means "cannot
 *  establish this is a plain object", the same outcome as any other
 *  shape this function already rejects. */
function safePlainObject(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (typeof value !== "object" || value === null) return { ok: false }
  try {
    if (Array.isArray(value)) return { ok: false }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return { ok: false }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

/** Reads an OWN data property by name — never an inherited one (so an
 *  omitted `toString`/`constructor`/etc. reads as `undefined`, exactly
 *  like any other omitted name) and never invokes an accessor (a getter
 *  is not a JSON value, so it is treated as absent rather than
 *  evaluated — keeping this function pure and safe against a
 *  maliciously-crafted `unknown` argument). Trusted callers only — see
 *  `safeOwnValue` for the untrusted-`supplied` counterpart. */
function ownValue(obj: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/** `ownValue`, hardened for an untrusted `supplied` object whose
 *  `getOwnPropertyDescriptor` trap may throw for one specific key even
 *  when `ownKeys` (via `safeOwnKeys`) never threw at all — a per-key
 *  hostile trap, not a blanket one. */
function safeOwnValue(obj: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: ownValue(obj, key) }
  } catch {
    return { ok: false }
  }
}

/** `Object.keys`, hardened: enumerating an untrusted object's own keys
 *  invokes the `ownKeys` trap plus a `getOwnPropertyDescriptor` per
 *  candidate (the enumerability invariant check) — a hostile or revoked
 *  `Proxy` can throw from either. */
function safeOwnKeys(obj: object): { ok: true; value: string[] } | { ok: false } {
  try {
    return { ok: true, value: Object.keys(obj) }
  } catch {
    return { ok: false }
  }
}

/** Formats a value for a diagnostic message. Never throws: `JSON.stringify`
 *  itself throws for a `bigint` or a cyclic object, and does nothing
 *  useful for a `function`/`symbol` — every one of those is a value a
 *  hand-built (non-JSON) caller could pass through `unknown`. */
function describe(value: unknown): string {
  if (value === undefined) return "nothing"
  if (typeof value === "bigint") return `${value.toString()}n`
  if (typeof value === "function") return "a function"
  if (typeof value === "symbol") return value.toString()
  try {
    return JSON.stringify(value)
  } catch {
    return typeof value === "object" ? "[unserializable value]" : String(value)
  }
}
