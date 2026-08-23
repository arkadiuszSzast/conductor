/**
 * OpenSpec plugin backend — the reference plugin (plugin-system change,
 * `openspec-plugin` spec). Root-relative HTTP routes, reached by the
 * daemon's reverse proxy with the `/v1/plugins/openspec` prefix already
 * stripped:
 *
 *   GET  /changes     -> { openspec: false } | { openspec: true, active, archived }
 *   POST /start-work  -> { featureId } | { error }
 *   GET  /ui/...      -> static panel files
 *
 * `handleRequest` is pure I/O-via-injected-deps so it is testable
 * without binding a real port; `if (import.meta.main)` below is the
 * only place that touches the real environment, filesystem and network.
 * Bun built-ins and Node-compat modules only — no `@conductor/*`
 * imports, exactly like any third-party plugin would be written.
 */

import { spawn } from "node:child_process"
import { readdir, readFile as fsReadFile, stat } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface OpenSpecServeDeps {
  readonly projectDir: string
  readonly conductorUrl: string
  readonly conductorToken?: string
  readonly uiDir: string
  readonly exec: (command: readonly string[], options: { readonly cwd: string }) => Promise<ExecResult>
  readonly fetchFn: typeof fetch
  readonly readFile: (path: string) => Promise<string>
  readonly readDir: (path: string) => Promise<readonly string[]>
  readonly isDirectory: (path: string) => Promise<boolean>
}

interface TaskProgress {
  readonly done: number
  readonly total: number
}

interface ActiveChange {
  readonly name: string
  readonly taskProgress: TaskProgress | null
}

interface RawListedChange {
  readonly name?: unknown
  readonly completedTasks?: unknown
  readonly totalTasks?: unknown
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const CHANGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isSafeChangeName(name: string): boolean {
  return CHANGE_NAME_PATTERN.test(name)
}

async function countTasksFromFile(deps: OpenSpecServeDeps, name: string): Promise<TaskProgress | null> {
  try {
    const text = await deps.readFile(join(deps.projectDir, "openspec", "changes", name, "tasks.md"))
    const done = (text.match(/^\s*-\s*\[[xX]\]/gm) ?? []).length
    const pending = (text.match(/^\s*-\s*\[\s\]/gm) ?? []).length
    return { done, total: done + pending }
  } catch {
    return null
  }
}

async function toActiveChange(raw: RawListedChange, deps: OpenSpecServeDeps): Promise<ActiveChange | null> {
  if (typeof raw.name !== "string" || raw.name.trim() === "") return null
  let done = typeof raw.completedTasks === "number" ? raw.completedTasks : undefined
  let total = typeof raw.totalTasks === "number" ? raw.totalTasks : undefined
  if (done === undefined || total === undefined) {
    const counted = await countTasksFromFile(deps, raw.name)
    done = counted?.done
    total = counted?.total
  }
  const taskProgress = done !== undefined && total !== undefined && total > 0 ? { done, total } : null
  return { name: raw.name, taskProgress }
}

async function listArchived(deps: OpenSpecServeDeps): Promise<readonly string[]> {
  try {
    const entries = await deps.readDir(join(deps.projectDir, "openspec", "changes", "archive"))
    return [...entries].sort()
  } catch {
    return []
  }
}

async function handleChanges(deps: OpenSpecServeDeps): Promise<Response> {
  const hasOpenSpec = await deps.isDirectory(join(deps.projectDir, "openspec"))
  if (!hasOpenSpec) return jsonResponse(200, { openspec: false })

  const result = await deps.exec(["openspec", "list", "--json"], { cwd: deps.projectDir })
  let rawChanges: readonly RawListedChange[] = []
  if (result.code === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { changes?: readonly RawListedChange[] }
      rawChanges = parsed.changes ?? []
    } catch {
      rawChanges = []
    }
  }

  const active = (await Promise.all(rawChanges.map(raw => toActiveChange(raw, deps))))
    .filter((change): change is ActiveChange => change !== null)
  const archived = await listArchived(deps)
  return jsonResponse(200, { openspec: true, active, archived })
}

function titleFromChangeName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(word => word !== "")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function extractWhySection(markdown: string): string | null {
  const lines = markdown.split("\n")
  const startIndex = lines.findIndex(line => /^##\s+why\s*$/i.test(line.trim()))
  if (startIndex === -1) return null
  const rest = lines.slice(startIndex + 1)
  const endIndex = rest.findIndex(line => /^##\s+/.test(line))
  const section = (endIndex === -1 ? rest : rest.slice(0, endIndex)).join("\n").trim()
  return section === "" ? null : section
}

async function handleStartWork(request: Request, deps: OpenSpecServeDeps): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, { error: "request body must be JSON" })
  }
  const change = isRecord(body) && typeof body.change === "string" ? body.change.trim() : ""
  if (change === "") return jsonResponse(400, { error: '"change" (non-empty string) is required' })
  if (!isSafeChangeName(change)) return jsonResponse(400, { error: `invalid change name "${change}"` })

  let proposalText: string
  try {
    proposalText = await deps.readFile(join(deps.projectDir, "openspec", "changes", change, "proposal.md"))
  } catch {
    return jsonResponse(404, { error: `no proposal found for change "${change}"` })
  }

  const title = titleFromChangeName(change)
  const description = extractWhySection(proposalText) ?? proposalText.trim()

  let response: Response
  try {
    response = await deps.fetchFn(`${deps.conductorUrl}/v1/features`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(deps.conductorToken !== undefined ? { authorization: `Bearer ${deps.conductorToken}` } : {}),
      },
      body: JSON.stringify({ title, project: deps.projectDir, description }),
    })
  } catch (error) {
    return jsonResponse(502, { error: `could not reach the daemon: ${errorMessage(error)}` })
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : `daemon responded ${response.status}`
    return jsonResponse(response.status, { error: message })
  }

  const featureId =
    isRecord(payload) && isRecord(payload.feature) && typeof payload.feature.id === "string" ? payload.feature.id : null
  if (featureId === null) return jsonResponse(502, { error: "daemon response did not include a feature id" })

  return jsonResponse(200, { featureId })
}

function safeDecode(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path)
    return decoded.includes("\0") ? null : decoded
  } catch {
    return null
  }
}

function resolveStaticPath(uiDir: string, requestPath: string): string | null {
  const relative = requestPath === "/ui" ? "/" : requestPath.slice("/ui".length)
  const decoded = safeDecode(relative)
  if (decoded === null) return null
  const finalRelative = decoded.endsWith("/") ? `${decoded}index.html` : decoded
  const candidate = resolve(uiDir, `.${finalRelative}`)
  if (candidate !== uiDir && !candidate.startsWith(uiDir + sep)) return null
  return candidate
}

async function handleStatic(path: string, deps: OpenSpecServeDeps): Promise<Response> {
  const candidate = resolveStaticPath(deps.uiDir, path)
  if (candidate === null) return jsonResponse(404, { error: "not found" })
  let contents: string
  try {
    contents = await deps.readFile(candidate)
  } catch {
    return jsonResponse(404, { error: "not found" })
  }
  const contentType = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream"
  return new Response(contents, { status: 200, headers: { "content-type": contentType } })
}

export async function handleRequest(request: Request, deps: OpenSpecServeDeps): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (request.method === "GET" && path === "/changes") return handleChanges(deps)
  if (request.method === "POST" && path === "/start-work") return handleStartWork(request, deps)
  if (request.method === "GET" && (path === "/ui" || path.startsWith("/ui/"))) return handleStatic(path, deps)

  return jsonResponse(404, { error: `no route for ${request.method} ${path}` })
}

function realExec(command: readonly string[], options: { readonly cwd: string }): Promise<ExecResult> {
  return new Promise(resolvePromise => {
    const [head, ...rest] = command
    if (head === undefined) {
      resolvePromise({ code: 127, stdout: "", stderr: "empty command" })
      return
    }
    const child = spawn(head, rest, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on("data", chunk => stdoutChunks.push(chunk))
    child.stderr?.on("data", chunk => stderrChunks.push(chunk))
    child.on("close", code => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      })
    })
    child.on("error", error => {
      resolvePromise({ code: 127, stdout: "", stderr: errorMessage(error) })
    })
  })
}

async function realIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

if (import.meta.main) {
  const port = Number(process.env.CONDUCTOR_PLUGIN_PORT)
  const projectDir = process.env.CONDUCTOR_PROJECT_DIR
  const conductorUrl = process.env.CONDUCTOR_URL
  if (!Number.isInteger(port) || projectDir === undefined || conductorUrl === undefined) {
    console.error("openspec plugin: missing required environment (CONDUCTOR_PLUGIN_PORT, CONDUCTOR_PROJECT_DIR, CONDUCTOR_URL)")
    process.exit(1)
  }

  const deps: OpenSpecServeDeps = {
    projectDir,
    conductorUrl,
    ...(process.env.CONDUCTOR_TOKEN !== undefined ? { conductorToken: process.env.CONDUCTOR_TOKEN } : {}),
    uiDir: resolve(import.meta.dirname, "ui"),
    exec: realExec,
    fetchFn: fetch,
    readFile: path => fsReadFile(path, "utf8"),
    readDir: path => readdir(path),
    isDirectory: realIsDirectory,
  }

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: request => handleRequest(request, deps),
  })
}
