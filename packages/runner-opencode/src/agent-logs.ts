/**
 * Agent-log capture for the opencode adapter — turns session message-part
 * events into per-run log chunks pushed to the daemon's log route.
 *
 * Two kinds of lines:
 *  - `source: "agent"` — the agent's narrative text, coalesced per
 *    debounce window so a chatty stream reads as one line of progress.
 *  - `source: "tool"` — one compact line per tool invocation
 *    ("running command — git diff main...HEAD"), emitted once per part
 *    id the moment the input is known. Tool lines keep the activity
 *    clock honest for tool-heavy agents (a reviewer can run for an hour
 *    without emitting a single text part) and give the UI a live "what
 *    is it doing" status; the UI collapses consecutive tool lines into
 *    a single dimmed status so they never drown the narrative.
 *
 * The push is best-effort by design: a failed or rejected flush is logged
 * and dropped — it must never fail, block or conclude a run. The outcome
 * protocol (report) stays the authoritative channel. Deduping by part id
 * absorbs re-sent snapshots; the per-run buffer coalesces a chatty
 * session into at most one HTTP request per debounce window.
 *
 * The event shape is narrowed structurally (same pattern as
 * `RawOpencodeSessionApi`) so SDK type drift degrades to "no logs for
 * that event", never a crash, and this module stays testable against a
 * socketless ApiClient.
 */

import type { ApiClient } from "@conductor/cli"

export const AGENT_LOG_DEBOUNCE_MS = 1_000

/** Compact, human phrase per tool — the OpenChamber status vocabulary. */
const TOOL_PHRASES: Record<string, string> = {
  read: "reading file",
  write: "writing file",
  edit: "editing file",
  multiedit: "editing files",
  apply_patch: "applying patch",
  bash: "running command",
  grep: "searching content",
  glob: "finding files",
  list: "listing directory",
  task: "delegating task",
  webfetch: "fetching URL",
  websearch: "searching web",
  todowrite: "updating todos",
  todoread: "reading todos",
  skill: "loading skill",
  question: "asking question",
}

const TOOL_DETAIL_LIMIT = 160

interface PartSnapshot {
  readonly sessionID?: string
  readonly id?: string
  readonly type?: string
  readonly text?: string
  readonly tool?: string
  readonly state?: { readonly status?: string; readonly input?: Readonly<Record<string, unknown>> }
}

interface BufferedLine {
  readonly source: "agent" | "tool"
  readonly text: string
}

interface RunAccumulator {
  parts: Map<string, { lastLen: number }>
  /** Tool part ids already emitted — one line per invocation, ever. */
  toolParts: Set<string>
  buffered: BufferedLine[]
}

export interface AgentLogPusherDeps {
  readonly client: ApiClient
  /** sessionID → run id; absent (parent/foreign sessions) → no push. */
  readonly runIdForSession: (sessionID: string) => string | undefined
  readonly debounceMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (message: string) => void
}

export interface AgentLogPusher {
  /** Feed one raw event; extract message.part.updated text and schedule a flush. */
  push(event: unknown): void
  /** Flush every buffered run now (session idle, shutdown). Best-effort. */
  flush(): Promise<void>
}

/** The most salient input argument for a tool, for the detail suffix. */
function toolDetail(tool: string, input: Readonly<Record<string, unknown>> | undefined): string {
  if (!input) return ""
  const candidates: unknown[] = [
    input["command"],
    input["pattern"],
    input["filePath"],
    input["path"],
    input["url"],
    input["description"],
    input["name"],
  ]
  const found = candidates.find(value => typeof value === "string" && value !== "")
  if (typeof found !== "string") return ""
  const flattened = found.replace(/\s+/g, " ").trim()
  return flattened.length > TOOL_DETAIL_LIMIT ? `${flattened.slice(0, TOOL_DETAIL_LIMIT)}…` : flattened
}

function toolLine(part: PartSnapshot): string {
  const tool = typeof part.tool === "string" && part.tool !== "" ? part.tool : "tool"
  const phrase = TOOL_PHRASES[tool] ?? `using ${tool}`
  const detail = toolDetail(tool, part.state?.input)
  return detail === "" ? phrase : `${phrase} — ${detail}`
}

export function createAgentLogPusher(deps: AgentLogPusherDeps): AgentLogPusher {
  const debounceMs = deps.debounceMs ?? AGENT_LOG_DEBOUNCE_MS
  const sleep = deps.sleep ?? (async (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const log = deps.log ?? (() => {})
  const runs = new Map<string, RunAccumulator>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  let dirty = false

  const runFor = (sessionID: string): RunAccumulator | undefined => {
    const runId = deps.runIdForSession(sessionID)
    if (runId === undefined) return undefined
    let run = runs.get(runId)
    if (!run) {
      run = { parts: new Map(), toolParts: new Set(), buffered: [] }
      runs.set(runId, run)
    }
    return run
  }

  const ingestText = (run: RunAccumulator, part: PartSnapshot): void => {
    if (part.id === undefined || typeof part.text !== "string") return
    const previousLen = run.parts.get(part.id)?.lastLen ?? 0
    if (part.text.length <= previousLen) return
    run.parts.set(part.id, { lastLen: part.text.length })
    const added = part.text.slice(previousLen)
    if (added !== "") run.buffered.push({ source: "agent", text: added })
  }

  const ingestTool = (run: RunAccumulator, part: PartSnapshot): void => {
    if (part.id === undefined) return
    // One line per invocation: emit the first time the input is present
    // (opencode re-sends the part on every state transition — pending →
    // running → completed — with a stable id).
    if (run.toolParts.has(part.id)) return
    if (part.state?.input === undefined || Object.keys(part.state.input).length === 0) return
    run.toolParts.add(part.id)
    run.buffered.push({ source: "tool", text: toolLine(part) })
  }

  const schedule = (): void => {
    dirty = true
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, debounceMs)
  }

  const flush = async (): Promise<void> => {
    if (flushing) return
    if (!dirty && runs.size === 0) return
    flushing = true
    try {
      for (const [runId, run] of runs) {
        if (run.buffered.length === 0) continue
        // Coalesce ADJACENT agent-text fragments into one line per flush
        // window; tool lines stay individual (the UI collapses them at
        // render time), and ordering between narrative and tools is
        // preserved.
        const lines: { text: string; source: "agent" | "tool" }[] = []
        for (const entry of run.buffered) {
          const last = lines[lines.length - 1]
          if (entry.source === "agent" && last?.source === "agent") last.text += entry.text
          else lines.push({ text: entry.text, source: entry.source })
        }
        run.buffered = []
        try {
          await deps.client.appendRunLogs(runId, lines)
        } catch (err) {
          // A concluded run rejects late flushes with 409 — drop the
          // buffer and stop tracking it. Any other failure is a
          // best-effort loss: log and keep the run tracked for later.
          const status = err instanceof Error && "status" in err ? (err as { status: number }).status : undefined
          if (status === 409) {
            runs.delete(runId)
            log(`agent log push for run ${runId} dropped (concluded): ${err instanceof Error ? err.message : String(err)}`)
          } else {
            log(`agent log push for run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      dirty = false
    } finally {
      flushing = false
    }
  }

  return {
    push(event: unknown): void {
      const e = event as {
        type?: string
        properties?: {
          sessionID?: string
          part?: PartSnapshot
        }
      }
      if (e.type !== "message.part.updated") return
      const sessionID = e.properties?.sessionID
      const part = e.properties?.part
      if (sessionID === undefined || part === undefined) return
      if (part.type !== "text" && part.type !== "tool") return
      const run = runFor(sessionID)
      if (!run) return
      if (part.type === "text") ingestText(run, part)
      else ingestTool(run, part)
      schedule()
    },
    async flush(): Promise<void> {
      await sleep(0)
      await flush()
    },
  }
}
