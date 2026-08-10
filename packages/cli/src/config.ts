/**
 * Connection configuration for the CLI — explicit, never inferred.
 *
 * Precedence (highest → lowest): command-line flags, environment
 * variables (`CONDUCTOR_URL` / `CONDUCTOR_TOKEN`), then an optional
 * JSON config file (`{"url": ..., "token": ...}`) named by `--config`
 * or `CONDUCTOR_CONFIG`. There is NO default daemon address and no
 * default config-file path: the daemon binds an explicit host/port the
 * operator chose, and the CLI demands the same explicitness — a missing
 * address is a usage error, not a guess at a well-known port.
 */

import type { ApiConnection } from "./client.ts"

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export interface ConnectionInput {
  readonly flags: { readonly url?: string; readonly token?: string; readonly config?: string }
  readonly env: Readonly<Record<string, string | undefined>>
  readonly readFile: (path: string) => string
}

interface FileConfig {
  readonly url?: string
  readonly token?: string
}

function readConfigFile(path: string, readFile: (path: string) => string): FileConfig {
  let text: string
  try {
    text = readFile(path)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new UsageError(`cannot read config file "${path}": ${reason}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UsageError(`config file "${path}" is not valid JSON`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`config file "${path}" must be a JSON object`)
  }
  const { url, token } = parsed as Record<string, unknown>
  if (url !== undefined && typeof url !== "string") {
    throw new UsageError(`config file "${path}": "url" must be a string`)
  }
  if (token !== undefined && typeof token !== "string") {
    throw new UsageError(`config file "${path}": "token" must be a string`)
  }
  return {
    ...(url !== undefined ? { url } : {}),
    ...(token !== undefined ? { token } : {}),
  }
}

export function resolveConnection(input: ConnectionInput): ApiConnection {
  const configPath = input.flags.config ?? input.env["CONDUCTOR_CONFIG"]
  const file: FileConfig = configPath !== undefined ? readConfigFile(configPath, input.readFile) : {}
  const url = input.flags.url ?? input.env["CONDUCTOR_URL"] ?? file.url
  if (url === undefined || url.trim() === "") {
    throw new UsageError(
      "daemon address is required: pass --url, set CONDUCTOR_URL, or provide a config file (--config / CONDUCTOR_CONFIG)",
    )
  }
  const token = input.flags.token ?? input.env["CONDUCTOR_TOKEN"] ?? file.token
  return { url, ...(token !== undefined ? { token } : {}) }
}
