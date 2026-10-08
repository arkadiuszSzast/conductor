/**
 * ACP session output → run log. The native opencode runner pushes agent
 * narrative and tool status lines through the daemon route; an ACP
 * session talks to the daemon directly, so the same two line kinds are
 * produced here from `session/update` notifications:
 *
 *  - `agent` — `agent_message_chunk` text, coalesced per flush window so
 *    a streamed reply reads as one line of progress.
 *  - `tool`  — one compact phrase per `toolCallId`, derived from the
 *    tool's declared `kind` only. Titles and raw input/output can carry
 *    tool arguments, which the acp-execution spec keeps out of logs.
 *
 * Thought chunks are never written. Every agent chunk goes through
 * `boundAndRedact`'s secret patterns before it is buffered. Writes are
 * best-effort: a failing sink must never affect the session or the run.
 */

import type * as schema from "@agentclientprotocol/sdk"
import { boundDiagnostic } from "@conductor/core"

export const ACP_RUN_LOG_FLUSH_MS = 1_000

export interface AcpRunLogLine {
  readonly source: "agent" | "tool"
  readonly text: string
}

export type AcpRunLogSink = (runId: string, lines: readonly AcpRunLogLine[]) => void

const TOOL_KIND_PHRASES: Record<string, string> = {
  read: "reading file",
  edit: "editing file",
  delete: "deleting file",
  move: "moving file",
  search: "searching content",
  execute: "running command",
  think: "thinking",
  fetch: "fetching URL",
  switch_mode: "switching mode",
}

export function toolPhrase(kind: string | null | undefined): string {
  return typeof kind === "string" && Object.hasOwn(TOOL_KIND_PHRASES, kind) ? TOOL_KIND_PHRASES[kind]! : "using tool"
}

interface RunBuffer {
  lines: AcpRunLogLine[]
  toolCalls: Set<string>
}

export interface AcpRunLogWriterOptions {
  readonly sink: AcpRunLogSink
  readonly flushMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => () => void
}

export class AcpRunLogWriter {
  private readonly runs = new Map<string, RunBuffer>()
  private cancelTimer: (() => void) | null = null

  constructor(private readonly options: AcpRunLogWriterOptions) {}

  record(runId: string, update: schema.SessionUpdate): void {
    const line = this.lineFor(runId, update)
    if (line === null) return
    const run = this.bufferFor(runId)
    const last = run.lines[run.lines.length - 1]
    if (line.source === "agent" && last?.source === "agent") run.lines[run.lines.length - 1] = { source: "agent", text: last.text + line.text }
    else run.lines.push(line)
    this.schedule()
  }

  /** Flush every buffered line now (turn settled, session released). */
  flush(runId?: string): void {
    const ids = runId === undefined ? [...this.runs.keys()] : [runId]
    for (const id of ids) {
      const run = this.runs.get(id)
      if (run === undefined || run.lines.length === 0) continue
      const lines = run.lines
      run.lines = []
      try {
        this.options.sink(id, lines)
      } catch {
        // Best-effort narrative: a store hiccup drops these lines only.
      }
    }
  }

  /** Flush and forget a run whose session is gone. */
  release(runId: string): void {
    this.flush(runId)
    this.runs.delete(runId)
  }

  private lineFor(runId: string, update: schema.SessionUpdate): AcpRunLogLine | null {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text" || update.content.text === "") return null
        return { source: "agent", text: boundDiagnostic(update.content.text) }
      }
      case "tool_call":
      case "tool_call_update": {
        const run = this.bufferFor(runId)
        if (run.toolCalls.has(update.toolCallId)) return null
        run.toolCalls.add(update.toolCallId)
        return { source: "tool", text: toolPhrase(update.kind) }
      }
      default:
        return null
    }
  }

  private bufferFor(runId: string): RunBuffer {
    let run = this.runs.get(runId)
    if (run === undefined) {
      run = { lines: [], toolCalls: new Set() }
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
    }, this.options.flushMs ?? ACP_RUN_LOG_FLUSH_MS)
  }
}
