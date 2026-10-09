/**
 * OpenCode v2 server events → run log. The daemon follows the server's
 * `/api/event` stream and turns a bound session's activity into the same
 * two line kinds the ACP writer produces:
 *
 *  - `agent` — one line per finished text part (`session.text.ended`), so
 *    the narrative reads as whole sentences rather than token deltas.
 *  - `tool`  — one line per tool call (`session.tool.called`): a phrase
 *    plus a short, curated target (file name, skill id, lsp operation,
 *    search pattern, program name). Never the raw input — shell command
 *    lines, file contents and prompts stay out of the log. A failed call
 *    adds a second `… failed` line.
 *
 * Events for sessions with no active opencode binding (the feature root,
 * foreign sessions on the same server) are dropped. Every line goes
 * through `boundDiagnostic`. Writes are best-effort: a failing sink or a
 * broken stream never touches the run.
 */

import { basename } from "node:path"
import { boundDiagnostic } from "@conductor/core"

export const OPENCODE_RUN_LOG_FLUSH_MS = 1_000
const TARGET_MAX = 80
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export interface OpencodeRunLogLine {
  readonly source: "agent" | "tool"
  readonly text: string
}

export type OpencodeRunLogSink = (runId: string, lines: readonly OpencodeRunLogLine[]) => void

const TOOL_PHRASES: Record<string, string> = {
  read: "reading",
  write: "writing",
  edit: "editing",
  multiedit: "editing",
  patch: "patching",
  apply_patch: "patching",
  shell: "running",
  bash: "running",
  grep: "searching",
  glob: "finding files",
  list: "listing",
  lsp: "lsp",
  skill: "loading skill",
  subagent: "delegating to",
  task: "delegating to",
  webfetch: "fetching",
  websearch: "searching web",
  todowrite: "updating todos",
  question: "asking a question",
  execute: "running code-mode tools",
  conductor_report: "reporting outcome",
}

type Input = Readonly<Record<string, unknown>>

const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ")
  return flat.length > TARGET_MAX ? `${flat.slice(0, TARGET_MAX)}…` : flat
}

function fileOf(input: Input): string | undefined {
  const path = str(input.path) ?? str(input.filePath) ?? str(input.file_path) ?? str(input.file)
  return path !== undefined ? basename(path) : undefined
}

/** The program a shell line starts with, past env assignments and `cd …&&`. */
/**
 * Blanks quoted text and `$(…)` / backtick substitutions so their `|`, `;`
 * and spaces do not split the command: `PW=$(head -c 24 … | tr …); curl …`
 * would otherwise be logged as `running -c`.
 */
function maskNested(command: string): string {
  let out = ""
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== undefined) {
      if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
        i++
        out += "_"
      } else if (ch === quote) quote = undefined
      out += "_"
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      out += "_"
    } else if (ch === "$" && command[i + 1] === "(") {
      depth++
      i++
      out += "__"
    } else if (depth > 0) {
      if (ch === "(") depth++
      else if (ch === ")") depth--
      out += "_"
    } else out += ch
  }
  return out
}

function programOf(command: string): string | undefined {
  const masked = maskNested(command)
  let start = 0
  for (const separator of masked.matchAll(/&&|\|\||;|\||\n|$/g)) {
    const end = separator.index
    const segment = masked.slice(start, end)
    const offset = start
    start = end + separator[0].length
    if (/^\s*cd\s/.test(segment)) continue
    for (const token of segment.matchAll(/\S+/g)) {
      const word = command.slice(offset + token.index, offset + token.index + token[0].length)
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
      return basename(word.replace(/^["']|["']$/g, ""))
    }
    if (end === masked.length) break
  }
  return undefined
}

function targetOf(name: string, input: Input): string | undefined {
  switch (name) {
    case "shell":
    case "bash": {
      const command = str(input.command)
      return command !== undefined ? programOf(command) : undefined
    }
    case "grep":
    case "glob": {
      const pattern = str(input.pattern)
      return pattern !== undefined ? `"${clip(pattern)}"` : undefined
    }
    case "lsp": {
      const operation = str(input.operation)
      const file = fileOf(input)
      return [operation, file].filter(Boolean).join(" ") || undefined
    }
    case "skill":
      return str(input.id) ?? str(input.name)
    case "subagent":
    case "task":
      return str(input.agent) ?? str(input.subagent_type)
    case "webfetch": {
      const url = str(input.url)
      try { return url !== undefined ? new URL(url).host : undefined } catch { return undefined }
    }
    case "execute": {
      const code = str(input.code)
      if (code === undefined) return undefined
      const tools = [...new Set([...code.matchAll(/tools\.([\w$]+(?:\.[\w$]+|\["[^"]+"\])*)\s*\(/g)].map(match => match[1]!))]
      return tools.length > 0 ? clip(tools.join(", ")) : undefined
    }
    default:
      return fileOf(input)
  }
}

export function toolLine(name: string, input: unknown): string {
  const phrase = Object.hasOwn(TOOL_PHRASES, name) ? TOOL_PHRASES[name]! : name.startsWith("repowise_") ? `repowise ${name.slice(9)}` : name
  const target = input !== null && typeof input === "object" ? targetOf(name, input as Input) : undefined
  return target !== undefined ? `${phrase} ${target}` : phrase
}

interface RunBuffer {
  lines: OpencodeRunLogLine[]
  /** tool call id → tool name, for the failure line. */
  calls: Map<string, string>
}

export interface OpencodeRunLogWriterOptions {
  readonly sink: OpencodeRunLogSink
  /** sessionID → running attempt bound to it, or undefined. */
  readonly runIdForSession: (sessionID: string) => string | undefined
  readonly flushMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => () => void
}

interface ServerEvent {
  readonly type?: unknown
  readonly data?: {
    readonly sessionID?: unknown
    readonly id?: unknown
    readonly name?: unknown
    readonly input?: unknown
    readonly text?: unknown
  }
}

export class OpencodeRunLogWriter {
  private readonly runs = new Map<string, RunBuffer>()
  /** tool call id → name, learnt from `session.tool.input.started`
   *  (the `called` event carries the input but not the name). */
  private readonly names = new Map<string, string>()
  private cancelTimer: (() => void) | null = null

  constructor(private readonly options: OpencodeRunLogWriterOptions) {}

  record(event: unknown): void {
    const { type, data } = (event ?? {}) as ServerEvent
    if (typeof type !== "string" || data === undefined || typeof data.sessionID !== "string") return
    if (type === "session.tool.input.started") {
      if (typeof data.id === "string" && typeof data.name === "string") this.rememberName(data.id, data.name)
      return
    }
    if (type !== "session.text.ended" && type !== "session.tool.called" && type !== "session.tool.failed") return
    const runId = this.options.runIdForSession(data.sessionID)
    if (runId === undefined) {
      if (typeof data.id === "string" && type !== "session.text.ended") this.names.delete(data.id)
      return
    }
    const run = this.bufferFor(runId)
    if (type === "session.text.ended") {
      if (typeof data.text !== "string" || data.text.trim() === "") return
      run.lines.push({ source: "agent", text: boundDiagnostic(data.text.trim()) })
    } else if (typeof data.id === "string") {
      const name = this.names.get(data.id) ?? run.calls.get(data.id) ?? (typeof data.name === "string" ? data.name : undefined)
      if (name === undefined) return
      this.names.delete(data.id)
      if (type === "session.tool.called") {
        if (run.calls.has(data.id)) return
        run.calls.set(data.id, name)
        run.lines.push({ source: "tool", text: boundDiagnostic(toolLine(name, data.input)) })
      } else {
        run.lines.push({ source: "tool", text: `${name} failed` })
      }
    }
    this.schedule()
  }

  flush(): void {
    for (const [runId, run] of this.runs) {
      if (run.lines.length === 0) continue
      const lines = run.lines
      run.lines = []
      try {
        this.options.sink(runId, lines)
      } catch {
        // Best-effort narrative: a store hiccup drops these lines only.
      }
    }
  }

  /** Flush everything and forget per-run state (stream stop). */
  close(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    this.flush()
    this.runs.clear()
    this.names.clear()
  }

  private rememberName(id: string, name: string): void {
    this.names.set(id, name)
    if (this.names.size > 4096) this.names.delete(this.names.keys().next().value!)
  }

  private bufferFor(runId: string): RunBuffer {
    let run = this.runs.get(runId)
    if (run === undefined) {
      run = { lines: [], calls: new Map() }
      this.runs.set(runId, run)
    }
    return run
  }

  private schedule(): void {
    if (this.cancelTimer !== null) return
    const setTimer = this.options.setTimer ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
    this.cancelTimer = setTimer(() => {
      this.cancelTimer = null
      this.flush()
      for (const [runId, run] of this.runs) if (run.lines.length === 0 && run.calls.size > 2048) this.runs.delete(runId)
    }, this.options.flushMs ?? OPENCODE_RUN_LOG_FLUSH_MS)
  }
}

export interface OpencodeEventStreamDeps {
  readonly baseUrl: string
  readonly username?: string
  readonly password: () => string
  readonly onEvent: (event: unknown) => void
  readonly fetch?: (request: Request) => Promise<Response>
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (message: string) => void
}

/**
 * Follows `GET /api/event` (all locations) until stopped, reconnecting
 * with capped backoff. Parsing is line-based SSE: only `data:` frames are
 * read; comments and heartbeats are skipped.
 */
export class OpencodeEventStream {
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private stopped = false
  private wake: (() => void) | null = null

  constructor(private readonly deps: OpencodeEventStreamDeps) {}

  start(): void {
    if (this.running !== null) return
    this.stopped = false
    this.running = this.loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.controller?.abort()
    this.wake?.()
    await this.running
    this.running = null
  }

  private async loop(): Promise<void> {
    const fetchImpl = this.deps.fetch ?? (request => fetch(request))
    const sleep = this.deps.sleep ?? (ms => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      this.wake = () => { clearTimeout(timer); resolve() }
    }))
    let backoff = RECONNECT_MIN_MS
    while (!this.stopped) {
      this.controller = new AbortController()
      let received = false
      try {
        const auth = Buffer.from(`${this.deps.username ?? "opencode"}:${this.deps.password()}`).toString("base64")
        const response = await fetchImpl(new Request(`${this.deps.baseUrl.replace(/\/+$/, "")}/api/event`, {
          headers: { authorization: `Basic ${auth}`, accept: "text/event-stream" },
          signal: this.controller.signal,
        }))
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let pending = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          pending += value
          const lines = pending.split("\n")
          pending = lines.pop()!
          for (const line of lines) {
            if (!line.startsWith("data:")) continue
            received = true
            try {
              this.deps.onEvent(JSON.parse(line.slice(5)))
            } catch {
              // A malformed frame or a throwing consumer drops one event.
            }
          }
        }
      } catch (error) {
        if (this.stopped) break
        this.deps.log?.(`opencode event stream interrupted: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (this.stopped) break
      if (received) backoff = RECONNECT_MIN_MS
      await sleep(backoff)
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }
}
