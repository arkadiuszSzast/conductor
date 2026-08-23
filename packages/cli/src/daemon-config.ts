/**
 * Daemon configuration file → `DaemonConfig` + `ApiConfig`.
 *
 * Pure functions over the YAML text: the file is the single source of
 * truth for the daemon's settings. There are NO defaults for paths, bind
 * or auth — a missing field is a usage error with the field named, never
 * a guess at a well-known port or a home directory. Validation is strict:
 * unknown fields are rejected alongside missing/malformed ones, so a
 * typo surfaces instead of silently configuring nothing.
 *
 * The YAML document is parsed with `parseYamlObject` from `@conductor/core`
 * (the core-owned `yaml` dependency — the CLI adds none of its own).
 */

import { isAbsolute } from "node:path"
import { parseYamlObject, stringifyYamlObject } from "@conductor/core"
import type { ApiAuth, ApiConfig, DaemonConfig } from "@conductor/server"
import type { EngineOptions } from "@conductor/server"
import { UsageError } from "./errors.ts"

/** `heartbeatIntervalMs` when the file omits it. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000

/** Resolved `plugins` section — always present with defaults applied
 *  (omitted section → enabled, no extras), never partial. */
export interface PluginsFileConfig {
  readonly enabled: boolean
  readonly disabled: readonly string[]
  readonly paths: readonly string[]
}

export interface DaemonFileConfig {
  readonly daemon: DaemonConfig
  readonly api: ApiConfig
  readonly plugins: PluginsFileConfig
}

const TOP_LEVEL_FIELDS = new Set([
  "databasePath",
  "createDatabaseDirectory",
  "projects",
  "bind",
  "auth",
  "heartbeatIntervalMs",
  "engine",
  "actions",
  "plugins",
])

const ENGINE_FIELDS = new Set(["runTtlMs", "nudgeIdleCycles", "maxNudges"])
const ACTIONS_FIELDS = new Set(["bundledPath", "localPaths"])
const BIND_FIELDS = new Set(["host", "port"])
const AUTH_FIELDS = new Set(["mode", "token"])
const PLUGINS_FIELDS = new Set(["enabled", "disabled", "paths"])
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface YamlObject {
  readonly [key: string]: unknown
}

function isObject(value: unknown): value is YamlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim() !== ""
}

/** Assemble `DaemonConfig` + `ApiConfig` from a validated YAML object. */
export function assembleDaemonConfig(raw: unknown): DaemonFileConfig {
  if (!isObject(raw)) throw new UsageError("daemon config must be a YAML mapping (a top-level object)")

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "${key}"`)
  }

  const databasePath = raw["databasePath"]
  if (!isNonEmptyString(databasePath)) {
    throw new UsageError('daemon config requires "databasePath" (non-empty string, e.g. /var/lib/conductor/conductor.db)')
  }

  const projects = raw["projects"]
  if (!Array.isArray(projects) || !projects.every(isNonEmptyString)) {
    throw new UsageError('daemon config requires "projects" (array of project directory strings; may be empty)')
  }

  const bind = raw["bind"]
  if (!isObject(bind)) throw new UsageError('daemon config requires "bind" (mapping with host and port)')
  for (const key of Object.keys(bind)) {
    if (!BIND_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "bind.${key}"`)
  }
  const host = bind["host"]
  if (!isNonEmptyString(host)) throw new UsageError('"bind.host" is required (e.g. 127.0.0.1)')
  const port = bind["port"]
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError('"bind.port" must be an integer between 1 and 65535')
  }

  const auth = raw["auth"]
  if (!isObject(auth)) throw new UsageError('daemon config requires "auth" (mapping with mode)')
  for (const key of Object.keys(auth)) {
    if (!AUTH_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "auth.${key}"`)
  }
  const authMode = auth["mode"]
  const authToken = auth["token"]
  let apiAuth: ApiAuth
  if (authMode === "none") {
    if (authToken !== undefined) throw new UsageError('"auth.token" is only valid when "auth.mode" is "bearer"')
    apiAuth = { mode: "none" }
  } else if (authMode === "bearer") {
    if (!isNonEmptyString(authToken)) {
      throw new UsageError('"auth.mode: bearer" requires a non-empty "auth.token"')
    }
    apiAuth = { mode: "bearer", token: authToken }
  } else {
    throw new UsageError('"auth.mode" must be "none" or "bearer"')
  }

  const createDatabaseDirectory = raw["createDatabaseDirectory"]
  if (createDatabaseDirectory !== undefined && typeof createDatabaseDirectory !== "boolean") {
    throw new UsageError('"createDatabaseDirectory" must be a boolean')
  }

  const heartbeatIntervalMs = raw["heartbeatIntervalMs"] ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  if (typeof heartbeatIntervalMs !== "number" || !Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new UsageError('"heartbeatIntervalMs" must be a positive number')
  }

  const engine = raw["engine"]
  let engineTuning: EngineOptions | undefined
  if (engine !== undefined) {
    if (!isObject(engine)) throw new UsageError('"engine" must be a mapping')
    for (const key of Object.keys(engine)) {
      if (!ENGINE_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "engine.${key}"`)
    }
    engineTuning = {}
    for (const field of ENGINE_FIELDS) {
      const value = engine[field]
      if (value === undefined) continue
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new UsageError(`"engine.${field}" must be a positive number`)
      }
      // Cycle/nudge counters are compared as whole cycles in the engine —
      // a fractional count is a config mistake, not a tunable.
      if (field !== "runTtlMs" && !Number.isInteger(value)) {
        throw new UsageError(`"engine.${field}" must be a positive integer`)
      }
      engineTuning = { ...engineTuning, [field]: value }
    }
  }

  const actions = raw["actions"]
  let actionsConfig: DaemonConfig["actions"]
  if (actions !== undefined) {
    if (!isObject(actions)) throw new UsageError('"actions" must be a mapping')
    for (const key of Object.keys(actions)) {
      if (!ACTIONS_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "actions.${key}"`)
    }
    const bundledPath = actions["bundledPath"]
    if (bundledPath !== undefined && !isNonEmptyString(bundledPath)) {
      throw new UsageError('"actions.bundledPath" must be a non-empty string')
    }
    const localPaths = actions["localPaths"]
    if (localPaths !== undefined && (!Array.isArray(localPaths) || !localPaths.every(isNonEmptyString))) {
      throw new UsageError('"actions.localPaths" must be an array of non-empty path strings')
    }
    actionsConfig = {
      ...(bundledPath !== undefined ? { bundledPath } : {}),
      ...(localPaths !== undefined ? { localPaths } : {}),
    }
  }

  const pluginsRaw = raw["plugins"]
  let pluginsEnabled = true
  let pluginsDisabled: string[] = []
  let pluginsPaths: string[] = []
  if (pluginsRaw !== undefined) {
    if (!isObject(pluginsRaw)) throw new UsageError('"plugins" must be a mapping')
    for (const key of Object.keys(pluginsRaw)) {
      if (!PLUGINS_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "plugins.${key}"`)
    }
    const enabled = pluginsRaw["enabled"]
    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") throw new UsageError('"plugins.enabled" must be a boolean')
      pluginsEnabled = enabled
    }
    const disabled = pluginsRaw["disabled"]
    if (disabled !== undefined) {
      if (!Array.isArray(disabled) || !disabled.every(id => isString(id) && PLUGIN_ID_PATTERN.test(id))) {
        throw new UsageError('"plugins.disabled" must be an array of kebab-case plugin ids (e.g. "openspec")')
      }
      pluginsDisabled = disabled as string[]
    }
    const paths = pluginsRaw["paths"]
    if (paths !== undefined) {
      if (!Array.isArray(paths) || !paths.every(isNonEmptyString)) {
        throw new UsageError('"plugins.paths" must be an array of absolute path strings')
      }
      const relative = paths.find(path => !isAbsolute(path))
      if (relative !== undefined) {
        throw new UsageError(`"plugins.paths" must be absolute paths — got relative path "${relative}"`)
      }
      pluginsPaths = paths as string[]
    }
  }

  return {
    daemon: {
      databasePath,
      projects: projects as string[],
      heartbeatIntervalMs,
      createDatabaseDirectory: createDatabaseDirectory ?? true,
      ...(engineTuning !== undefined ? { engine: engineTuning } : {}),
      ...(actionsConfig !== undefined ? { actions: actionsConfig } : {}),
    },
    api: {
      bind: { host: host!, port },
      auth: apiAuth,
    },
    plugins: {
      enabled: pluginsEnabled,
      disabled: pluginsDisabled,
      paths: pluginsPaths,
    },
  }
}

/** Parse the daemon config file text into the daemon + api config pair. */
export function loadDaemonConfig(source: string): DaemonFileConfig {
  const parsed = parseYamlObject(source)
  if (!parsed.ok) {
    const detail = parsed.errors.map(error => `line ${error.line}: ${error.message}`).join("; ")
    throw new UsageError(`daemon config is not valid YAML: ${detail}`)
  }
  return assembleDaemonConfig(parsed.value)
}

/** The example config written by `conductor daemon --init-config`. */
export const DAEMON_CONFIG_TEMPLATE = `# Example Conductor daemon configuration. Every field is explicit —
# there are no default paths, ports or auth modes. Adjust before starting
# the daemon with: conductor daemon --config <this file>

# SQLite database file. The parent directory is created when missing.
databasePath: /var/lib/conductor/conductor.db
createDatabaseDirectory: true

# Project directories to register at startup. Each must contain a
# conductor.yaml workflow. Invalid projects get diagnostics and do not
# block the daemon.
projects:
  - /path/to/my-project

# HTTP API listener. Explicit, never defaulted.
bind:
  host: 127.0.0.1
  port: 4400

# Authentication. "none" opens the API (a startup warning is logged);
# "bearer" requires a non-empty token.
auth:
  mode: none
  # mode: bearer
  # token: "change-me"

# Reconciler heartbeat interval in milliseconds (default: 5000).
heartbeatIntervalMs: 5000

# Optional engine tuning (runTtlMs, nudgeIdleCycles, maxNudges).
# engine:
#   runTtlMs: 3600000

# Optional local action registry paths. In a compiled binary the bundled
# action manifests are not on disk: point "bundledPath" at a checkout's
# packages/server/actions directory to restore "action:" steps.
# actions:
#   bundledPath: /path/to/conductor/packages/server/actions
#   localPaths:
#     - /path/to/team/actions

# Optional plugin subsystem config. Global plugins are discovered under
# the platform config directory's "plugins" subdirectory; "paths" adds
# extra absolute search roots. Omitted entirely -> enabled, no extras.
# plugins:
#   enabled: true
#   disabled:
#     - some-plugin-id
#   paths:
#     - /path/to/extra/plugins
`

export interface PlatformPaths {
  /** Default daemon config file, e.g. `~/.config/conductor/daemon.yaml`. */
  readonly configPath: string
  /** Default data directory, e.g. `~/.local/share/conductor`. */
  readonly dataDir: string
  /** Global plugin search root, e.g. `~/.config/conductor/plugins` — always
   *  the platform config directory's `plugins` subdirectory, independent
   *  of an explicit `--config` path pointing elsewhere. */
  readonly pluginsDir: string
}

/**
 * Platform-convention locations (XDG base directories with the
 * conventional `~` fallbacks) — the ONLY places a default may come from.
 * Nothing is ever derived from the package location or the cwd.
 */
export function platformPaths(env: Readonly<Record<string, string | undefined>>): PlatformPaths {
  const configHome = firstNonEmpty(env["XDG_CONFIG_HOME"]) ?? joinHome(env, ".config")
  const dataHome = firstNonEmpty(env["XDG_DATA_HOME"]) ?? joinHome(env, ".local/share")
  return {
    configPath: `${configHome}/conductor/daemon.yaml`,
    dataDir: `${dataHome}/conductor`,
    pluginsDir: `${configHome}/conductor/plugins`,
  }
}

function firstNonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined
}

function joinHome(env: Readonly<Record<string, string | undefined>>, suffix: string): string {
  const home = firstNonEmpty(env["HOME"])
  if (home === undefined) {
    throw new UsageError(
      "cannot resolve a default config location: neither XDG_CONFIG_HOME/XDG_DATA_HOME nor HOME is set — pass --config <path>",
    )
  }
  return `${home}/${suffix}`
}

/** The generated zero-flag default config: loopback bind, XDG data-dir database, open auth (warned), no projects. */
export function defaultDaemonConfig(paths: PlatformPaths): string {
  return `# Conductor daemon configuration — generated by \`conductor daemon\` on first run.
# Every value can be edited; restart the daemon to apply. Docs: docs/install.md

databasePath: ${paths.dataDir}/conductor.db
createDatabaseDirectory: true

# Projects driven by this daemon. \`conductor init\` adds entries here.
projects: []

bind:
  host: 127.0.0.1
  port: 4400

# Open API on loopback. For anything beyond local use switch to:
#   auth: { mode: bearer, token: "<secret>" }
auth:
  mode: none

heartbeatIntervalMs: 5000
`
}

export type AddProjectResult =
  | { readonly changed: true; readonly source: string }
  | { readonly changed: false }

/**
 * Add a project directory to a daemon config's `projects` list —
 * idempotent, validation-first (a malformed file aborts loudly before
 * any write decision). Returns the new YAML text; comments are not
 * preserved (the file is machine-generated; hand-crafted configs are
 * used via explicit `--config` and never touched by this path).
 */
export function addProjectToConfig(source: string, projectDir: string): AddProjectResult {
  const parsed = parseYamlObject(source)
  if (!parsed.ok) {
    const detail = parsed.errors.map(error => `line ${error.line}: ${error.message}`).join("; ")
    throw new UsageError(`daemon config is not valid YAML: ${detail}`)
  }
  assembleDaemonConfig(parsed.value)
  const raw = parsed.value as { projects?: readonly string[] }
  const projects = raw.projects ?? []
  if (projects.includes(projectDir)) return { changed: false }
  const next = { ...raw, projects: [...projects, projectDir] }
  return { changed: true, source: stringifyYamlObject(next) }
}
