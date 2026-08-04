export const name = "@conductor/core" as const

export { interpret, isTerminal } from "./interpret.ts"
export { render } from "./template.ts"
export { validateWorkflow } from "./validate.ts"
export type * from "./types.ts"
export type { RenderResult } from "./template.ts"
export type { ValidationResult } from "./validate.ts"
