/**
 * Legacy compatibility engine — opencode-conductor's engine/reconciler/
 * builtins/GitHub integration/findings publication ported onto the
 * extracted SQLite store, behind explicit dependency interfaces.
 *
 * "Legacy" here is deliberate: this is the seed's single-`current_step`
 * pipeline model, distinct from `@conductor/core`'s graph workflow IR
 * (`WorkflowDef`/`JobDef`). It exists so the daemon can run the seed's
 * battle-tested semantics today while the graph engine is built out
 * separately (workflow-format tasks). Do not extend this module with
 * graph/DAG concepts — that work belongs in `@conductor/core` and a
 * future graph-aware engine.
 */

export { LegacyEngine } from "./engine.ts"
export type { LegacyEngineDeps } from "./engine.ts"

export { interpretLegacy, isTerminalLegacy } from "./interpret.ts"

export { renderLegacy } from "./template.ts"
export type { LegacyRenderResult } from "./template.ts"

export { legacyBuiltins } from "./builtins.ts"
export type { LegacyBuiltinContext, LegacyStepOutcome } from "./builtins.ts"

export { RealGh } from "./gh.ts"

export { realProcessRunner } from "./process.ts"

export {
  makePublishReviewLegacy,
  parseFindingsLegacy,
  parseResolutionsLegacy,
  severitySummaryLegacy,
  DEFAULT_SEVERITY as LEGACY_DEFAULT_SEVERITY,
} from "./publish-review.ts"
export type {
  LegacyFinding,
  LegacyResolution,
  LegacyReviewFindings,
  LegacySeverity,
} from "./publish-review.ts"

export { systemClock } from "./ports.ts"
export type {
  Clock,
  Logger,
  LegacyConfigResolver,
  LegacyGh,
  LegacyCheckSummary,
  LegacyPrView,
  LegacyReviewThread,
  LegacyReviewComment,
  LegacyReviewPayload,
  LegacyPublishInput,
  LegacyPublishReview,
  LegacySessionClient,
  LegacyStorePort,
  ProcessExecOptions,
  ProcessExecResult,
  ProcessRunner,
} from "./ports.ts"

export { pipelineForLegacyWorkflow } from "./types.ts"
export type {
  LegacyAgentStep,
  LegacyBuiltinAction,
  LegacyBuiltinStep,
  LegacyCommandStep,
  LegacyConfig,
  LegacyOnFail,
  LegacyOnVerdict,
  LegacyPipelineDef,
  LegacyPublishDef,
  LegacyRoleDef,
  LegacyStepDef,
} from "./types.ts"
