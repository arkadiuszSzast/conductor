import { describe, expect, it } from "bun:test"
import {
  collectCalls,
  collectPaths,
  evaluate,
  ExpressionError,
  formatPath,
  MissingValueError,
  parseExpression,
  typecheckExpression,
} from "./src/expression.ts"
import type { EvalContext, Expr, ExprType, TypeOfPath } from "./src/expression.ts"

const context: EvalContext = {
  inputs: { feature: "auth", count: 3, dry: true },
  steps: {
    design: { outputs: { report: "DESIGN" } },
    gate: { outputs: {} },
  },
  needs: {
    "arch-a": { outputs: { design: "A" } },
  },
  feature: { title: "Add auth", slug: "add-auth", description: "Implement the auth change", pr: null },
  functions: { success: true, failure: false, always: true },
}

function evalExpr(source: string, ctx: EvalContext = context): ReturnType<typeof evaluate> {
  const parsed = parseExpression(source)
  if (!parsed.ok) throw new Error(parsed.error)
  return evaluate(parsed.expr, ctx)
}

describe("parseExpression", () => {
  it("accepts literals", () => {
    expect(parseExpression("42").ok).toBe(true)
    expect(parseExpression("'a b'").ok).toBe(true)
    expect(parseExpression('"a b"').ok).toBe(true)
    expect(parseExpression("true").ok).toBe(true)
    expect(parseExpression("null").ok).toBe(true)
  })

  it("accepts paths with dot and bracket access", () => {
    expect(parseExpression("steps.design.outputs.report").ok).toBe(true)
    expect(parseExpression('needs["arch-a"].outputs.design').ok).toBe(true)
  })

  it("accepts operators and functions", () => {
    expect(parseExpression("a == b").ok).toBe(true)
    expect(parseExpression("a != b").ok).toBe(true)
    expect(parseExpression("a < b").ok).toBe(true)
    expect(parseExpression("a <= b").ok).toBe(true)
    expect(parseExpression("a > b").ok).toBe(true)
    expect(parseExpression("a >= b").ok).toBe(true)
    expect(parseExpression("a && b").ok).toBe(true)
    expect(parseExpression("a || b").ok).toBe(true)
    expect(parseExpression("a ?? b").ok).toBe(true)
    expect(parseExpression("!a").ok).toBe(true)
    expect(parseExpression("-a").ok).toBe(true)
    expect(parseExpression("(a == b) && always()").ok).toBe(true)
  })

  it("rejects unknown functions", () => {
    const r = parseExpression("danger()")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("danger")
  })

  it("rejects functions with arguments", () => {
    const r = parseExpression("always(1)")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("no arguments")
  })

  it("rejects trailing garbage", () => {
    expect(parseExpression("a b").ok).toBe(false)
    expect(parseExpression("a b == c").ok).toBe(false)
  })

  it("rejects stray punctuation", () => {
    expect(parseExpression("a + b").ok).toBe(false)
    expect(parseExpression("a @ b").ok).toBe(false)
    expect(parseExpression("a[").ok).toBe(false)
    expect(parseExpression("").ok).toBe(false)
  })

  it("rejects bracket index that is not a string literal", () => {
    const r = parseExpression("needs[0]")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("string literal")
  })

  it("rejects unterminated string", () => {
    expect(parseExpression("'abc").ok).toBe(false)
  })

  it("accepts single and double quoted strings with escapes", () => {
    expect(evalExpr("'it\\'s'")).toBe("it's")
    expect(evalExpr('"a\\nb"')).toBe("a\nb")
  })
})

describe("evaluate", () => {
  it("evaluates literals and paths", () => {
    expect(evalExpr("42")).toBe(42)
    expect(evalExpr("'hi'")).toBe("hi")
    expect(evalExpr("inputs.feature")).toBe("auth")
    expect(evalExpr("steps.design.outputs.report")).toBe("DESIGN")
    expect(evalExpr('needs["arch-a"].outputs.design')).toBe("A")
  })

  it("reads status function values from context data", () => {
    expect(evalExpr("always()")).toBe(true)
    expect(evalExpr("failure()")).toBe(false)
    expect(evalExpr("success() && !failure()")).toBe(true)
  })

  it("applies comparison operators", () => {
    expect(evalExpr("inputs.count > 2")).toBe(true)
    expect(evalExpr("inputs.count >= 3")).toBe(true)
    expect(evalExpr("inputs.count < 3")).toBe(false)
    expect(evalExpr("inputs.count <= 2")).toBe(false)
    expect(evalExpr("1 != 2")).toBe(true)
    expect(evalExpr("1 == 2")).toBe(false)
    expect(evalExpr("inputs.feature == 'auth'")).toBe(true)
    expect(evalExpr("inputs.feature != 'auth'")).toBe(false)
  })

  it("applies boolean operators", () => {
    expect(evalExpr("true && false")).toBe(false)
    expect(evalExpr("true || false")).toBe(true)
    expect(evalExpr("!true")).toBe(false)
    expect(evalExpr("!inputs.dry")).toBe(false)
  })

  it("short-circuits && and ||", () => {
    expect(evalExpr("false && inputs.missing")).toBe(false)
    expect(evalExpr("true || inputs.missing")).toBe(true)
  })

  it("coalesces null and hard misses", () => {
    expect(evalExpr("null ?? 'fallback'")).toBe("fallback")
    expect(evalExpr("steps.gate.outputs.absent ?? 'none'")).toBe("none")
    expect(evalExpr("steps.missing.outputs.report ?? 'none'")).toBe("none")
    expect(evalExpr("steps.gate.outputs.absent ?? inputs.feature")).toBe("auth")
  })

  it("propagates hard misses without a coalescing guard", () => {
    expect(() => evalExpr("steps.missing.outputs.report")).toThrow(MissingValueError)
    expect(() => evalExpr("steps.gate.outputs.absent")).toThrow(MissingValueError)
    expect(() => evalExpr("inputs.unknown")).toThrow(MissingValueError)
    expect(() => evalExpr("needs.ghost.outputs.x")).toThrow(MissingValueError)
  })

  it("resolves feature fields; pr is soft-null, unknown fields error", () => {
    expect(evalExpr("feature.title")).toBe("Add auth")
    expect(evalExpr("feature.slug")).toBe("add-auth")
    expect(evalExpr("feature.description")).toBe("Implement the auth change")
    expect(evalExpr("feature.pr")).toBeNull()
    expect(evalExpr('feature.pr ?? "none"')).toBe("none")
    expect(() => evalExpr("feature.nope")).toThrow(ExpressionError)
    expect(() => evalExpr("feature.title.extra")).toThrow(ExpressionError)
  })

  it("resolves feedback as soft nulls outside a rerun", () => {
    expect(evalExpr("feedback.message")).toBeNull()
    expect(evalExpr('feedback.jobs["a"]["b"]["c"]')).toBeNull()
  })

  it("resolves feedback from the snapshot", () => {
    const ctx: EvalContext = {
      ...context,
      feedback: {
        message: "changes requested",
        jobs: { "arch-a": { design: { report: "OLD" } }, consensus: { agree: { report: "NOTE" } } },
      },
    }
    expect(evalExpr("feedback.message", ctx)).toBe("changes requested")
    expect(evalExpr('feedback.jobs["arch-a"]["design"]["report"]', ctx)).toBe("OLD")
    expect(evalExpr('feedback.jobs["consensus"]["agree"]["report"]', ctx)).toBe("NOTE")
  })

  it("rejects an unknown context root", () => {
    expect(() => evalExpr("env.PATH")).toThrow(ExpressionError)
    expect(() => evalExpr("feature")).toThrow(ExpressionError)
  })

  it("applies unary minus", () => {
    expect(evalExpr("-3")).toBe(-3)
    expect(evalExpr("-inputs.count < 0")).toBe(true)
  })

  it("enforces operand types at evaluation", () => {
    expect(() => evalExpr("'a' && true")).toThrow(ExpressionError)
    expect(() => evalExpr("'a' < 1")).toThrow(ExpressionError)
    expect(() => evalExpr("-'a'")).toThrow(ExpressionError)
  })
})

describe("typecheckExpression", () => {
  const types: TypeOfPath = path => {
    const map: Record<string, ExprType> = {
      "inputs.feature": "string",
      "inputs.count": "number",
      "inputs.dry": "boolean",
      "steps.a.outputs.report": "string",
      "needs.x.outputs.decision": "unknown",
    }
    return map[formatPath(path)]
  }

  const typeOf = (source: string): { type: ExprType; errors: readonly string[] } => {
    const parsed = parseExpression(source)
    if (!parsed.ok) throw new Error(parsed.error)
    return typecheckExpression(parsed.expr, types)
  }

  it("infers literal types", () => {
    expect(typeOf("42").type).toBe("number")
    expect(typeOf("'x'").type).toBe("string")
    expect(typeOf("true").type).toBe("boolean")
    expect(typeOf("null").type).toBe("null")
  })

  it("infers path and call types", () => {
    expect(typeOf("inputs.count").type).toBe("number")
    expect(typeOf("always()").type).toBe("boolean")
  })

  it("reports number/boolean misuse", () => {
    expect(typeOf("inputs.count && true").errors).toContain('"&&" expects boolean, got number')
    expect(typeOf("inputs.feature < 1").errors).toContain('"<" expects number, got string')
  })

  it("allows equality on any types", () => {
    expect(typeOf("inputs.feature == 'x'").errors).toEqual([])
    expect(typeOf("inputs.feature == inputs.count").errors).toEqual([])
  })

  it("treats unknown (e.g. command-step output names) as compatible", () => {
    expect(typeOf("needs.x.outputs.decision").type).toBe("unknown")
    expect(typeOf("needs.x.outputs.decision == 'ok'").errors).toEqual([])
  })

  it("coalesces to the non-null branch", () => {
    expect(typeOf("null ?? 'x'").type).toBe("string")
    expect(typeOf("inputs.count ?? 0").type).toBe("number")
  })
})

describe("collectPaths / collectCalls", () => {
  const parse = (source: string): Expr => {
    const r = parseExpression(source)
    if (!r.ok) throw new Error(r.error)
    return r.expr
  }

  it("collects every path", () => {
    const paths = collectPaths(parse("inputs.a == steps.b.outputs.c || needs.d.outputs.e"))
    expect(paths.map(formatPath)).toEqual([
      "inputs.a",
      "steps.b.outputs.c",
      "needs.d.outputs.e",
    ])
  })

  it("collects every call", () => {
    expect(collectCalls(parse("success() || failure()"))).toEqual(["success", "failure"])
  })

  it("collects nothing for literals", () => {
    expect(collectPaths(parse("1 == 1"))).toEqual([])
  })
})
