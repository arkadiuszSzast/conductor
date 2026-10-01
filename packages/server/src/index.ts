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
export { ChangeQueueError, Store } from "./store.ts"
export { reconcileStartingEntries } from "./change-queue-reconcile.ts"
export { ChangeQueueScheduler } from "./change-queue-scheduler.ts"
export type {
  ChangeQueueSchedulerDeps,
  ChangeQueueTickResult,
  QueueEngine,
  QueueProjectResult,
  QueueStartFailure,
  QueueStartRecord,
} from "./change-queue-scheduler.ts"
export {
  archivedChangeName,
  ChangeQueueSources,
  diagnoseChange,
  diagnoseUnstartable,
  knownChanges,
  nodeOpenSpecFiles,
} from "./change-queue-sources.ts"
export type {
  ChangeQueueReadPort,
  ChangeQueueSourcePort,
  ChangeQueueSourcesDeps,
  LocalChanges,
  MergedChanges,
  OpenSpecFiles,
} from "./change-queue-sources.ts"
export type { ReconcileStartingResult, FindStartedFeature } from "./change-queue-reconcile.ts"
export type {
  ChangeQueueErrorCode,
  QueueEntryRecord,
  QueueSettings,
  QueueSnapshot,
  QueueStatusChange,
  QueueTransitionRecord,
  RemoveQueueEntryResult,
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
  RunStatus,
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

export { composeManagedRunners, routeNewDispatch, transportOfBinding } from "./runner-router.ts"
export type { RouteDecision } from "./runner-router.ts"

export { ActionHost, CapabilityDeniedError, realSleep } from "./action-host.ts"
export type { ActionHandler, ActionHostDeps, ActionHostExecuteResult } from "./action-host.ts"
export { bundledHandlers } from "./actions/bundled.ts"

export { realPluginProcessSpawner, realPortAllocator, realProcessRunner } from "./process.ts"
export { NATIVE_SESSION_CAPABILITIES, RunnerOperationError, sessionCapabilitiesOf, systemClock } from "./ports.ts"
export type {
  Clock,
  Logger,
  OperationObservation,
  OperationObservationStatus,
  OperationPurpose,
  PluginProcessExit,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessSpawner,
  PortAllocator,
  PrepareInput,
  PrepareResult,
  ProcessExecOptions,
  ProcessExecResult,
  ProcessRunner,
  RunnerOperationDelivery,
  SessionCapabilities,
  SessionClient,
  SessionStatus,
} from "./ports.ts"

export {
  createFakeReportingReadiness,
  createReportingReadiness,
  deriveOperationLogicalKey,
  isTerminalOperationPhase,
  operationKindForPurpose,
  operationPotentiallyDelivered,
  requiresFence,
} from "./runner-execution.ts"
export type {
  FenceRequest,
  ManagedReportingReadiness,
  ReportingReadinessPort,
  RunCredentialRecord,
  RunnerBindingRecord,
  RunnerCleanupState,
  RunnerFenceReasonCode,
  RunnerFenceRecord,
  RunnerOperationKind,
  RunnerOperationPhase,
  RunnerOperationRecord,
  RunnerSafetyStore,
  RunnerTransport,
  UncertainAnswerDisposition,
} from "./runner-execution.ts"

export {
  DEFAULT_ACP_DEADLINES,
  FORBIDDEN_INHERITED_ENV_NAMES,
  directoryWithinRoots,
  resolveAcpDeadlines,
  resolveAcpProfileForProject,
} from "./acp/config.ts"
export type {
  AcpDeadlines,
  AcpPermissionPolicy,
  AcpProfileConfig,
  AcpReportBridgeConfig,
  AcpRoleBinding,
  RunnersConfig,
} from "./acp/config.ts"
export {
  AcpSpawnValidationFailure,
  BoundedProcessSlots,
  realAcpProcessSpawner,
  validateAcpSpawn,
} from "./acp/process.ts"
export type {
  AcpProcessExit,
  AcpProcessHandle,
  AcpProcessSpawnOptions,
  AcpProcessSpawner,
  AcpSpawnValidationError,
} from "./acp/process.ts"

export {
  MAX_ACP_FRAME_BYTES,
  connectAcp,
  createLinkedStdioStreamPair,
  createLinkedStreamPair,
} from "./acp/connection.ts"
export type {
  AcpClientHandlers,
  AcpConnectOptions,
  AcpConnectionHandle,
  AcpInitializeOutcome,
} from "./acp/connection.ts"

export { ACP_SESSION_CAPABILITIES, ManagedSessions } from "./acp/sessions.ts"
export type { ManagedSessionsDeps } from "./acp/sessions.ts"

export {
  BoundedActivityLog,
  boundAndRedact,
  sanitizeStderrTail,
  summarizeSessionUpdate,
} from "./acp/diagnostics.ts"
export type { SessionActivitySummary } from "./acp/diagnostics.ts"

export {
  decidePermission,
  decidePermissionBounded,
  recordPermissionDecision,
} from "./acp/permissions.ts"
export type {
  PermissionDecision,
  PermissionDecisionContext,
  PermissionDecisionRecord,
} from "./acp/permissions.ts"

export { DEFAULT_CHANGE_QUEUE_INTERVAL_MS, Daemon, jsonLineLogger, systemIntervalScheduler } from "./daemon.ts"
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

export {
  constantTimeEquals,
  extractBearerToken,
  generateRunToken,
  hashRunToken,
  issueRunCredential,
  verifyRunCredential,
} from "./run-auth.ts"
export type { IssuedRunCredential, VerifyRunCredentialResult } from "./run-auth.ts"

export {
  decideAskDedup,
  isAlreadyConcludedMessage,
  ownRunStatusProjection,
  parseReportBody,
} from "./run-reporting.ts"
export type {
  AskDedupOutcome,
  AskDedupStore,
  OwnRunStatusProjection,
  ParsedReportBody,
} from "./run-reporting.ts"

export {
  createWorkerRoutes,
  handleWorkerReady,
  handleWorkerReport,
  handleWorkerStatus,
} from "./worker-routes.ts"
export type { WorkerRouteResult, WorkerRoutesDeps } from "./worker-routes.ts"

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
