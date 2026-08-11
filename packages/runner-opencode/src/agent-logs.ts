/**
 * Agent-log capture for the opencode adapter — turns session message-part
 * events into per-run `source: "agent"` chunks pushed to the daemon's
 * log route.
 *
 * The push is best-effort by design: a failed or rejected flush is logged
 * and dropped — it must never fail, block or conclude a run. The outcome
 * protocol (report) stays the authoritative channel. Deduping by part id
 * + text length absorbs re-sent snapshots; the per-run buffer coalesces a
 * chatty session into at most one HTTP request per debounce window.
 *
 * The event shape is narrowed structurally (same pattern as
 * `RawOpencodeSessionApi`) so SDK type drift degrades to "no logs for
 * that event", never a crash, and this module stays testable against a
 * socketless ApiClient.
 */

import type { ApiClient } from "@conductor/cli"

export const AGENT_LOG_DEBOUNCE_MS = 1_000

interface TextPartSnapshot {
  readonly sessionID?: string
  readonly id?: string
  readonly type?: string
  readonly text?: string
}

interface RunAccumulator {
  parts: Map<string, { lastLen: number; text: string }>
  buffered: string[]
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
      run = { parts: new Map(), buffered: [] }
      runs.set(runId, run)
    }
    return run
  }

  const ingestText = (run: RunAccumulator, part: TextPartSnapshot): void => {
    if (part.id === undefined || typeof part.text !== "string") return
    const previousLen = run.parts.get(part.id)?.lastLen ?? 0
    if (part.text.length <= previousLen) return
    run.parts.set(part.id, { lastLen: part.text.length, text: part.text })
    const added = part.text.slice(previousLen)
    if (added !== "") run.buffered.push(added)
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
        // One log line per flush window: the debounce turns a chatty
        // stream into roughly one "line of progress" per second, and the
        // UI's tail reads as a narrative rather than token fragments.
        const text = run.buffered.join("")
        run.buffered = []
        try {
          await deps.client.appendRunLogs(runId, [{ text, source: "agent" }])
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
          part?: TextPartSnapshot
        }
      }
      if (e.type !== "message.part.updated") return
      const sessionID = e.properties?.sessionID
      const part = e.properties?.part
      if (sessionID === undefined || part === undefined || part.type !== "text") return
      const run = runFor(sessionID)
      if (!run) return
      ingestText(run, part)
      schedule()
    },
    async flush(): Promise<void> {
      await sleep(0)
      await flush()
    },
  }
}
