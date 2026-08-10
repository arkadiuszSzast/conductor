/**
 * Adapter connection configuration — explicit, never inferred, matching
 * the CLI's precedent: there is NO default daemon address, no default
 * callback bind and no implicit auth mode. Everything comes from the
 * environment (the one process-wide input every plugin instance shares,
 * so no instance's view depends on registration order):
 *
 *   CONDUCTOR_URL           daemon API base URL (required)
 *   CONDUCTOR_TOKEN         bearer token for the daemon API (optional —
 *                           matches the daemon's `auth.mode`)
 *   CONDUCTOR_RUNNER_HOST   callback listen host (required; loopback is
 *                           a written-down operator decision)
 *   CONDUCTOR_RUNNER_PORT   callback listen port (optional; 0/absent =
 *                           ephemeral — the actual port is discovered
 *                           from the listener and reported to the daemon)
 *   CONDUCTOR_RUNNER_AUTH   "none" — the explicit opt-out, or
 *   CONDUCTOR_RUNNER_TOKEN  bearer token the daemon must present on
 *                           callback requests (exactly one of the two)
 */

export type RunnerCallbackAuth = { readonly mode: "none" } | { readonly mode: "bearer"; readonly token: string }

export interface RunnerConfig {
  readonly daemonUrl: string
  readonly daemonToken?: string
  readonly callbackHost: string
  readonly callbackPort: number
  readonly callbackAuth: RunnerCallbackAuth
}

export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunnerConfigError"
  }
}

export function resolveRunnerConfig(env: Readonly<Record<string, string | undefined>>): RunnerConfig {
  const daemonUrl = env["CONDUCTOR_URL"]
  if (daemonUrl === undefined || daemonUrl.trim() === "") {
    throw new RunnerConfigError("CONDUCTOR_URL is required: the daemon address is explicit configuration, never a guess")
  }
  let parsed: URL
  try {
    parsed = new URL(daemonUrl)
  } catch {
    throw new RunnerConfigError(`CONDUCTOR_URL "${daemonUrl}" is not a valid URL (expected e.g. http://<host>:<port>)`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RunnerConfigError(`CONDUCTOR_URL "${daemonUrl}" must use http or https`)
  }

  const callbackHost = env["CONDUCTOR_RUNNER_HOST"]
  if (callbackHost === undefined || callbackHost.trim() === "") {
    throw new RunnerConfigError(
      "CONDUCTOR_RUNNER_HOST is required: the callback bind is explicit even for localhost (e.g. 127.0.0.1)",
    )
  }

  const portText = env["CONDUCTOR_RUNNER_PORT"]
  let callbackPort = 0
  if (portText !== undefined && portText.trim() !== "") {
    callbackPort = Number(portText)
    if (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65535) {
      throw new RunnerConfigError(`CONDUCTOR_RUNNER_PORT "${portText}" must be an integer between 0 and 65535`)
    }
  }

  const authMode = env["CONDUCTOR_RUNNER_AUTH"]
  const callbackToken = env["CONDUCTOR_RUNNER_TOKEN"]
  if (authMode !== undefined && authMode !== "none") {
    throw new RunnerConfigError(`CONDUCTOR_RUNNER_AUTH "${authMode}" is not supported (only "none"; use CONDUCTOR_RUNNER_TOKEN for bearer auth)`)
  }
  if (authMode === "none" && callbackToken !== undefined) {
    throw new RunnerConfigError("CONDUCTOR_RUNNER_AUTH=none and CONDUCTOR_RUNNER_TOKEN are mutually exclusive")
  }
  if (authMode === undefined && (callbackToken === undefined || callbackToken.trim() === "")) {
    throw new RunnerConfigError(
      "callback auth is required: set CONDUCTOR_RUNNER_TOKEN (bearer) or CONDUCTOR_RUNNER_AUTH=none (the explicit opt-out)",
    )
  }

  const daemonToken = env["CONDUCTOR_TOKEN"]
  return {
    daemonUrl: daemonUrl.replace(/\/+$/, ""),
    ...(daemonToken !== undefined && daemonToken !== "" ? { daemonToken } : {}),
    callbackHost,
    callbackPort,
    callbackAuth: authMode === "none" ? { mode: "none" } : { mode: "bearer", token: callbackToken! },
  }
}
