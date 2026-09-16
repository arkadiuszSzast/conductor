export const name = "@conductor/server" as const
export type { ReviewFinding, ReviewReport } from "./review.ts"

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
  AcceptAnswerResult,
  AnswerDeliveryRecord,
  AnswerDeliveryStatus,
  FeatureFilter,
  FeatureRecord,
  FindingCounts,
  FindingView,
  PauseAccounting,
  ResourceWaitRecord,
  ResourceWaitStatus,
  RetryEpisodeRecord,
  RetryEpisodeStatus,
  RunActionMetadata,
  RunSummary,
  StoreChange,
  TransitionEntry,
} from "./store.ts"

export { applyPatch, initialFeatureState } from "./state.ts"
export type { CreateFeatureInput, InitialFeatureStateInput } from "./state.ts"

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

export { WorkflowRegistry } from "./workflow-registry.ts"
export type {
  LoadResult,
  WorkflowDiagnostic,
  WorkflowRegistryOptions,
  WorkflowResolver,
  WorkflowSnapshot,
  WorkflowStatus,
} from "./workflow-registry.ts"

export { Engine } from "./engine.ts"
export type { EngineDeps, EngineOptions, StartFeatureInput, StartFeatureResult } from "./engine.ts"

export { ActionHost, CapabilityDeniedError, realSleep } from "./action-host.ts"
export type { ActionHandler, ActionHostDeps, ActionHostExecuteResult } from "./action-host.ts"
export { bundledHandlers } from "./actions/bundled.ts"

export { realPluginProcessSpawner, realPortAllocator, realProcessRunner } from "./process.ts"
export { systemClock } from "./ports.ts"
export type {
  Clock,
  Logger,
  PluginProcessExit,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessSpawner,
  PortAllocator,
  ProcessExecOptions,
  ProcessExecResult,
  ProcessRunner,
  SessionClient,
} from "./ports.ts"

export { Daemon, jsonLineLogger, systemIntervalScheduler } from "./daemon.ts"
export type {
  DaemonConfig,
  DaemonDeps,
  DaemonHealth,
  DaemonLogEntry,
  DaemonLogLevel,
  DaemonLogger,
  DaemonPhase,
  DaemonProjectHealth,
  IntervalScheduler,
  Reconciler,
} from "./daemon.ts"

export { createApi, startApiServer } from "./api.ts"
export type {
  ApiAuth,
  ApiBind,
  ApiConfig,
  ApiDeps,
  ApiErrorCode,
  ApiHandler,
  ApiServer,
  ConductorApi,
  EngineControl,
} from "./api.ts"

export { RunnerRegistry } from "./runner-registry.ts"
export type {
  RegisterRunnerInput,
  RunnerDirectory,
  RunnerRegistration,
} from "./runner-registry.ts"

export { PluginRegistry } from "./plugin-registry.ts"
export type {
  DiscoveredPlugin,
  PluginDiagnostic,
  PluginListing,
  PluginRegistryConfig,
  PluginRegistryProject,
  PluginScope,
  PluginState,
  PluginStateKey,
  PluginStateLookup,
} from "./plugin-registry.ts"

export { PluginSupervisor } from "./plugin-supervisor.ts"
export type { PluginSupervisorConfig, PluginSupervisorDeps } from "./plugin-supervisor.ts"

export { createPluginControl, proxyPluginRequest } from "./plugin-proxy.ts"
export type {
  PluginControl,
  PluginListingPayload,
  PluginProxyResult,
  PluginResolveResult,
  PluginSupervisorView,
  PluginTarget,
} from "./plugin-proxy.ts"

export { NoLiveRunnerError, createRunnerSessionClient } from "./runner-transport.ts"
export type { RunnerFetch, RunnerSessionClientDeps } from "./runner-transport.ts"

// Re-export the graph workflow IR types the server operates on, so
// consumers (CLI, runner adapter) can depend on @conductor/server alone
// for the runtime types they touch (FeatureState, PipelineEvent, …).
export type {
  Decision,
  FeatureState,
  FeatureStatus,
  Feedback,
  InputDef,
  InputType,
  JobPatch,
  JobRuntime,
  JobStatus,
  Patch,
  PipelineEvent,
  StepPatch,
  StepRuntime,
  StepStatus,
  Transition,
  WorkflowInputDiagnostic,
} from "@conductor/core"

// Re-export retry-policy's shared taxonomy/policy/decision types
// (packages/core/src/failure.ts, retry-policy.ts, lifecycle.ts) —
// consumers driving the store's retry/resource-wait accessors need
// these without a separate @conductor/core dependency.
export type {
  FailureClass,
  FailureEnvelope,
  NormalizedResourceWaitPolicy,
  NormalizedRetryPolicy,
  RecoverDecision,
  RecoverRequest,
  RecoverTarget,
  RecoverableStatus,
  ResourceReason,
  ResourceWaitRouteDecision,
  ResourceWaitState,
  RetryBudget,
  RetryEpisodeState,
} from "@conductor/core"
