export const name = "@conductor/cli" as const

export { ApiClient, ApiError } from "./client.ts"
export type {
  ActiveRun,
  ApiConnection,
  CommandResult,
  FeaturePayload,
  FeatureView,
  FetchLike,
  FindingView,
  ReportInput,
  ReportResult,
  RunDetail,
  RunSummary,
  StartFeatureInput,
  TransitionView,
} from "./client.ts"

export { resolveConnection, UsageError } from "./config.ts"
export type { ConnectionInput } from "./config.ts"

export { runCli, EXIT } from "./cli.ts"
export type { CliDeps, DaemonProcessHandle, DaemonStartInput } from "./cli.ts"

export {
  DAEMON_CONFIG_TEMPLATE,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  assembleDaemonConfig,
  loadDaemonConfig,
} from "./daemon-config.ts"
export type { DaemonFileConfig } from "./daemon-config.ts"
