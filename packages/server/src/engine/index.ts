/**
 * Pipeline engine (opencode-conductor's engine/reconciler/
 * builtins/GitHub integration/findings publication ported onto the
 * extracted SQLite store, behind explicit dependency interfaces.
 *
 * This is the seed's single-`current_step` pipeline model, distinct
 * from `@conductor/core`'s graph workflow IR
 * (`WorkflowDef`/`JobDef`). It exists so the daemon can run the seed's
 * battle-tested semantics today while the graph engine is built out
 * separately (workflow-format tasks). Do not extend this module with
 * graph/DAG concepts — that work belongs in `@conductor/core` and a
 * future graph-aware engine.
 */

export { Engine } from "./engine.ts"
export type { EngineDeps } from "./engine.ts"

export { interpret, isTerminal } from "./interpret.ts"

export { renderTemplate } from "./template.ts"
export type { RenderResult } from "./template.ts"

export { builtins } from "./builtins.ts"
export type { BuiltinContext, StepOutcome } from "./builtins.ts"

export { RealGh } from "./gh.ts"

export { realProcessRunner } from "./process.ts"

export {
  makePublishReview,
  parseFindings,
  parseResolutions,
  severitySummary,
  DEFAULT_SEVERITY as DEFAULT_SEVERITY,
} from "./publish-review.ts"
export type {
  Finding,
  Resolution,
  ReviewFindings,
  Severity,
} from "./publish-review.ts"

export { systemClock } from "./ports.ts"
export type {
  Clock,
  Logger,
  ConfigResolver,
  GhClient,
  CheckSummary,
  PrView,
  ReviewThread,
  ReviewComment,
  ReviewPayload,
  PublishInput,
  PublishReview,
  SessionClient,
  StorePort,
  ProcessExecOptions,
  ProcessExecResult,
  ProcessRunner,
} from "./ports.ts"

export { pipelineForWorkflow } from "./types.ts"
export type {
  AgentStep,
  BuiltinAction,
  BuiltinStep,
  CommandStep,
  EngineConfig,
  OnFail,
  OnVerdict,
  PipelineDef,
  PublishDef,
  RoleDef,
  StepDef,
} from "./types.ts"

export { validatePipeline } from "./validate.ts"
export type { ValidationResult } from "./validate.ts"
