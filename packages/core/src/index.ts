export const name = "@conductor/core" as const

export { interpret, isTerminal } from "./interpret.ts"
export {
  buildEvalContext,
  extractExpressions,
  renderTemplate,
  resolveJobOutputs,
} from "./template.ts"
export {
  evaluate,
  parseExpression,
  collectCalls,
  collectPaths,
  formatPath,
  typecheckExpression,
  STATUS_FUNCTIONS,
  MissingValueError,
  ExpressionError,
} from "./expression.ts"
export type {
  BinaryOp,
  EvalContext,
  Expr,
  ExprType,
  ParseResult,
  StepOutputsContext,
  TypeOfPath,
  Value,
} from "./expression.ts"
export { parseWorkflow } from "./parse.ts"
export type { ParseError, ParseWorkflowResult } from "./parse.ts"
export { validateWorkflow } from "./validate.ts"
export type * from "./types.ts"
export type { RenderResult } from "./template.ts"
export type { ValidationResult } from "./validate.ts"
