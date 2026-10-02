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
import { DEFAULT_CHANGE_QUEUE_INTERVAL_MS } from "@conductor/server"
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
  readonly notifications?: NotificationsFileConfig
}

const TOP_LEVEL_FIELDS = new Set([
  "databasePath",
  "createDatabaseDirectory",
  "projects",
  "bind",
  "auth",
  "heartbeatIntervalMs",
  "changeQueueIntervalMs",
  "engine",
  "actions",
  "plugins",
  "runners",
  "notifications",
])

const ENGINE_FIELDS = new Set(["runTtlMs", "idleSilenceNudgeMs", "busySilenceNudgeMs", "nudgeIdleCycles", "maxNudges", "healing"])
const HEALING_FIELDS = new Set(["initialMs", "maxMs", "attentionAfter", "classifyTimeoutMs"])
const NOTIFICATION_FIELDS = new Set(["publicBaseUrl", "rateLimitWindowMs", "intervalMs", "telegram"])
const TELEGRAM_FIELDS = new Set(["chatId", "tokenEnv", "events"])
const NOTIFICATION_EVENTS = new Set(["attention", "recovered", "escalated", "waiting_human", "done"])

/** Telegram channel as written in the file — the token is referenced by
 *  environment variable name only, resolved when the daemon starts. */
export interface TelegramFileConfig {
  readonly chatId: string
  readonly tokenEnv: string
  readonly events?: readonly string[]
}

export interface NotificationsFileConfig {
  readonly publicBaseUrl?: string
  readonly rateLimitWindowMs?: number
  readonly intervalMs?: number
  readonly telegram?: TelegramFileConfig
}
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

  const changeQueueIntervalMs = raw["changeQueueIntervalMs"] === undefined ? DEFAULT_CHANGE_QUEUE_INTERVAL_MS : raw["changeQueueIntervalMs"]
  if (typeof changeQueueIntervalMs !== "number" || !Number.isFinite(changeQueueIntervalMs) || changeQueueIntervalMs <= 0) {
    throw new UsageError('"changeQueueIntervalMs" must be a positive number')
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
      if (field === "healing") {
        engineTuning = { ...engineTuning, ...parseHealing(value) }
        continue
      }
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

  const notifications = raw["notifications"] === undefined ? undefined : parseNotifications(raw["notifications"])
  const runners = raw["runners"] === undefined ? undefined : parseRunners(raw["runners"])
  if (runners && apiAuth.mode !== "bearer") throw new UsageError('"runners" requires "auth.mode: bearer"')
  return {
    daemon: {
      ...(runners ? { runners } : {}),
      databasePath,
      projects: projects as string[],
      heartbeatIntervalMs,
      changeQueueIntervalMs,
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
    ...(notifications !== undefined ? { notifications } : {}),
  }
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new UsageError(`"${path}" must be a positive integer`)
  return value
}

function parseHealing(value: unknown): EngineOptions {
  if (!isObject(value)) throw new UsageError('"engine.healing" must be a mapping')
  for (const key of Object.keys(value)) {
    if (!HEALING_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "engine.healing.${key}"`)
  }
  const healing: { initialMs?: number; maxMs?: number; attentionAfter?: number } = {}
  if (value["initialMs"] !== undefined) healing.initialMs = positiveInteger(value["initialMs"], "engine.healing.initialMs")
  if (value["maxMs"] !== undefined) healing.maxMs = positiveInteger(value["maxMs"], "engine.healing.maxMs")
  if (value["attentionAfter"] !== undefined) healing.attentionAfter = positiveInteger(value["attentionAfter"], "engine.healing.attentionAfter")
  if (healing.initialMs !== undefined && healing.maxMs !== undefined && healing.maxMs < healing.initialMs) {
    throw new UsageError('"engine.healing.maxMs" must be ≥ "engine.healing.initialMs"')
  }
  return {
    healing,
    ...(value["classifyTimeoutMs"] !== undefined ? { fenceClassifyTimeoutMs: positiveInteger(value["classifyTimeoutMs"], "engine.healing.classifyTimeoutMs") } : {}),
  }
}

function parseNotifications(value: unknown): NotificationsFileConfig {
  if (!isObject(value)) throw new UsageError('"notifications" must be a mapping')
  for (const key of Object.keys(value)) {
    if (!NOTIFICATION_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "notifications.${key}"`)
  }
  const publicBaseUrl = value["publicBaseUrl"]
  if (publicBaseUrl !== undefined && (!isNonEmptyString(publicBaseUrl) || !/^https?:\/\//.test(publicBaseUrl))) {
    throw new UsageError('"notifications.publicBaseUrl" must be an http(s) URL')
  }
  let telegram: TelegramFileConfig | undefined
  const rawTelegram = value["telegram"]
  if (rawTelegram !== undefined) {
    if (!isObject(rawTelegram)) throw new UsageError('"notifications.telegram" must be a mapping')
    for (const key of Object.keys(rawTelegram)) {
      if (key === "token" || key === "botToken") {
        throw new UsageError('"notifications.telegram" must not contain the bot token — set "tokenEnv" to the name of an environment variable holding it')
      }
      if (!TELEGRAM_FIELDS.has(key)) throw new UsageError(`unknown daemon config field "notifications.telegram.${key}"`)
    }
    const chatId = rawTelegram["chatId"]
    const chat = typeof chatId === "number" && Number.isSafeInteger(chatId) ? String(chatId) : chatId
    if (!isNonEmptyString(chat)) throw new UsageError('"notifications.telegram.chatId" is required (the numeric chat id or @channel)')
    const tokenEnv = rawTelegram["tokenEnv"] ?? "CONDUCTOR_TELEGRAM_BOT_TOKEN"
    if (!isNonEmptyString(tokenEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
      throw new UsageError('"notifications.telegram.tokenEnv" must be an environment variable name')
    }
    const events = rawTelegram["events"]
    if (events !== undefined && (!Array.isArray(events) || events.length === 0 || !events.every(event => isString(event) && NOTIFICATION_EVENTS.has(event)))) {
      throw new UsageError(`"notifications.telegram.events" must be a non-empty list of: ${[...NOTIFICATION_EVENTS].join(", ")}`)
    }
    telegram = { chatId: chat, tokenEnv, ...(events !== undefined ? { events: events as string[] } : {}) }
  }
  return {
    ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
    ...(value["rateLimitWindowMs"] !== undefined ? { rateLimitWindowMs: positiveInteger(value["rateLimitWindowMs"], "notifications.rateLimitWindowMs") } : {}),
    ...(value["intervalMs"] !== undefined ? { intervalMs: positiveInteger(value["intervalMs"], "notifications.intervalMs") } : {}),
    ...(telegram !== undefined ? { telegram } : {}),
  }
}

/** Resolve secrets referenced by the notifications section into the
 *  daemon's runtime config. A configured channel whose secret is missing
 *  is a startup error naming the variable — never a silently dead channel. */
export function resolveNotifications(
  file: NotificationsFileConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
): import("@conductor/server").NotificationsConfig | undefined {
  if (file === undefined) return undefined
  let telegram: NonNullable<import("@conductor/server").NotificationsConfig["telegram"]> | undefined
  if (file.telegram) {
    const token = env[file.telegram.tokenEnv]
    if (token === undefined || token.trim() === "") {
      throw new UsageError(`notifications.telegram is configured but environment variable ${file.telegram.tokenEnv} (the bot token) is not set`)
    }
    telegram = {
      chatId: file.telegram.chatId,
      token: token.trim(),
      ...(file.telegram.events !== undefined ? { events: file.telegram.events as import("@conductor/server").NotificationKind[] } : {}),
    }
  }
  return {
    ...(file.publicBaseUrl !== undefined ? { publicBaseUrl: file.publicBaseUrl } : {}),
    ...(file.rateLimitWindowMs !== undefined ? { rateLimitWindowMs: file.rateLimitWindowMs } : {}),
    ...(file.intervalMs !== undefined ? { intervalMs: file.intervalMs } : {}),
    ...(telegram !== undefined ? { telegram } : {}),
  }
}

function parseRunners(value: unknown): import("@conductor/server").RunnersConfig {
  const object = (v: unknown, path: string, fields?: readonly string[]): YamlObject => {
    if (!isObject(v)) throw new UsageError(`"${path}" must be a mapping`)
    for (const key of Object.keys(v)) if (fields && !fields.includes(key)) throw new UsageError(`unknown field "${path}.${key}"`)
    return v
  }
  const text = (v: unknown, path: string, absolute = false): string => {
    if (!isNonEmptyString(v) || v.includes("\u0000") || (absolute && !isAbsolute(v))) throw new UsageError(`"${path}" requires ${absolute ? "an absolute path" : "a non-empty string"}`)
    return v
  }
  const strings = (v: unknown, path: string, absolute = false): string[] => {
    if (!Array.isArray(v)) throw new UsageError(`"${path}" must be an array`)
    return v.map(item => text(item, path, absolute))
  }
  const forbidden = (key: string) => key.startsWith("CONDUCTOR_")
  const root = object(value, "runners", ["default", "projects", "acp", "reportBridge"])
  if (root.default !== "native") throw new UsageError('"runners.default" must be native')
  const acp: Record<string, import("@conductor/server").AcpProfileConfig> = {}
  for (const [id, raw] of Object.entries(object(root.acp, "runners.acp"))) {
    const path = `runners.acp.${id}`
    const p = object(raw, path, ["command", "args", "allowedRoots", "env", "inheritEnv", "maxConcurrent", "deadlines", "permissions", "bindings"])
    const args = strings(p.args, `${path}.args`)
    if (args.some(arg => arg.includes("{directory}") && arg !== "{directory}")) throw new UsageError(`"${path}.args" supports only whole-element {directory}`)
    const allowedRoots = strings(p.allowedRoots, `${path}.allowedRoots`, true)
    if (!allowedRoots.length) throw new UsageError(`"${path}.allowedRoots" must not be empty`)
    const env: Record<string, string> = {}
    for (const [key, val] of Object.entries(object(p.env ?? {}, `${path}.env`))) {
      if (forbidden(key)) throw new UsageError(`forbidden environment field "${path}.env.${key}"`)
      env[key] = text(val, `${path}.env.${key}`)
    }
    const inheritEnv = strings(p.inheritEnv ?? [], `${path}.inheritEnv`)
    if (inheritEnv.some(forbidden)) throw new UsageError(`forbidden field "${path}.inheritEnv"`)
    const maxConcurrent = p.maxConcurrent
    if (typeof maxConcurrent !== "number" || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new UsageError(`"${path}.maxConcurrent" must be a positive integer`)
    const deadlines: Partial<import("@conductor/server").AcpDeadlines> = {}
    for (const [key, val] of Object.entries(object(p.deadlines ?? {}, `${path}.deadlines`, ["startupMs", "writeMs", "turnMs", "cancelMs", "killMs"]))) {
      if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 1 || val > 2147483647) throw new UsageError(`"${path}.deadlines.${key}" must be a positive bounded integer`)
      Object.assign(deadlines, { [key]: val })
    }
    const permissions = object(p.permissions ?? { allowKinds: [] }, `${path}.permissions`, ["allowKinds"])
    const bindings: Record<string, import("@conductor/server").AcpRoleBinding> = {}
    for (const [agent, rawBinding] of Object.entries(object(p.bindings, `${path}.bindings`))) {
      const b = object(rawBinding, `${path}.bindings.${agent}`, ["mode", "configOptions"])
      const configOptions: Record<string, string> = {}
      for (const [key, val] of Object.entries(object(b.configOptions ?? {}, `${path}.bindings.${agent}.configOptions`))) configOptions[key] = text(val, `${path}.bindings.${agent}.configOptions.${key}`)
      bindings[agent] = { mode: text(b.mode, `${path}.bindings.${agent}.mode`), configOptions }
    }
    acp[id] = { command: text(p.command, `${path}.command`, true), args, allowedRoots, env, inheritEnv, maxConcurrent, deadlines, permissions: { allowKinds: strings(permissions.allowKinds, `${path}.permissions.allowKinds`) }, bindings }
  }
  const projects: Record<string, string> = {}
  for (const [project, profile] of Object.entries(object(root.projects, "runners.projects"))) {
    text(project, "runners.projects", true)
    const id = text(profile, `runners.projects.${project}`)
    if (!Object.hasOwn(acp, id)) throw new UsageError(`"runners.projects.${project}" references unknown profile`)
    projects[project] = id
  }
  const bridge = object(root.reportBridge, "runners.reportBridge", ["command", "args"])
  return { default: "native", projects, acp, reportBridge: { command: text(bridge.command, "runners.reportBridge.command", true), args: strings(bridge.args, "runners.reportBridge.args") } }
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

# Optional engine tuning (runTtlMs, idleSilenceNudgeMs, busySilenceNudgeMs,
# nudgeIdleCycles, maxNudges) — see docs/install.md#engine-tuning.
# engine:
#   runTtlMs: 3600000
#   idleSilenceNudgeMs: 120000
#   busySilenceNudgeMs: 600000
#   # Self-healing of uncertain agent runs (lost session/new, lost prompt
#   # on a replaySafe step): exponential backoff from initialMs to maxMs,
#   # forever; "attention" after attentionAfter consecutive failures.
#   healing:
#     initialMs: 60000
#     maxMs: 1800000
#     attentionAfter: 3

# Optional push notifications (attention, recovered, escalated,
# waiting_human, done). The bot token is read from the environment
# variable named by tokenEnv — never written in this file.
# notifications:
#   publicBaseUrl: https://conductor.example.com
#   telegram:
#     chatId: "-1001234567890"
#     tokenEnv: CONDUCTOR_TELEGRAM_BOT_TOKEN
#     # events: [attention, recovered, escalated, waiting_human, done]

# Optional local action registry paths. In a compiled binary the bundled
# action manifests are not on disk: point "bundledPath" at a checkout's
# packages/server/actions directory to restore "action:" steps.
# actions:
#   bundledPath: /path/to/conductor/packages/server/actions
#   localPaths:
#     - /path/to/team/actions

# Optional ACP execution (native remains default). Requires auth.mode: bearer.
# Operator-installed executable/profile; no provider, model or gateway default.
# Permission callbacks are NOT an OS sandbox. Use an isolated OS account/container.
# runners:
#   default: native
#   projects: { /path/to/my-project: opencode-acp }
#   acp:
#     opencode-acp:
#       command: /opt/opencode/bin/opencode
#       args: [acp, --cwd, "{directory}"]
#       allowedRoots: [/path/to/my-project, /path/to/worktrees]
#       env: {HOME: /srv/agent-home, XDG_CONFIG_HOME: /srv/agent-config}
#       inheritEnv: [PATH]
#       maxConcurrent: 2
#       deadlines: {startupMs: 30000, writeMs: 5000, turnMs: 3600000, cancelMs: 5000, killMs: 2000}
#       permissions: {allowKinds: []}
#       bindings: {build: {mode: build}}
#   reportBridge:
#     command: /opt/conductor/conductor
#     args: [report-mcp]
#     # Source checkout: command: /absolute/path/to/bun
#     # args: [/absolute/checkout/packages/cli/src/main.ts, report-mcp]

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
