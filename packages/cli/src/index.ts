export const name = "@conductor/cli" as const

export { ApiClient, ApiError } from "./client.ts"
export type {
  ActiveRun,
  ApiConnection,
  CommandResult,
  FeaturePayload,
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
export type { CliDeps } from "./cli.ts"
