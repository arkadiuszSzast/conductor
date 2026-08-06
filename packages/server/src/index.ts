export const name = "@conductor/server" as const

export {
  migrateDatabase,
  openDatabase,
  openMigratedDatabase,
  resolveDatabasePath,
} from "./database.ts"
export type { Database, DatabaseConfig, DatabaseConnection } from "./database.ts"
export { migrations, runMigrations } from "./migrations.ts"
export type { Migration } from "./migrations.ts"
export { Store } from "./store.ts"
export type {
  LegacyDecision,
  LegacyFeatureState,
  LegacyFeatureStatus,
  LegacyPipelineEvent,
  LegacyTransition,
} from "./store.ts"

export { loadActionRegistry } from "./action-registry.ts"
export type {
  ActionRegistryConfig,
  ActionRegistryLoadDiagnostic,
  ActionRegistrySearchPath,
  LoadedActionRegistry,
  LoadActionRegistryResult,
} from "./action-registry.ts"
export {
  actionBindingsForReconciler,
  checkWorkflowReservation,
} from "./workflow-reservation.ts"
export type {
  CheckWorkflowReservationResult,
  ReconcilerActionBindings,
  ResolvedActionBinding,
  ResolvedActionBindings,
  WorkflowReservation,
  WorkflowReservationDiagnostic,
} from "./workflow-reservation.ts"

// ---------------------------------------------------------------------------
// Legacy compatibility engine (opencode-conductor's engine/reconciler/
// builtins/GitHub integration/findings publication) — distinct from the
// @conductor/core graph workflow model. See ./legacy/index.ts.
// ---------------------------------------------------------------------------
export {
  LegacyEngine,
  interpretLegacy,
  isTerminalLegacy,
  renderLegacy,
  legacyBuiltins,
  RealGh,
  realProcessRunner,
  makePublishReviewLegacy,
  parseFindingsLegacy,
  parseResolutionsLegacy,
  severitySummaryLegacy,
  LEGACY_DEFAULT_SEVERITY,
  systemClock,
  pipelineForLegacyWorkflow,
} from "./legacy/index.ts"
export type {
  LegacyEngineDeps,
  LegacyRenderResult,
  LegacyBuiltinContext,
  LegacyStepOutcome,
  LegacyFinding,
  LegacyResolution,
  LegacyReviewFindings,
  LegacySeverity,
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
} from "./legacy/index.ts"
