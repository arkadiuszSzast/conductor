export const name = "@conductor/runner-opencode" as const

export { resolveRunnerConfig, RunnerConfigError } from "./config.ts"
export type { RunnerCallbackAuth, RunnerConfig } from "./config.ts"

export { createOpencodeSessions } from "./sessions.ts"
export type { RawOpencodeSessionApi } from "./sessions.ts"

export { OpencodeRunnerHub, bunListen } from "./hub.ts"
export type {
  CallbackHandler,
  CallbackListener,
  DaemonFetch,
  ListenFn,
  RunnerHubDeps,
} from "./hub.ts"

export { createConductorTools } from "./tools.ts"
export type {
  ConductorToolContext,
  ConductorTools,
  GateArgs,
  ReportArgs,
  StartArgs,
} from "./tools.ts"

export { ConductorRunnerPlugin } from "./plugin.ts"
export { default } from "./plugin.ts"
