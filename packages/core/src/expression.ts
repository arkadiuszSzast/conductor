/**
 * The expression language: a small, deterministic grammar evaluated against
 * immutable context data. No ambient filesystem, network, clock, randomness
 * or code evaluation — the only capabilities are property lookup on the
 * provided context and whitelisted zero-argument status functions whose
 * values the caller supplies as data.
 *
 * Grammar (loosest to tightest binding):
 *
 *   expr        := coalesce
 *   coalesce    := or ( "??" or )*
 *   or          := and ( "||" and )*
 *   and         := equality ( "&&" equality )*
 *   equality    := relational ( ("==" | "!=") relational )*
 *   relational  := unary ( ("<" | "<=" | ">" | ">=") unary )*
 *   unary       := ("!" | "-") unary | primary
 *   primary     := literal | call | path | "(" expr ")"
 *   path        := ident ( "." ident | "[" string "]" )*
 *   call        := ident "(" ")"
 *   literal     := number | string | "true" | "false" | "null"
 *
 * Bracket indices must be string literals — dynamic keys would defeat the
 * static reference validation that makes typos compile-time errors.
 */

import type { Feedback } from "./types.ts"

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Value = string | number | boolean | null

export type BinaryOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||" | "??"

export type Expr =
  | { readonly kind: "literal"; readonly value: Value }
  | { readonly kind: "path"; readonly segments: readonly string[] }
  | { readonly kind: "call"; readonly name: string }
  | { readonly kind: "unary"; readonly op: "!" | "-"; readonly operand: Expr }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }

/** The only callable names in the grammar. Their values are booleans the
 *  caller precomputes from persisted state — never computed here. */
export const STATUS_FUNCTIONS = ["success", "failure", "cancelled", "always"] as const

export type ParseResult =
  | { readonly ok: true; readonly expr: Expr }
  | { readonly ok: false; readonly error: string }

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string }

const TWO_CHAR_PUNCT = ["==", "!=", "<=", ">=", "&&", "||", "??"]
const ONE_CHAR_PUNCT = ["<", ">", "!", "(", ")", "[", "]", ".", "-"]

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c)
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_-]/.test(c)
const isDigit = (c: string): boolean => c >= "0" && c <= "9"

function lex(source: string): { readonly tokens: Token[] } | { readonly error: string } {
  const tokens: Token[] = []
  let i = 0

  while (i < source.length) {
    const c = source[i]!
    if (/\s/.test(c)) { i += 1; continue }

    if (c === '"' || c === "'") {
      const quote = c
      let value = ""
      i += 1
      let closed = false
      while (i < source.length) {
        const ch = source[i]!
        if (ch === "\\") {
          const escaped = source[i + 1]
          if (escaped === undefined) return { error: "unterminated string literal" }
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped
          i += 2
          continue
        }
        if (ch === quote) { closed = true; i += 1; break }
        value += ch
        i += 1
      }
      if (!closed) return { error: "unterminated string literal" }
      tokens.push({ kind: "string", value })
      continue
    }

    if (isDigit(c)) {
      let end = i
      while (end < source.length && isDigit(source[end]!)) end += 1
      if (source[end] === "." && isDigit(source[end + 1] ?? "")) {
        end += 1
        while (end < source.length && isDigit(source[end]!)) end += 1
      }
      tokens.push({ kind: "number", value: Number(source.slice(i, end)) })
      i = end
      continue
    }

    if (isIdentStart(c)) {
      let end = i
      while (end < source.length && isIdentChar(source[end]!)) end += 1
      tokens.push({ kind: "ident", value: source.slice(i, end) })
      i = end
      continue
    }

    const two = source.slice(i, i + 2)
    if (TWO_CHAR_PUNCT.includes(two)) {
      tokens.push({ kind: "punct", value: two })
      i += 2
      continue
    }
    if (ONE_CHAR_PUNCT.includes(c)) {
      tokens.push({ kind: "punct", value: c })
      i += 1
      continue
    }

    return { error: `unexpected character "${c}"` }
  }

  return { tokens }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseExpression(source: string): ParseResult {
  const lexed = lex(source)
  if ("error" in lexed) return { ok: false, error: lexed.error }
  const tokens = lexed.tokens
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]
  const isPunct = (value: string): boolean => {
    const token = peek()
    return token?.kind === "punct" && token.value === value
  }
  const takePunct = (value: string): boolean => {
    if (!isPunct(value)) return false
    pos += 1
    return true
  }

  class ParseError extends Error {}
  const fail = (message: string): never => { throw new ParseError(message) }

  const describe = (token: Token | undefined): string =>
    token === undefined ? "end of expression" : token.kind === "punct" ? `"${token.value}"` : `"${String(token.value)}"`

  function parseCoalesce(): Expr {
    let left = parseOr()
    while (takePunct("??")) left = { kind: "binary", op: "??", left, right: parseOr() }
    return left
  }
  function parseOr(): Expr {
    let left = parseAnd()
    while (takePunct("||")) left = { kind: "binary", op: "||", left, right: parseAnd() }
    return left
  }
  function parseAnd(): Expr {
    let left = parseEquality()
    while (takePunct("&&")) left = { kind: "binary", op: "&&", left, right: parseEquality() }
    return left
  }
  function parseEquality(): Expr {
    let left = parseRelational()
    for (;;) {
      const op = isPunct("==") ? "==" : isPunct("!=") ? "!=" : undefined
      if (op === undefined) return left
      pos += 1
      left = { kind: "binary", op, left, right: parseRelational() }
    }
  }
  function parseRelational(): Expr {
    let left = parseUnary()
    for (;;) {
      const op = isPunct("<=") ? "<=" : isPunct(">=") ? ">=" : isPunct("<") ? "<" : isPunct(">") ? ">" : undefined
      if (op === undefined) return left
      pos += 1
      left = { kind: "binary", op, left, right: parseUnary() }
    }
  }
  function parseUnary(): Expr {
    if (takePunct("!")) return { kind: "unary", op: "!", operand: parseUnary() }
    if (takePunct("-")) return { kind: "unary", op: "-", operand: parseUnary() }
    return parsePrimary()
  }

  function parsePrimary(): Expr {
    const token = peek()
    if (token === undefined) return fail("unexpected end of expression")

    if (token.kind === "number") { pos += 1; return { kind: "literal", value: token.value } }
    if (token.kind === "string") { pos += 1; return { kind: "literal", value: token.value } }

    if (token.kind === "punct" && token.value === "(") {
      pos += 1
      const inner = parseCoalesce()
      if (!takePunct(")")) return fail(`expected ")" but found ${describe(peek())}`)
      return inner
    }

    if (token.kind === "ident") {
      pos += 1
      if (token.value === "true") return { kind: "literal", value: true }
      if (token.value === "false") return { kind: "literal", value: false }
      if (token.value === "null") return { kind: "literal", value: null }

      if (takePunct("(")) {
        if (!takePunct(")")) return fail(`expected ")" after "${token.value}(" — status functions take no arguments`)
        if (!(STATUS_FUNCTIONS as readonly string[]).includes(token.value)) {
          return fail(`unknown function "${token.value}()" — available: ${STATUS_FUNCTIONS.map(f => `${f}()`).join(", ")}`)
        }
        return { kind: "call", name: token.value }
      }

      const segments: string[] = [token.value]
      for (;;) {
        if (takePunct(".")) {
          const next = peek()
          if (next?.kind !== "ident") return fail(`expected a property name after "." but found ${describe(next)}`)
          pos += 1
          segments.push(next.value)
          continue
        }
        if (takePunct("[")) {
          const key = peek()
          if (key?.kind !== "string") return fail("bracket index must be a string literal")
          pos += 1
          if (!takePunct("]")) return fail(`expected "]" but found ${describe(peek())}`)
          segments.push(key.value)
          continue
        }
        break
      }
      return { kind: "path", segments }
    }

    return fail(`unexpected ${describe(token)}`)
  }

  try {
    const expr = parseCoalesce()
    if (pos < tokens.length) return { ok: false, error: `unexpected ${describe(peek())} after expression` }
    return { ok: true, expr }
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message }
    throw error
  }
}

// ---------------------------------------------------------------------------
// AST walking
// ---------------------------------------------------------------------------

export function collectPaths(expr: Expr): readonly (readonly string[])[] {
  const paths: (readonly string[])[] = []
  visit(expr, node => { if (node.kind === "path") paths.push(node.segments) })
  return paths
}

export function collectCalls(expr: Expr): readonly string[] {
  const calls: string[] = []
  visit(expr, node => { if (node.kind === "call") calls.push(node.name) })
  return calls
}

function visit(expr: Expr, fn: (node: Expr) => void): void {
  fn(expr)
  if (expr.kind === "unary") visit(expr.operand, fn)
  if (expr.kind === "binary") {
    visit(expr.left, fn)
    visit(expr.right, fn)
  }
}

export function formatPath(segments: readonly string[]): string {
  return segments.join(".")
}

// ---------------------------------------------------------------------------
// Type checking (static, against workflow-declared types)
// ---------------------------------------------------------------------------

export type ExprType = "string" | "number" | "boolean" | "null" | "unknown"

/** Resolves a path to its declared type; `undefined` means "not statically
 *  known" (reference validation reports invalid paths separately). */
export type TypeOfPath = (segments: readonly string[]) => ExprType | undefined

export interface TypecheckResult {
  readonly type: ExprType
  readonly errors: readonly string[]
}

export function typecheckExpression(expr: Expr, typeOfPath: TypeOfPath): TypecheckResult {
  const errors: string[] = []

  const expect = (actual: ExprType, wanted: ExprType, what: string): void => {
    if (actual !== wanted && actual !== "unknown") {
      errors.push(`${what} expects ${wanted}, got ${actual}`)
    }
  }

  const infer = (node: Expr): ExprType => {
    switch (node.kind) {
      case "literal":
        if (node.value === null) return "null"
        return typeof node.value as ExprType
      case "path":
        return typeOfPath(node.segments) ?? "unknown"
      case "call":
        return "boolean"
      case "unary": {
        const operand = infer(node.operand)
        if (node.op === "!") {
          expect(operand, "boolean", '"!"')
          return "boolean"
        }
        expect(operand, "number", '"-"')
        return "number"
      }
      case "binary": {
        const left = infer(node.left)
        const right = infer(node.right)
        switch (node.op) {
          case "&&":
          case "||":
            expect(left, "boolean", `"${node.op}"`)
            expect(right, "boolean", `"${node.op}"`)
            return "boolean"
          case "<":
          case "<=":
          case ">":
          case ">=":
            expect(left, "number", `"${node.op}"`)
            expect(right, "number", `"${node.op}"`)
            return "boolean"
          case "==":
          case "!=":
            return "boolean"
          case "??":
            if (left === "null") return right
            if (left === right) return left
            return "unknown"
        }
      }
    }
  }

  const type = infer(expr)
  return { type, errors }
}

// ---------------------------------------------------------------------------
// Evaluation (pure — the context is plain persisted data)
// ---------------------------------------------------------------------------

export interface StepOutputsContext {
  readonly outputs: Readonly<Record<string, string>>
}

export interface EvalContext {
  readonly inputs: Readonly<Record<string, Value>>
  readonly steps: Readonly<Record<string, StepOutputsContext>>
  readonly needs: Readonly<Record<string, StepOutputsContext>>
  /** Absent outside a rerun round — `feedback.*` then resolves to null
   *  (soft by design; templates render null as the empty string). */
  readonly feedback?: Feedback
  /** Precomputed status-function values (`always`, `failure`, …). */
  readonly functions?: Readonly<Record<string, Value>>
}

/** A hard reference (`inputs`/`steps`/`needs`) that resolves to nothing.
 *  Callers fail before side effects; `??` catches it to supply a default. */
export class MissingValueError extends Error {
  constructor(readonly path: string) {
    super(`no value for "${path}"`)
  }
}

export class ExpressionError extends Error {}

export function evaluate(expr: Expr, context: EvalContext): Value {
  switch (expr.kind) {
    case "literal":
      return expr.value
    case "path":
      return evaluatePath(expr.segments, context)
    case "call": {
      const value = context.functions?.[expr.name]
      if (value === undefined) throw new ExpressionError(`${expr.name}() is not available in this context`)
      return value
    }
    case "unary": {
      const operand = evaluate(expr.operand, context)
      if (expr.op === "!") return !requireBoolean(operand, '"!"')
      return -requireNumber(operand, '"-"')
    }
    case "binary":
      return evaluateBinary(expr, context)
  }
}

function evaluateBinary(expr: Extract<Expr, { kind: "binary" }>, context: EvalContext): Value {
  switch (expr.op) {
    case "??": {
      let left: Value
      try {
        left = evaluate(expr.left, context)
      } catch (error) {
        if (error instanceof MissingValueError) return evaluate(expr.right, context)
        throw error
      }
      return left === null ? evaluate(expr.right, context) : left
    }
    case "&&": {
      const left = requireBoolean(evaluate(expr.left, context), '"&&"')
      if (!left) return false
      return requireBoolean(evaluate(expr.right, context), '"&&"')
    }
    case "||": {
      const left = requireBoolean(evaluate(expr.left, context), '"||"')
      if (left) return true
      return requireBoolean(evaluate(expr.right, context), '"||"')
    }
    case "==":
      return evaluate(expr.left, context) === evaluate(expr.right, context)
    case "!=":
      return evaluate(expr.left, context) !== evaluate(expr.right, context)
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const left = requireNumber(evaluate(expr.left, context), `"${expr.op}"`)
      const right = requireNumber(evaluate(expr.right, context), `"${expr.op}"`)
      switch (expr.op) {
        case "<": return left < right
        case "<=": return left <= right
        case ">": return left > right
        case ">=": return left >= right
      }
    }
  }
}

function evaluatePath(segments: readonly string[], context: EvalContext): Value {
  const [root, ...rest] = segments
  const dotted = formatPath(segments)

  if (root === "feedback") {
    const value = walk(context.feedback, rest)
    if (value === undefined) return null
    return requireValue(value, dotted)
  }

  if (root === "inputs" || root === "steps" || root === "needs") {
    const value = walk(context[root], rest)
    if (value === undefined) throw new MissingValueError(dotted)
    return requireValue(value, dotted)
  }

  throw new ExpressionError(`unknown context "${root ?? ""}" in "${dotted}"`)
}

function walk(start: unknown, segments: readonly string[]): unknown {
  let current: unknown = start
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
    if (current === undefined) return undefined
  }
  return current
}

function requireValue(value: unknown, path: string): Value {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  throw new ExpressionError(`"${path}" is not a single value`)
}

function requireBoolean(value: Value, what: string): boolean {
  if (typeof value !== "boolean") throw new ExpressionError(`${what} expects boolean, got ${typeName(value)}`)
  return value
}

function requireNumber(value: Value, what: string): number {
  if (typeof value !== "number") throw new ExpressionError(`${what} expects number, got ${typeName(value)}`)
  return value
}

function typeName(value: Value): string {
  return value === null ? "null" : typeof value
}
