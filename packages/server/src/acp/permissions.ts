/**
 * Deny-default permission handling (design.md D9, task 3.5).
 *
 * `request_permission` defaults DENY: only a configured supported tool
 * kind can select an offered `allow_once` option; there is no
 * `allow_always` path in configuration (D3's example config note: "the
 * much weaker assurance of agent-owned tools"). Missing kind/context,
 * unknown session, revoked run, malformed option or a bounded timeout
 * all deny/cancel — never grant permanent access, never wait
 * indefinitely.
 */

import type * as schema from "@agentclientprotocol/sdk"

export interface PermissionDecisionContext {
  /** Whether the calling session is still the current, unrevoked
   *  binding for its run — a revoked run's pending permission requests
   *  must deny/cancel, never grant (D9: cancellation during a permission
   *  request resolves cancelled/denied and "cannot later grant
   *  execution"). */
  readonly sessionRevoked: boolean
  /** The operator-configured allowlist of tool KINDS that may receive
   *  an `allow_once` grant (D3 `permissions.allowKinds`). Empty means
   *  deny everything — the example config's intentional default. */
  readonly allowKinds: readonly string[]
}

export type PermissionDecision =
  | { readonly outcome: "selected"; readonly optionId: schema.PermissionOptionId }
  | { readonly outcome: "cancelled" }

/**
 * Decides one `request_permission` call. Pure — no I/O, no clock beyond
 * what the caller (task 3.5's timeout wrapper below) already applies.
 * Only ever returns `{outcome: "selected"}` for an `allow_once` option
 * whose tool `kind` (carried on the request's `toolCall.kind`) is in
 * `allowKinds` — never manufactures an option id, never selects
 * `allow_always`/`reject_always` even if the agent offered one.
 */
export function decidePermission(
  request: schema.RequestPermissionRequest,
  context: PermissionDecisionContext,
): PermissionDecision {
  if (context.sessionRevoked) return { outcome: "cancelled" }
  if (!request || !Array.isArray(request.options) || request.options.length === 0 || !request.toolCall) return { outcome: "cancelled" }
  const toolKind = request.toolCall.kind
  if (toolKind === undefined || toolKind === null) return { outcome: "cancelled" }
  if (!context.allowKinds.includes(toolKind)) return { outcome: "cancelled" }
  const allowOnce = request.options.find(option => option?.kind === "allow_once" && typeof option.optionId === "string" && option.optionId.length > 0)
  if (!allowOnce) return { outcome: "cancelled" }
  return { outcome: "selected", optionId: allowOnce.optionId }
}

/**
 * Bounded wrapper: resolves the pure decision within `timeoutMs`,
 * otherwise cancels — pending permission decisions are BOUNDED, never
 * waiting indefinitely (acp-execution spec: "Pending decisions SHALL be
 * bounded and cancelled during shutdown/cancellation"). `signal` lets a
 * cancellation/pause path force an immediate cancelled decision without
 * waiting for the timeout.
 */
export async function decidePermissionBounded(
  request: schema.RequestPermissionRequest,
  context: PermissionDecisionContext,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<PermissionDecision> {
  if (options.signal?.aborted) return { outcome: "cancelled" }
  return new Promise<PermissionDecision>(resolve => {
    const timer = setTimeout(() => resolve({ outcome: "cancelled" }), options.timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      resolve({ outcome: "cancelled" })
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    // The decision itself is synchronous/pure — resolve immediately
    // once computed, clearing the timer so it never fires late.
    const decision = decidePermission(request, context)
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
    resolve(decision)
  })
}

/** Secret-safe decision record for audit (acp-execution spec: "a
 *  secret-safe decision record is retained") — never includes the raw
 *  `toolCall.rawInput`/`rawOutput`, only identifiers. */
export interface PermissionDecisionRecord {
  readonly sessionId: schema.SessionId
  readonly toolCallId: schema.ToolCallId
  readonly toolKind: string | null
  readonly decision: PermissionDecision
  readonly decidedAt: number
}

export function recordPermissionDecision(
  request: schema.RequestPermissionRequest,
  decision: PermissionDecision,
  nowMs: number,
): PermissionDecisionRecord {
  return {
    sessionId: request.sessionId,
    toolCallId: request.toolCall.toolCallId,
    toolKind: request.toolCall.kind ?? null,
    decision,
    decidedAt: nowMs,
  }
}
