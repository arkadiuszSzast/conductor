import { describe, expect, it } from "bun:test"
import { resolveWorkflowInputs } from "./src/workflow-input.ts"
import type { InputDef } from "./src/types.ts"

const defs: Readonly<Record<string, InputDef>> = {
  feature: { type: "string", presence: "required" },
  count: { type: "number", presence: "optional", default: 3 },
  dryRun: { type: "boolean", presence: "optional", default: false },
}

describe("resolveWorkflowInputs", () => {
  it("resolves required values and applies defaults for omitted optional inputs", () => {
    const result = resolveWorkflowInputs(defs, { feature: "auth" })
    expect(result).toEqual({ ok: true, inputs: { feature: "auth", count: 3, dryRun: false } })
  })

  it("accepts explicit values that override defaults", () => {
    const result = resolveWorkflowInputs(defs, { feature: "auth", count: 7, dryRun: true })
    expect(result).toEqual({ ok: true, inputs: { feature: "auth", count: 7, dryRun: true } })
  })

  it("treats an empty declared-inputs workflow with an empty payload as valid", () => {
    const result = resolveWorkflowInputs({}, {})
    expect(result).toEqual({ ok: true, inputs: {} })
  })

  it("rejects a non-object payload without inspecting per-input rules", () => {
    for (const bad of [null, "x", 1, true, [1, 2]]) {
      const result = resolveWorkflowInputs(defs, bad)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.diagnostics).toEqual([
        { kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" },
      ])
    }
  })

  it("rejects an unknown input name naming the declared inputs", () => {
    const result = resolveWorkflowInputs(defs, { feature: "auth", bogus: "x" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([
      { name: "bogus", kind: "unknown_input", message: 'input "bogus" is not declared by this workflow — declared inputs: count, dryRun, feature' },
    ])
  })

  it("reports unknown input against a no-input workflow without listing declared names", () => {
    const result = resolveWorkflowInputs({}, { bogus: "x" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([
      { name: "bogus", kind: "unknown_input", message: 'input "bogus" is not declared by this workflow — the workflow declares no inputs' },
    ])
  })

  it("rejects a missing required input naming it and its type", () => {
    const result = resolveWorkflowInputs(defs, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([
      { name: "feature", kind: "missing_required", message: 'input "feature" is required (type: string)' },
    ])
  })

  it("rejects a wrong-typed value naming the input, expected type and given value", () => {
    const result = resolveWorkflowInputs(defs, { feature: 42 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([
      { name: "feature", kind: "wrong_type", message: 'input "feature" must be a string — got 42' },
    ])
  })

  it("rejects non-finite numbers even though typeof is number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = resolveWorkflowInputs(defs, { feature: "auth", count: bad })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.diagnostics[0]!.kind).toBe("wrong_type")
      expect(result.diagnostics[0]!.name).toBe("count")
    }
  })

  it("collects every diagnostic in stable input-name order rather than stopping at the first", () => {
    const result = resolveWorkflowInputs(defs, { count: "not-a-number", zzz: "unknown" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map(d => d.name)).toEqual(["zzz", "count", "feature"])
    expect(result.diagnostics.map(d => d.kind)).toEqual(["unknown_input", "wrong_type", "missing_required"])
  })

  it("is deterministic across repeated calls with the same arguments", () => {
    const first = resolveWorkflowInputs(defs, { count: "bad", extra: 1 })
    const second = resolveWorkflowInputs(defs, { count: "bad", extra: 1 })
    expect(first).toEqual(second)
  })

  it("rejects an array payload even though typeof is object", () => {
    const result = resolveWorkflowInputs(defs, ["feature"])
    expect(result.ok).toBe(false)
  })
})

describe("resolveWorkflowInputs — hardened against unknown JS values", () => {
  it("rejects a Date/Map/class-instance payload even though typeof is object and it is not an array", () => {
    class Custom {}
    for (const bad of [new Date(), new Map(), new Custom()]) {
      const result = resolveWorkflowInputs({}, bad)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.diagnostics).toEqual([
        { kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" },
      ])
    }
  })

  it("accepts a null-prototype object (e.g. Object.create(null)) as a valid payload", () => {
    const supplied = Object.create(null) as Record<string, unknown>
    supplied["feature"] = "auth"
    const result = resolveWorkflowInputs(defs, supplied)
    expect(result).toEqual({ ok: true, inputs: { feature: "auth", count: 3, dryRun: false } })
  })

  it("does not throw and reports wrong_type for a bigint value (JSON.stringify would throw)", () => {
    const result = resolveWorkflowInputs(defs, { feature: "auth", count: 10n as unknown })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([
      { name: "count", kind: "wrong_type", message: 'input "count" must be a number — got 10n' },
    ])
  })

  it("does not throw and reports wrong_type for a circular-reference value (JSON.stringify would throw)", () => {
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    const result = resolveWorkflowInputs(defs, { feature: circular as unknown })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]!.kind).toBe("wrong_type")
    expect(result.diagnostics[0]!.name).toBe("feature")
  })

  it("does not throw for a function or symbol value", () => {
    const withFn = resolveWorkflowInputs(defs, { feature: (() => {}) as unknown })
    expect(withFn.ok).toBe(false)
    const withSymbol = resolveWorkflowInputs(defs, { feature: Symbol("x") as unknown })
    expect(withSymbol.ok).toBe(false)
  })

  it("treats an input literally named `constructor` as an ordinary own-property lookup", () => {
    const constructorDef: InputDef = { type: "string", presence: "required" }
    const special: Readonly<Record<string, InputDef>> = { constructor: constructorDef }
    const result = resolveWorkflowInputs(special, { constructor: "hello" })
    expect(result).toEqual({ ok: true, inputs: { constructor: "hello" } })
  })

  it("treats an input literally named `toString` as an ordinary own-property lookup, never the inherited function", () => {
    const toStringDef: InputDef = { type: "string", presence: "optional", default: "fallback" }
    const special: Readonly<Record<string, InputDef>> = { toString: toStringDef }
    // Genuinely omitted — must resolve to the default, not the inherited
    // `Object.prototype.toString` function (which is never `undefined`).
    const omitted = resolveWorkflowInputs(special, {})
    expect(omitted).toEqual({ ok: true, inputs: { toString: "fallback" } })

    const supplied = resolveWorkflowInputs(special, { toString: "explicit" })
    expect(supplied).toEqual({ ok: true, inputs: { toString: "explicit" } })
  })

  it("treats an input literally named `__proto__` as a genuine own property end to end (defs, supplied, and resolved output)", () => {
    // `Object.fromEntries` (not a `{"__proto__": ...}` object literal,
    // which would set the object's [[Prototype]] instead of creating an
    // own property) — the same construction an actual JSON.parse of an
    // HTTP request body produces for this key.
    const special = Object.fromEntries([["__proto__", { type: "string", presence: "required" }]]) as Readonly<Record<string, InputDef>>
    expect(Object.prototype.hasOwnProperty.call(special, "__proto__")).toBe(true)

    const supplied = Object.fromEntries([["__proto__", "hello"]]) as unknown
    const result = resolveWorkflowInputs(special, supplied)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.prototype.hasOwnProperty.call(result.inputs, "__proto__")).toBe(true)
    expect(result.inputs["__proto__"]).toBe("hello")
    expect(Object.keys(result.inputs)).toEqual(["__proto__"])
  })

  it("rejects an unknown input literally named `hasOwnProperty` exactly like any other undeclared name", () => {
    const supplied = JSON.parse(JSON.stringify({ hasOwnProperty: "x" })) as unknown
    const result = resolveWorkflowInputs({}, supplied)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([
      { name: "hasOwnProperty", kind: "unknown_input", message: 'input "hasOwnProperty" is not declared by this workflow — the workflow declares no inputs' },
    ])
  })
})

describe("resolveWorkflowInputs — totality against hostile/revoked Proxy values", () => {
  it("a revoked Proxy (every trap throws) is rejected as invalid_payload, never an uncaught exception", () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const result = resolveWorkflowInputs(defs, proxy)
    expect(result).toEqual({
      ok: false,
      diagnostics: [{ kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" }],
    })
  })

  it("a Proxy whose getPrototypeOf trap throws is rejected as invalid_payload, not an uncaught exception", () => {
    const hostile = new Proxy(
      { feature: "auth" },
      {
        getPrototypeOf(): never {
          throw new Error("getPrototypeOf trap boom")
        },
      },
    )
    const result = resolveWorkflowInputs(defs, hostile)
    expect(result).toEqual({
      ok: false,
      diagnostics: [{ kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" }],
    })
  })

  it("a Proxy whose ownKeys trap throws is rejected as invalid_payload — no per-input checks run", () => {
    const hostile = new Proxy(
      { feature: "auth" },
      {
        ownKeys(): never {
          throw new Error("ownKeys trap boom")
        },
      },
    )
    const result = resolveWorkflowInputs(defs, hostile)
    expect(result).toEqual({
      ok: false,
      diagnostics: [{ kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" }],
    })
  })

  it("a Proxy whose getOwnPropertyDescriptor trap throws for every key is rejected as invalid_payload", () => {
    const hostile = new Proxy(
      { feature: "auth" },
      {
        getOwnPropertyDescriptor(): never {
          throw new Error("getOwnPropertyDescriptor trap boom")
        },
      },
    )
    // `Object.keys` invokes `getOwnPropertyDescriptor` per candidate key
    // as part of its enumerability invariant check, so a trap that
    // always throws fails enumeration itself (safeOwnKeys), not just an
    // individual value read.
    const result = resolveWorkflowInputs(defs, hostile)
    expect(result).toEqual({
      ok: false,
      diagnostics: [{ kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" }],
    })
  })

  it("a Proxy whose getOwnPropertyDescriptor trap throws for ONE undeclared-by-ownKeys name degrades to a local wrong_type diagnostic, not invalid_payload", () => {
    // `ownKeys` never mentions "count", so enumeration (safeOwnKeys)
    // succeeds cleanly; only the direct per-declared-name probe for
    // "count" (safeOwnValue) hits the hostile trap. Every other
    // declared/supplied name resolves normally.
    const target = { feature: "auth" }
    const hostile = new Proxy(target, {
      ownKeys(t) {
        return Reflect.ownKeys(t)
      },
      getOwnPropertyDescriptor(t, key) {
        if (key === "count") throw new Error("getOwnPropertyDescriptor trap boom for count")
        return Object.getOwnPropertyDescriptor(t, key)
      },
    })
    const result = resolveWorkflowInputs(defs, hostile)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toEqual([
      { name: "count", kind: "wrong_type", message: 'input "count" must be a number — its value could not be read' },
    ])
  })

  it("legal proto-safe input names (`__proto__`, `constructor`, `toString`) still resolve correctly through an ordinary (non-hostile) Proxy wrapper", () => {
    const special: Readonly<Record<string, InputDef>> = {
      __proto__special: { type: "string", presence: "required" },
    }
    const suppliedTarget = Object.fromEntries([["__proto__special", "hello"]]) as Record<string, unknown>
    const transparentProxy = new Proxy(suppliedTarget, {})
    const result = resolveWorkflowInputs(special, transparentProxy)
    expect(result).toEqual({ ok: true, inputs: { __proto__special: "hello" } })
  })
})
