/**
 * The `conductor` CLI — a thin client of the daemon's HTTP API v1.
 *
 * Every command maps 1:1 onto an API operation and routes through the
 * same engine methods every other client uses; the CLI holds NO
 * pipeline logic (spec: "CLI and API yield the same state transition").
 * `init` is the one local command: it scaffolds the project config file
 * the daemon loads today and never talks to the network.
 *
 * All effects are injectable (`CliDeps`) so tests drive the CLI against
 * the API's socketless handler with an in-memory filesystem boundary.
 * Exit codes are stable for scripting:
 *   0 success
 *   1 generic/internal failure
 *   2 usage error (bad flags, missing daemon address)
 *   3 unauthorized
 *   4 not found (unknown feature/run/route)
 *   5 conflict (wrong gate state, terminal feature)
 *   6 duplicate report (`run_already_concluded`)
 *   7 daemon unreachable
 */

import { ApiClient, ApiError, type FetchLike, type TransitionView } from "./client.ts"
import { resolveConnection, UsageError } from "./config.ts"
import type { ApiConfig, DaemonConfig, DaemonLogEntry } from "@conductor/server"
import { DAEMON_CONFIG_TEMPLATE, addProjectToConfig, defaultDaemonConfig, loadDaemonConfig, platformPaths } from "./daemon-config.ts"

/** Input for the `startDaemon` port — one assembled daemon + api config. */
export interface DaemonStartInput {
  readonly daemon: DaemonConfig
  readonly api: ApiConfig
  /**
   * Disable web-UI serving. The UI is a property of the artifact
   * (embedded in the binary, or the checkout's built SPA) — never user
   * configuration; this flag is the only knob.
   */
  readonly noUi: boolean
  /** Structured JSON log lines, `jsonLineLogger` shape. */
  readonly log: (entry: DaemonLogEntry) => void
}

export interface DaemonProcessHandle {
  /** Resolves once the daemon is ready; rejects on startup failure. */
  readonly started: Promise<void>
  /** Resolves with the process exit code once the daemon has stopped. */
  readonly exited: Promise<number>
}

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
  readonly readFile: (path: string) => string
  readonly writeFile: (path: string, content: string) => void
  readonly exists: (path: string) => boolean
  readonly mkdir: (path: string) => void
  readonly cwd: () => string
  readonly fetchImpl?: FetchLike
  /**
   * Owns the real process for `conductor daemon`: instantiates `Daemon`,
   * binds the API (`Bun.serve`), wires SIGINT/SIGTERM to a graceful stop
   * and resolves `exited` with the exit code. Only `main.ts` provides the
   * real implementation; tests inject a fake to drive the command without
   * a socket. Optional so client-only harnesses need no daemon stub —
   * the daemon command fails cleanly when absent.
   */
  readonly startDaemon?: (input: DaemonStartInput) => DaemonProcessHandle
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unauthorized: 3,
  notFound: 4,
  conflict: 5,
  duplicateReport: 6,
  unreachable: 7,
} as const

const USAGE = `usage: conductor [--url <url>] [--token <token>] [--config <path>] [--json] <command> [args]

connection (for every command except init and daemon):
  --url <url>          daemon API base URL (env: CONDUCTOR_URL)
  --token <token>      bearer token (env: CONDUCTOR_TOKEN)
  --config <path>      JSON config file {"url", "token"} (env: CONDUCTOR_CONFIG)
                       fallback when all are absent: the local daemon's
                       platform config supplies the address and token
  --json               print raw API JSON on stdout

commands:
  init [--dir <path>] [--force] [--no-register]
                       scaffold <dir>/conductor.yaml (default: cwd) and
                       register the project with the local daemon
                       (--no-register: scaffold only)
  daemon [--config <path>] [--no-ui]
                       run the daemon; without --config uses (and generates
                       on first run) the platform config at
                       $XDG_CONFIG_HOME/conductor/daemon.yaml
                       (~/.config/conductor/daemon.yaml); the web UI ships
                       inside the artifact and serves automatically
                       (--no-ui disables it); env CONDUCTOR_BIND_HOST /
                       CONDUCTOR_BIND_PORT override the config's bind
  daemon --init-config <path> [--force]
                       write an example daemon config and exit
  start <title> [--project <dir>] [--description <text>] [--workflow <name>] [--pr <n>]
                       create a feature and start its pipeline
                       (--project defaults to the current directory)
  status [<feature-id>] [--project <dir>] [--active]
                       show one feature, or list features
  approve <feature-id> [--notes <text|@file>]
                       approve the waiting human gate
  request-changes <feature-id> --notes <text|@file>
                       reject the waiting human gate with notes
  report <run-id> (--outcome succeeded|failed | --verdict <verdict>) [--notes <text|@file>]
                       report an agent run's result to the daemon
  answer <run-id> --notes <text|@file>
                       answer a run's pending question (interactive step)
  pause <feature-id>   pause the feature
  resume <feature-id>  resume a paused feature
  abandon <feature-id> abandon the feature
  logs <feature-id>    print the feature's transition timeline

exit codes: 0 ok, 1 failure, 2 usage, 3 unauthorized, 4 not found,
            5 conflict, 6 duplicate report, 7 daemon unreachable`

const BOOLEAN_FLAGS = new Set(["json", "active", "force", "help", "no-register", "no-ui"])

const VALUE_FLAGS = new Set([
  "url",
  "token",
  "config",
  "dir",
  "project",
  "description",
  "workflow",
  "pr",
  "notes",
  "outcome",
  "verdict",
  "init-config",
])

interface Parsed {
  readonly command: string | null
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

function parseArgs(argv: readonly string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  let command: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith("--")) {
      const eq = token.indexOf("=")
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq !== -1) throw new UsageError(`flag --${name} does not take a value`)
        flags.set(name, true)
        continue
      }
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`)
      const value = eq === -1 ? argv[++i] : token.slice(eq + 1)
      if (value === undefined) throw new UsageError(`flag --${name} requires a value`)
      flags.set(name, value)
      continue
    }
    if (command === null) command = token
    else positionals.push(token)
  }
  return { command, positionals, flags }
}

function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === "string" ? value : undefined
}

function requireFlags(parsed: Parsed, allowed: readonly string[]): void {
  const permitted = new Set([...allowed, "url", "token", "config", "json", "help"])
  for (const name of parsed.flags.keys()) {
    if (!permitted.has(name)) throw new UsageError(`flag --${name} is not valid for "${parsed.command}"`)
  }
}

function requireId(parsed: Parsed, what: string): string {
  const id = parsed.positionals[0]
  if (id === undefined || id.trim() === "") throw new UsageError(`${what} is required`)
  if (parsed.positionals.length > 1) throw new UsageError(`unexpected argument "${parsed.positionals[1]}"`)
  return id
}

/** `--notes @file` reads the notes body from a file, curl-style. */
function resolveNotes(raw: string | undefined, deps: CliDeps): string | undefined {
  if (raw === undefined) return undefined
  if (!raw.startsWith("@")) return raw
  const path = raw.slice(1)
  try {
    return deps.readFile(path)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new UsageError(`cannot read notes file "${path}": ${reason}`)
  }
}

const INIT_TEMPLATE = `name: default
on: [manual]

inputs:
  feature: { type: string, required: true }

roles:
  implementer: { agent: build }

jobs:
  main:
    steps:
      - id: implement
        agent:
          role: implementer
          prompt: "Implement the feature: {{ inputs.feature }}."
      - id: merge_gate
        human: {}
        outcomes:
          approved: next
          rejected:
            rerun: { scope: steps, stepIds: [implement], maxRounds: 3 }
`

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/")
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

function exitCodeFor(error: ApiError): number {
  if (error.status === 0) return EXIT.unreachable
  switch (error.code) {
    case "unauthorized":
      return EXIT.unauthorized
    case "not_found":
      return EXIT.notFound
    case "run_already_concluded":
      return EXIT.duplicateReport
    case "conflict":
    case "no_pending_question":
    case "session_lost":
      return EXIT.conflict
    default:
      return EXIT.failure
  }
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`error: ${err.message}`)
      deps.stderr(USAGE)
      return EXIT.usage
    }
    throw err
  }

  if (parsed.flags.has("help") || parsed.command === "help" || parsed.command === null) {
    deps.stdout(USAGE)
    return parsed.command === null && !parsed.flags.has("help") ? EXIT.usage : EXIT.ok
  }

  const json = parsed.flags.has("json")

  // Reject unknown commands BEFORE the connection is resolved — a typo
  // (`conductor deamon`) must say "unknown command", not demand a daemon
  // address it would never use.
  const KNOWN_COMMANDS = new Set([
    "init",
    "daemon",
    "start",
    "status",
    "approve",
    "request-changes",
    "report",
    "answer",
    "pause",
    "resume",
    "abandon",
    "recover",
    "logs",
  ])
  if (!KNOWN_COMMANDS.has(parsed.command)) {
    deps.stderr(`error: unknown command "${parsed.command}"`)
    deps.stderr(USAGE)
    return EXIT.usage
  }

  try {
    if (parsed.command === "init") return await commandInit(parsed, deps)
    if (parsed.command === "daemon") return await commandDaemon(parsed, deps)

    const connection = resolveConnection({
      flags: {
        ...(stringFlag(parsed, "url") !== undefined ? { url: stringFlag(parsed, "url")! } : {}),
        ...(stringFlag(parsed, "token") !== undefined ? { token: stringFlag(parsed, "token")! } : {}),
        ...(stringFlag(parsed, "config") !== undefined ? { config: stringFlag(parsed, "config")! } : {}),
      },
      env: deps.env,
      readFile: deps.readFile,
      exists: deps.exists,
    })
    const client = new ApiClient(connection, deps.fetchImpl)

    switch (parsed.command) {
      case "start":
        return await commandStart(parsed, deps, client, json)
      case "status":
        return await commandStatus(parsed, deps, client, json)
      case "approve":
        return await commandApprove(parsed, deps, client, json)
      case "request-changes":
        return await commandRequestChanges(parsed, deps, client, json)
      case "report":
        return await commandReport(parsed, deps, client, json)
      case "answer":
        return await commandAnswer(parsed, deps, client, json)
      case "pause":
      case "resume":
      case "abandon":
        return await commandLifecycle(parsed, deps, client, json)
      case "recover":
        return await commandRecover(parsed, deps, client, json)
      case "logs":
        return await commandLogs(parsed, deps, client, json)
      default:
        throw new UsageError(`unknown command "${parsed.command}"`)
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`error: ${err.message}`)
      return EXIT.usage
    }
    if (err instanceof ApiError) {
      if (json) {
        deps.stderr(
          JSON.stringify({ error: { code: err.code, message: err.message, status: err.status, requestId: err.requestId } }),
        )
      } else {
        deps.stderr(`error[${err.code}]: ${err.message}${err.requestId !== null ? ` (request ${err.requestId})` : ""}`)
      }
      return exitCodeFor(err)
    }
    const message = err instanceof Error ? err.message : String(err)
    deps.stderr(`error: ${message}`)
    return EXIT.failure
  }
}

async function commandInit(parsed: Parsed, deps: CliDeps): Promise<number> {
  requireFlags(parsed, ["dir", "force", "no-register"])
  if (parsed.positionals.length > 0) throw new UsageError(`unexpected argument "${parsed.positionals[0]}"`)
  const rawDir = stringFlag(parsed, "dir") ?? deps.cwd()
  // The directory is persisted into the daemon config and sent to a
  // separate daemon process — a relative path would resolve against THAT
  // process's cwd, so it must become absolute here, against ours.
  const dir = rawDir.startsWith("/") ? rawDir : joinPath(deps.cwd(), rawDir)
  const configPath = joinPath(dir, "conductor.yaml")
  if (deps.exists(configPath) && !parsed.flags.has("force")) {
    deps.stderr(`error: ${configPath} already exists (use --force to overwrite)`)
    return EXIT.failure
  }
  deps.mkdir(dir)
  deps.writeFile(configPath, INIT_TEMPLATE)
  deps.stdout(`Wrote ${configPath}`)

  if (parsed.flags.has("no-register")) {
    deps.stdout("Skipped daemon registration (--no-register). Add the directory to the daemon config's projects list yourself.")
    return EXIT.ok
  }

  // An explicit connection (flags/env/client config) means the daemon of
  // record is whatever that connection points at — possibly remote. The
  // LOCAL platform config would never be read by that daemon, so writing
  // the project there would fake durable registration. Only the
  // zero-config local path owns the platform config.
  const explicitConnection =
    stringFlag(parsed, "url") !== undefined ||
    stringFlag(parsed, "config") !== undefined ||
    (deps.env["CONDUCTOR_URL"] ?? "") !== "" ||
    (deps.env["CONDUCTOR_CONFIG"] ?? "") !== ""
  if (explicitConnection) {
    deps.stdout("Explicit daemon connection configured — registering live only (the daemon's own config is not touched).")
  } else {
    registerInDaemonConfig(dir, deps)
  }
  await registerWithRunningDaemon(dir, deps, parsed)
  return EXIT.ok
}

/** Idempotently add the project to the platform daemon config, generating the config with defaults when absent. */
function registerInDaemonConfig(dir: string, deps: CliDeps): void {
  let paths
  try {
    paths = platformPaths(deps.env)
  } catch {
    deps.stdout("No HOME/XDG environment — skipped daemon config registration; use conductor daemon --config explicitly.")
    return
  }
  if (!deps.exists(paths.configPath)) {
    const parent = parentPath(paths.configPath)
    if (parent !== "") deps.mkdir(parent)
    deps.writeFile(paths.configPath, defaultDaemonConfig(paths))
    deps.stdout(`Generated daemon config ${paths.configPath}`)
  }
  const result = addProjectToConfig(deps.readFile(paths.configPath), dir)
  if (result.changed) {
    deps.writeFile(paths.configPath, result.source)
    deps.stdout(`Registered ${dir} in ${paths.configPath}`)
  } else {
    deps.stdout(`${dir} already registered in ${paths.configPath}`)
  }
}

/** Best-effort live registration: a reachable daemon picks the project up without restart; unreachable is a hint, not a failure. */
async function registerWithRunningDaemon(dir: string, deps: CliDeps, parsed: Parsed): Promise<void> {
  let client: ApiClient
  try {
    const connection = resolveConnection({
      flags: {
        ...(stringFlag(parsed, "url") !== undefined ? { url: stringFlag(parsed, "url")! } : {}),
        ...(stringFlag(parsed, "token") !== undefined ? { token: stringFlag(parsed, "token")! } : {}),
        ...(stringFlag(parsed, "config") !== undefined ? { config: stringFlag(parsed, "config")! } : {}),
      },
      env: deps.env,
      readFile: deps.readFile,
      exists: deps.exists,
    })
    client = new ApiClient(connection, deps.fetchImpl)
  } catch {
    deps.stdout("No daemon connection — start one with: conductor daemon")
    return
  }
  try {
    const registered = await client.registerProject(dir)
    deps.stdout(`Daemon registered the project live (workflow "${registered.workflow}") — ready for: conductor start <title> --project ${dir}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      deps.stdout("Daemon not reachable — start it with: conductor daemon (the project is already in its config)")
      return
    }
    const reason = err instanceof Error ? err.message : String(err)
    deps.stdout(`Daemon did not accept the project yet: ${reason}`)
    deps.stdout("Fix conductor.yaml if invalid; the daemon will register it from its config on next start.")
  }
}

async function commandDaemon(parsed: Parsed, deps: CliDeps): Promise<number> {
  requireFlags(parsed, ["config", "init-config", "force", "no-ui"])
  if (parsed.positionals.length > 0) throw new UsageError(`unexpected argument "${parsed.positionals[0]}"`)

  const initPath = stringFlag(parsed, "init-config")
  const configPath = stringFlag(parsed, "config")
  if (initPath !== undefined) {
    if (configPath !== undefined) throw new UsageError("--config and --init-config are mutually exclusive")
    if (deps.exists(initPath) && !parsed.flags.has("force")) {
      deps.stderr(`error: ${initPath} already exists (use --force to overwrite)`)
      return EXIT.failure
    }
    const parent = parentPath(initPath)
    if (parent !== "") deps.mkdir(parent)
    deps.writeFile(initPath, DAEMON_CONFIG_TEMPLATE)
    deps.stdout(`Wrote ${initPath}`)
    deps.stdout("Start the daemon with: conductor daemon --config <path>")
    return EXIT.ok
  }

  const log = (entry: DaemonLogEntry): void => {
    const line = { level: entry.level, message: entry.message, ...(entry.fields ?? {}) }
    deps.stdout(JSON.stringify(line))
  }

  let effectivePath: string
  if (configPath !== undefined) {
    effectivePath = configPath
  } else {
    const paths = platformPaths(deps.env)
    effectivePath = paths.configPath
    if (!deps.exists(effectivePath)) {
      const parent = parentPath(effectivePath)
      if (parent !== "") deps.mkdir(parent)
      deps.writeFile(effectivePath, defaultDaemonConfig(paths))
      log({ level: "info", message: "daemon config generated", fields: { path: effectivePath } })
    }
  }

  let source: string
  try {
    source = deps.readFile(effectivePath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.stderr(`error: cannot read daemon config "${effectivePath}": ${reason}`)
    return EXIT.usage
  }

  const config = loadDaemonConfig(source)
  const { daemon } = config
  let api = config.api

  // Environment overrides for the listener — the deployment surface
  // (Docker, systemd, quick LAN exposure) without editing the file. The
  // file stays the source of truth for everything else.
  const hostOverride = deps.env["CONDUCTOR_BIND_HOST"]
  const portOverride = deps.env["CONDUCTOR_BIND_PORT"]
  if (hostOverride !== undefined && hostOverride.trim() !== "") {
    api = { ...api, bind: { ...api.bind, host: hostOverride } }
    log({ level: "info", message: "bind host overridden by CONDUCTOR_BIND_HOST", fields: { host: hostOverride } })
  }
  if (portOverride !== undefined && portOverride.trim() !== "") {
    const port = Number(portOverride)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      deps.stderr(`error: CONDUCTOR_BIND_PORT "${portOverride}" must be an integer between 1 and 65535`)
      return EXIT.usage
    }
    api = { ...api, bind: { ...api.bind, port } }
    log({ level: "info", message: "bind port overridden by CONDUCTOR_BIND_PORT", fields: { port } })
  }

  if (api.auth.mode === "none") {
    log({
      level: "warn",
      message: `API authentication is disabled (auth.mode: none) — the API is open on ${api.bind.host}:${api.bind.port}`,
    })
    if (!isLoopbackHost(api.bind.host)) {
      log({
        level: "warn",
        message: `auth.mode: none on a non-loopback bind (${api.bind.host}) — anyone on the network can drive this daemon; switch to auth.mode: bearer`,
      })
    }
  }

  if (deps.startDaemon === undefined) {
    deps.stderr("error: this build cannot start a daemon (no daemon runtime wired)")
    return EXIT.failure
  }
  const handle = deps.startDaemon({ daemon, api, noUi: parsed.flags.has("no-ui"), log })
  try {
    await handle.started
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.stderr(`error: daemon failed to start: ${reason}`)
    return EXIT.failure
  }
  return await handle.exited
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/")
  return index <= 0 ? "" : path.slice(0, index)
}

/**
 * Loopback detection for the auth-none safety warning. Covers the whole
 * 127.0.0.0/8 range, IPv6 loopback in expanded/bracketed forms, the
 * IPv4-mapped IPv6 loopback and case-insensitive "localhost" — a false
 * negative here silently defeats the warning.
 */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost") return true
  if (normalized.startsWith("127.")) return true
  const unmapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized
  if (unmapped.startsWith("127.")) return true
  const zeroStripped = unmapped.replace(/^(0+:)+/, "::").replace(/^::+/, "::")
  return unmapped === "::1" || zeroStripped === "::1"
}

function printFeature(
  deps: CliDeps,
  payload: {
    feature: {
      id: string
      title: string
      status: string
      currentStep: string | null
      workflow: string | null
      pr: number | null
      escalation: string | null
      jobs?: Readonly<Record<string, { steps?: Readonly<Record<string, { status?: string; prompt?: string }>> }>>
    }
    activeRun: { id: string; jobId: string; stepId: string; attempt: number; pendingQuestion?: string | null } | null
  },
): void {
  const { feature, activeRun } = payload
  deps.stdout(`feature  ${feature.id}`)
  deps.stdout(`title    ${feature.title}`)
  deps.stdout(`status   ${feature.status}`)
  deps.stdout(`step     ${feature.currentStep ?? "-"}`)
  if (feature.workflow !== null) deps.stdout(`workflow ${feature.workflow}`)
  if (feature.pr !== null) deps.stdout(`pr       #${feature.pr}`)
  if (feature.escalation !== null) deps.stdout(`escalation ${feature.escalation}`)
  if (activeRun) deps.stdout(`run      ${activeRun.id} (${activeRun.stepId}, attempt ${activeRun.attempt})`)
  if (activeRun?.pendingQuestion != null && activeRun.pendingQuestion.trim() !== "") {
    deps.stdout(`question ${activeRun.jobId}/${activeRun.stepId} (answer with: conductor answer ${activeRun.id} --notes <text>):`)
    for (const line of activeRun.pendingQuestion.split("\n")) deps.stdout(`  ${line}`)
  }
  for (const [jobId, job] of Object.entries(feature.jobs ?? {})) {
    for (const [stepId, step] of Object.entries(job.steps ?? {})) {
      if (step.status === "waiting_human" && step.prompt !== undefined && step.prompt.trim() !== "") {
        deps.stdout(`gate     ${jobId}/${stepId}:`)
        for (const line of step.prompt.split("\n")) deps.stdout(`  ${line}`)
      }
    }
  }
}

async function commandStart(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, ["project", "description", "workflow", "pr"])
  const title = parsed.positionals[0]
  if (title === undefined || title.trim() === "") throw new UsageError("start requires a feature title")
  if (parsed.positionals.length > 1) throw new UsageError(`unexpected argument "${parsed.positionals[1]}"`)
  // Default to the working directory — running `conductor start` inside
  // the project is the common case; --project stays for driving another
  // directory. Relative values resolve against cwd for the same
  // cross-process reason as `init --dir`.
  const rawProject = stringFlag(parsed, "project") ?? deps.cwd()
  const project = rawProject.startsWith("/") ? rawProject : joinPath(deps.cwd(), rawProject)
  const prRaw = stringFlag(parsed, "pr")
  let pr: number | undefined
  if (prRaw !== undefined) {
    pr = Number(prRaw)
    if (!Number.isInteger(pr) || pr <= 0) throw new UsageError("--pr must be a positive integer")
  }
  const payload = await client.startFeature({
    title,
    project,
    ...(stringFlag(parsed, "description") !== undefined ? { description: stringFlag(parsed, "description")! } : {}),
    ...(stringFlag(parsed, "workflow") !== undefined ? { workflow: stringFlag(parsed, "workflow")! } : {}),
    ...(pr !== undefined ? { pr } : {}),
  })
  if (json) {
    deps.stdout(JSON.stringify(payload))
    return EXIT.ok
  }
  deps.stdout(`Started feature ${payload.feature.id}`)
  printFeature(deps, payload)
  return EXIT.ok
}

async function commandStatus(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, ["project", "active"])
  const featureId = parsed.positionals[0]
  if (featureId !== undefined) {
    if (parsed.positionals.length > 1) throw new UsageError(`unexpected argument "${parsed.positionals[1]}"`)
    const payload = await client.getFeature(featureId)
    if (json) {
      deps.stdout(JSON.stringify(payload))
      return EXIT.ok
    }
    printFeature(deps, payload)
    return EXIT.ok
  }
  const project = stringFlag(parsed, "project")
  const { features } = await client.listFeatures({
    ...(project !== undefined ? { project } : {}),
    ...(parsed.flags.has("active") ? { active: true } : {}),
  })
  if (json) {
    deps.stdout(JSON.stringify({ features }))
    return EXIT.ok
  }
  if (features.length === 0) {
    deps.stdout("no features")
    return EXIT.ok
  }
  for (const feature of features) {
    deps.stdout(`${feature.id}  ${feature.status}  ${feature.currentStep ?? "-"}  ${feature.title}`)
  }
  return EXIT.ok
}

async function commandApprove(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, ["notes"])
  const featureId = requireId(parsed, "approve requires a feature id")
  const notes = resolveNotes(stringFlag(parsed, "notes"), deps)
  const payload = await client.approve(featureId, notes)
  if (json) {
    deps.stdout(JSON.stringify(payload))
    return EXIT.ok
  }
  deps.stdout(payload.result ?? "Approved")
  printFeature(deps, payload)
  return EXIT.ok
}

async function commandRequestChanges(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, ["notes"])
  const featureId = requireId(parsed, "request-changes requires a feature id")
  const notes = resolveNotes(stringFlag(parsed, "notes"), deps)
  if (notes === undefined || notes.trim() === "") {
    throw new UsageError("request-changes requires --notes with the requested changes")
  }
  const payload = await client.requestChanges(featureId, notes)
  if (json) {
    deps.stdout(JSON.stringify(payload))
    return EXIT.ok
  }
  deps.stdout(payload.result ?? "Changes requested")
  printFeature(deps, payload)
  return EXIT.ok
}

async function commandReport(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, ["outcome", "verdict", "notes"])
  const runId = requireId(parsed, "report requires a run id")
  const outcome = stringFlag(parsed, "outcome")
  const verdict = stringFlag(parsed, "verdict")
  if (outcome !== undefined && verdict !== undefined) {
    throw new UsageError("--outcome and --verdict are mutually exclusive")
  }
  if (outcome === undefined && verdict === undefined) {
    throw new UsageError("report requires --outcome succeeded|failed or --verdict <verdict>")
  }
  if (outcome !== undefined && outcome !== "succeeded" && outcome !== "failed") {
    throw new UsageError('--outcome must be "succeeded" or "failed"')
  }
  const notes = resolveNotes(stringFlag(parsed, "notes"), deps)
  const payload = await client.report(runId, {
    ...(outcome !== undefined ? { outcome: outcome as "succeeded" | "failed" } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(notes !== undefined ? { notes } : {}),
  })
  if (json) {
    deps.stdout(JSON.stringify(payload))
    return EXIT.ok
  }
  deps.stdout(payload.result)
  return EXIT.ok
}

async function commandAnswer(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, ["notes"])
  const runId = requireId(parsed, "answer requires a run id")
  const notes = resolveNotes(stringFlag(parsed, "notes"), deps)
  if (notes === undefined || notes.trim() === "") {
    throw new UsageError("answer requires --notes with the answer text")
  }
  const payload = await client.answer(runId, notes)
  if (json) {
    deps.stdout(JSON.stringify(payload))
    return EXIT.ok
  }
  deps.stdout(payload.result)
  return EXIT.ok
}

async function commandRecover(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  const featureId = requireId(parsed, "recover requires a feature id")
  const notes = resolveNotes(stringFlag(parsed, "notes"), deps)
  if (notes === undefined || notes.trim() === "") {
    throw new UsageError("recover requires --notes explaining why you are recovering")
  }
  const payload = await client.recover(featureId, notes)
  if (json) {
    deps.stdout(JSON.stringify(payload))
    return EXIT.ok
  }
  deps.stdout(payload.result ?? "Recovered")
  printFeature(deps, payload)
  return EXIT.ok
}

async function commandLifecycle(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, [])
  const featureId = requireId(parsed, `${parsed.command} requires a feature id`)
  const payload =
    parsed.command === "pause"
      ? await client.pause(featureId)
      : parsed.command === "resume"
        ? await client.resume(featureId)
        : await client.abandon(featureId)
  if (json) {
    deps.stdout(JSON.stringify(payload))
    return EXIT.ok
  }
  deps.stdout(`Feature ${payload.feature.id} is now ${payload.feature.status}`)
  return EXIT.ok
}

async function commandLogs(parsed: Parsed, deps: CliDeps, client: ApiClient, json: boolean): Promise<number> {
  requireFlags(parsed, [])
  const featureId = requireId(parsed, "logs requires a feature id")
  const { timeline } = await client.timeline(featureId)
  if (json) {
    deps.stdout(JSON.stringify({ timeline }))
    return EXIT.ok
  }
  if (timeline.length === 0) {
    deps.stdout("no transitions")
    return EXIT.ok
  }
  // The API returns newest-first; logs read chronologically.
  for (const entry of [...timeline].reverse()) {
    deps.stdout(`${formatTime(entry.time)}  ${eventLabel(entry.event)} → ${decisionsLabel(entry.decisions)}`)
  }
  return EXIT.ok
}

function decisionsLabel(decisions: TransitionView["decisions"]): string {
  return decisions
    .map(decision => {
      const detail = "jobId" in decision && "stepId" in decision
        ? `:${String(decision["jobId"])}/${String(decision["stepId"])}`
        : "reason" in decision
          ? ` (${String(decision["reason"])})`
          : ""
      return `${decision.kind}${detail}`
    })
    .join(", ")
}

function eventLabel(event: TransitionView["event"]): string {
  return event.kind
}
