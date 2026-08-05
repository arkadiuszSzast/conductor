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
