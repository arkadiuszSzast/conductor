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
  Decision,
  FeatureState,
  FeatureStatus,
  PipelineEvent,
  Transition,
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
// Pipeline engine (opencode-conductor's engine/reconciler/
// builtins/GitHub integration/findings publication) — distinct from the
// @conductor/core graph workflow model. See ./engine/index.ts.
// ---------------------------------------------------------------------------
export {
  Engine,
  interpret,
  isTerminal,
  renderTemplate,
  builtins,
  RealGh,
  realProcessRunner,
  makePublishReview,
  parseFindings,
  parseResolutions,
  severitySummary,
  DEFAULT_SEVERITY,
  systemClock,
  pipelineForWorkflow,
} from "./engine/index.ts"
export type {
  EngineDeps,
  RenderResult,
  BuiltinContext,
  StepOutcome,
  Finding,
  Resolution,
  ReviewFindings,
  Severity,
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
} from "./engine/index.ts"
