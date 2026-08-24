/**
 * OpenSpec plugin backend — the reference plugin (plugin-system change,
 * `openspec-plugin` spec). Root-relative HTTP routes, reached by the
 * daemon's reverse proxy with the `/v1/plugins/openspec` prefix already
 * stripped:
 *
 *   GET  /changes     -> { openspec: false } | { openspec: true, active, archived }
 *   GET  /change      -> per-change detail (proposal sections, delta specs, tasks) | { error }
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

/** The `openspec` CLI may be absent on the host (it is the project's
 *  tool, not the plugin's dependency) — enumerate change directories
 *  directly so the panel degrades to file-derived data, not an empty
 *  list. */
async function listChangesFromFs(deps: OpenSpecServeDeps): Promise<readonly RawListedChange[]> {
  try {
    const entries = await deps.readDir(join(deps.projectDir, "openspec", "changes"))
    const names = entries.filter(name => name !== "archive" && isSafeChangeName(name))
    const changes: RawListedChange[] = []
    for (const name of names.sort()) {
      if (await deps.isDirectory(join(deps.projectDir, "openspec", "changes", name))) {
        changes.push({ name })
      }
    }
    return changes
  } catch {
    return []
  }
}

async function handleChanges(deps: OpenSpecServeDeps): Promise<Response> {
  const hasOpenSpec = await deps.isDirectory(join(deps.projectDir, "openspec"))
  if (!hasOpenSpec) return jsonResponse(200, { openspec: false })

  const result = await deps.exec(["openspec", "list", "--json"], { cwd: deps.projectDir })
  let rawChanges: readonly RawListedChange[] | null = null
  if (result.code === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { changes?: readonly RawListedChange[] }
      rawChanges = parsed.changes ?? []
    } catch {
      rawChanges = null
    }
  }
  if (rawChanges === null) rawChanges = await listChangesFromFs(deps)

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

function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n")
  const headingPattern = new RegExp(`^##\\s+${heading}\\s*$`, "i")
  const startIndex = lines.findIndex(line => headingPattern.test(line.trim()))
  if (startIndex === -1) return null
  const rest = lines.slice(startIndex + 1)
  const endIndex = rest.findIndex(line => /^##\s+/.test(line))
  const section = (endIndex === -1 ? rest : rest.slice(0, endIndex)).join("\n").trim()
  return section === "" ? null : section
}

function extractWhySection(markdown: string): string | null {
  return extractSection(markdown, "why")
}

interface ChangeRequirement {
  readonly heading: string
  readonly body: string
}

interface ChangeSpec {
  readonly capability: string
  readonly requirements: readonly ChangeRequirement[]
}

interface ChangeTask {
  readonly text: string
  readonly done: boolean
}

interface ResolvedChangeDir {
  readonly dir: string
  readonly archived: boolean
}

async function resolveChangeDir(deps: OpenSpecServeDeps, name: string): Promise<ResolvedChangeDir | null> {
  const activeDir = join(deps.projectDir, "openspec", "changes", name)
  if (await deps.isDirectory(activeDir)) return { dir: activeDir, archived: false }
  const archivedDir = join(deps.projectDir, "openspec", "changes", "archive", name)
  if (await deps.isDirectory(archivedDir)) return { dir: archivedDir, archived: true }
  return null
}

function parseRequirements(markdown: string): readonly ChangeRequirement[] {
  const lines = markdown.split("\n")
  const headingIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,3}\s+/.test(lines[i] ?? "")) headingIndices.push(i)
  }
  const requirements: ChangeRequirement[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = /^###\s*Requirement:\s*(.+)$/i.exec(lines[i] ?? "")
    if (match === null) continue
    const heading = (match[1] ?? "").trim()
    const nextHeadingIndex = headingIndices.find(index => index > i)
    const end = nextHeadingIndex ?? lines.length
    const body = lines.slice(i + 1, end).join("\n").trim()
    requirements.push({ heading, body })
  }
  return requirements
}

function parseTasks(markdown: string): readonly ChangeTask[] {
  const tasks: ChangeTask[] = []
  for (const line of markdown.split("\n")) {
    const match = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(line)
    if (match === null) continue
    tasks.push({ text: (match[2] ?? "").trim(), done: match[1] !== " " })
  }
  return tasks
}

async function readSpecs(deps: OpenSpecServeDeps, changeDir: string): Promise<readonly ChangeSpec[] | undefined> {
  let capabilities: readonly string[]
  try {
    capabilities = await deps.readDir(join(changeDir, "specs"))
  } catch {
    return undefined
  }
  const specs: ChangeSpec[] = []
  for (const capability of [...capabilities].sort()) {
    const capabilityDir = join(changeDir, "specs", capability)
    if (!(await deps.isDirectory(capabilityDir))) continue
    let text: string
    try {
      text = await deps.readFile(join(capabilityDir, "spec.md"))
    } catch {
      continue
    }
    specs.push({ capability, requirements: parseRequirements(text) })
  }
  return specs
}

async function handleChangeDetail(request: Request, deps: OpenSpecServeDeps): Promise<Response> {
  const url = new URL(request.url)
  const name = url.searchParams.get("name") ?? ""
  if (!isSafeChangeName(name)) return jsonResponse(400, { error: `invalid change name "${name}"` })

  const resolved = await resolveChangeDir(deps, name)
  if (resolved === null) return jsonResponse(404, { error: `no change found named "${name}"` })

  let proposalText: string | null = null
  try {
    proposalText = await deps.readFile(join(resolved.dir, "proposal.md"))
  } catch {
    proposalText = null
  }

  let tasksText: string | null = null
  try {
    tasksText = await deps.readFile(join(resolved.dir, "tasks.md"))
  } catch {
    tasksText = null
  }

  return jsonResponse(200, {
    name,
    archived: resolved.archived,
    why: proposalText !== null ? (extractSection(proposalText, "why") ?? undefined) : undefined,
    whatChanges: proposalText !== null ? (extractSection(proposalText, "what changes") ?? undefined) : undefined,
    specs: await readSpecs(deps, resolved.dir),
    tasks: tasksText !== null ? parseTasks(tasksText) : undefined,
  })
}

/** Workflows commonly declare which OpenSpec change a feature delivers
 *  as a required string input (the dogfood workflow calls it
 *  `change_slug`). The plugin knows the change being started, so it
 *  fills that input automatically instead of failing the creation.
 *  Projection failures degrade to "no inputs" — daemon validation
 *  still applies and its message is relayed as usual. */
const CHANGE_INPUT_NAMES = ["change_slug", "change"] as const

async function resolveChangeInput(
  change: string,
  deps: OpenSpecServeDeps,
): Promise<Record<string, string> | null> {
  try {
    const response = await deps.fetchFn(
      `${deps.conductorUrl}/v1/projects/workflow?dir=${encodeURIComponent(deps.projectDir)}`,
      {
        headers: deps.conductorToken !== undefined ? { authorization: `Bearer ${deps.conductorToken}` } : {},
      },
    )
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !isRecord(payload.inputs)) return null
    for (const name of CHANGE_INPUT_NAMES) {
      const input = payload.inputs[name]
      if (isRecord(input) && input.type === "string") return { [name]: change }
    }
    return null
  } catch {
    return null
  }
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
  const inputs = await resolveChangeInput(change, deps)

  let response: Response
  try {
    response = await deps.fetchFn(`${deps.conductorUrl}/v1/features`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(deps.conductorToken !== undefined ? { authorization: `Bearer ${deps.conductorToken}` } : {}),
      },
      body: JSON.stringify({ title, project: deps.projectDir, description, ...(inputs !== null ? { inputs } : {}) }),
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
  if (request.method === "GET" && path === "/change") return handleChangeDetail(request, deps)
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
