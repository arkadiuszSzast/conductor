/**
 * Allowlisted structured activity + bounded sanitized diagnostics
 * (design.md D9, task 3.6). The ACP adapter NEVER persists raw JSON-RPC
 * frames, MCP env, tool arguments, provider error bodies or thought
 * chunks (acp-execution spec: "Logs SHALL exclude raw protocol frames,
 * MCP credentials, tool arguments and thought content"). Every sink this
 * module feeds (run_log, structured diagnostics on operations/fences)
 * goes through `summarizeSessionUpdate`/`boundAndRedact` first.
 */

import { boundDiagnostic } from "@conductor/core"
import type * as schema from "@agentclientprotocol/sdk"

/** Per-diagnostic-string bound, independent of `boundDiagnostic`'s own
 *  4000-char default — kept smaller here since MANY of these can
 *  accumulate per turn (one per session/update notification) and this
 *  module's caller decides how many to keep, not how long each one is. */
const MAX_SUMMARY_LENGTH = 500

/** A safe, allowlisted structured summary of one `session/update`
 *  notification — method/kind identifiers and bounded sanitized text
 *  only, never the raw notification object (which can carry
 *  `rawInput`/`rawOutput` tool payloads, arbitrary thought content, or
 *  an embedded resource's full bytes). */
export interface SessionActivitySummary {
  readonly kind: schema.SessionUpdate["sessionUpdate"]
  /** Present only for content-chunk kinds where text is genuinely safe
   *  to surface (`agent_message_chunk`, `user_message_chunk`) — NEVER
   *  for `agent_thought_chunk` (acp-execution spec explicitly excludes
   *  "thought content" from diagnostics, even though the protocol
   *  itself calls it a content chunk like the others). */
  readonly text?: string
  /** Present for tool-call kinds — the tool's declared `kind`/`status`,
   *  never its `rawInput`/`rawOutput`. */
  readonly toolKind?: string
  readonly toolStatus?: string
}

function isTextContent(content: schema.ContentBlock): content is schema.ContentBlock & { type: "text"; text: string } {
  return content.type === "text"
}

/**
 * Maps one `SessionUpdate` to its allowlisted summary. Anything not
 * explicitly handled here (including any future protocol addition) maps
 * to a bare `{kind}` with no text — fail-closed by construction: an
 * unrecognized update kind can never accidentally leak its raw payload
 * just because a new `case` was not added.
 */
export function summarizeSessionUpdate(update: schema.SessionUpdate): SessionActivitySummary {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "user_message_chunk": {
      const text = isTextContent(update.content) ? update.content.text : `[${update.content.type}]`
      return { kind: update.sessionUpdate, text: boundAndRedact(text) }
    }
    case "agent_thought_chunk":
      // Thought content is deliberately excluded (acp-execution spec) —
      // record only that a thought occurred, never its content.
      return { kind: update.sessionUpdate }
    case "tool_call":
    case "tool_call_update":
      return {
        kind: update.sessionUpdate,
        ...(update.kind !== undefined && update.kind !== null ? { toolKind: update.kind } : {}),
        ...(update.status !== undefined && update.status !== null ? { toolStatus: update.status } : {}),
      }
    default:
      return { kind: update.sessionUpdate }
  }
}

/** Redacts common credential shapes THEN bounds length — reuses the
 *  core's own `boundDiagnostic` (secret-safe order: redact, then
 *  truncate) but at this module's smaller per-line bound. */
export function boundAndRedact(text: string): string {
  const bounded = boundDiagnostic(text)
  return bounded.length > MAX_SUMMARY_LENGTH ? bounded.slice(0, MAX_SUMMARY_LENGTH) : bounded
}

/** Bounded ring buffer of recent sanitized activity summaries — the
 *  adapter's own "fragmented output floods stay bounded" guard (never
 *  an unbounded array growing for a multi-hour turn). */
export class BoundedActivityLog {
  private readonly entries: SessionActivitySummary[] = []

  constructor(private readonly capacity: number = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer")
  }

  record(update: schema.SessionUpdate): SessionActivitySummary {
    const summary = summarizeSessionUpdate(update)
    this.entries.push(summary)
    if (this.entries.length > this.capacity) this.entries.shift()
    return summary
  }

  list(): readonly SessionActivitySummary[] {
    return this.entries
  }
}

/**
 * Sanitizes a bounded stderr tail before it is ever exposed as a
 * diagnostic — the SAME secret-safe discipline the rest of the codebase
 * applies to command/action output, extended here to a spawned ACP
 * agent's stderr stream (which can echo a failed provider request body
 * carrying a credential, exactly like `classifyThrownBoundary`'s
 * upstream-error doc comment already anticipates for other adapters).
 */
export function sanitizeStderrTail(raw: string): string {
  return boundAndRedact(raw)
}
