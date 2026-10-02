/**
 * Notification delivery (notifications spec): drains the durable outbox the
 * store fills inside status-changing transactions. Delivery runs outside
 * every engine transaction and never touches pipeline state — a dead
 * channel only ever delays a message.
 */

import { boundDiagnostic } from "@conductor/core"
import type { Clock, Logger } from "./ports.ts"
import type { NotificationKind, NotificationPayload, NotificationRecord, Store } from "./store.ts"

export interface NotificationMessage {
  readonly kind: NotificationKind
  readonly payload: NotificationPayload
  /** Same-kind notifications suppressed by rate limiting since the last delivery. */
  readonly suppressed: number
  readonly link: string | null
}

export interface NotificationChannel {
  readonly id: string
  send(message: NotificationMessage): Promise<void>
}

export interface NotificationDispatcherOptions {
  readonly rateLimitWindowMs?: number
  readonly giveUpAfterMs?: number
  readonly publicBaseUrl?: string
  readonly leaseMs?: number
}

const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60_000
const DEFAULT_GIVE_UP_AFTER_MS = 24 * 60 * 60_000
const DEFAULT_LEASE_MS = 60_000
const RETRY_INITIAL_MS = 10_000
const RETRY_MAX_MS = 10 * 60_000
/** Never rate limited: the operator needs to know trouble is over / work is finished. */
const UNSUPPRESSIBLE: ReadonlySet<NotificationKind> = new Set(["recovered", "done", "test"])

export class NotificationDispatcher {
  private readonly channels: ReadonlyMap<string, NotificationChannel>
  private readonly rateLimitWindowMs: number
  private readonly giveUpAfterMs: number
  private readonly leaseMs: number
  private draining: Promise<void> | null = null

  constructor(
    private readonly deps: { readonly store: Store; readonly clock: Clock; readonly log: Logger },
    channels: readonly NotificationChannel[],
    private readonly options: NotificationDispatcherOptions = {},
  ) {
    this.channels = new Map(channels.map(channel => [channel.id, channel]))
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
    this.giveUpAfterMs = options.giveUpAfterMs ?? DEFAULT_GIVE_UP_AFTER_MS
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  }

  /** One pass over due rows. Concurrent calls share the in-flight pass. */
  drain(): Promise<void> {
    if (!this.draining) this.draining = this.drainOnce().finally(() => { this.draining = null })
    return this.draining
  }

  private async drainOnce(): Promise<void> {
    const { store, clock } = this.deps
    store.releaseExpiredNotificationClaims(clock.now())
    for (const due of store.listDueNotifications(clock.now())) {
      const claimed = store.claimNotification(due.id, clock.now(), this.leaseMs)
      if (claimed) await this.deliver(claimed)
    }
  }

  private async deliver(record: NotificationRecord): Promise<void> {
    const { store, clock, log } = this.deps
    const channel = this.channels.get(record.channel)
    if (!channel) {
      store.markNotificationFailed(record.id, clock.now(), `channel "${record.channel}" is not configured`, null)
      return
    }
    if (!UNSUPPRESSIBLE.has(record.kind)) {
      const lastSent = store.lastSentNotificationAt(record.featureId, record.kind, record.channel)
      if (lastSent !== null && clock.now() - lastSent < this.rateLimitWindowMs) {
        store.markNotificationSuppressed(record.id, clock.now())
        return
      }
    }
    try {
      await channel.send(this.message(record))
      store.markNotificationSent(record.id, clock.now())
    } catch (error) {
      const reason = boundDiagnostic(error instanceof Error ? error.message : String(error))
      const age = clock.now() - record.createdAt
      const delay = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.max(0, record.attempts - 1))
      const retryAt = age + delay > this.giveUpAfterMs ? null : clock.now() + delay
      store.markNotificationFailed(record.id, clock.now(), reason, retryAt)
      log.log(`notification ${record.kind} → ${record.channel} failed${retryAt === null ? " permanently" : ""}: ${reason}`)
    }
  }

  private message(record: NotificationRecord): NotificationMessage {
    const base = this.options.publicBaseUrl?.replace(/\/+$/, "")
    return {
      kind: record.kind,
      payload: record.payload,
      suppressed: record.featureId === "" ? 0 : this.deps.store.countSuppressedSinceLastSent(record.featureId, record.channel),
      link: base && record.featureId !== "" ? `${base}/features/${encodeURIComponent(record.featureId)}` : null,
    }
  }

  /** Synchronous end-to-end channel check (CLI `notify test`). */
  async test(): Promise<readonly { readonly channel: string; readonly ok: boolean; readonly error?: string }[]> {
    const results: { channel: string; ok: boolean; error?: string }[] = []
    for (const channel of this.channels.values()) {
      const id = this.deps.store.recordTestNotification(channel.id)
      const record = this.deps.store.getNotification(id)!
      try {
        await channel.send(this.message(record))
        this.deps.store.markNotificationSent(id, this.deps.clock.now())
        results.push({ channel: channel.id, ok: true })
      } catch (error) {
        const reason = boundDiagnostic(error instanceof Error ? error.message : String(error))
        this.deps.store.markNotificationFailed(id, this.deps.clock.now(), reason, null)
        results.push({ channel: channel.id, ok: false, error: reason })
      }
    }
    return results
  }
}

// ------------------------------------------------------------------ telegram

export interface TelegramChannelConfig {
  readonly id?: string
  readonly chatId: string
  readonly token: string
  readonly timeoutMs?: number
  readonly apiBase?: string
  readonly fetch?: typeof fetch
}

const KIND_LABEL: Record<NotificationKind, string> = {
  attention: "attention",
  recovered: "recovered",
  escalated: "escalated",
  waiting_human: "waiting for you",
  done: "done",
  test: "test",
}

export function formatNotificationText(message: NotificationMessage): string {
  const { payload } = message
  if (message.kind === "test") return "<b>[test]</b> Conductor notifications are configured correctly."
  const lines = [`<b>[${KIND_LABEL[message.kind]}]</b> ${escapeHtml(payload.title)}`]
  const targets = payload.targets?.map(target => `${target.jobId}/${target.stepId}`).join(", ")
  if (targets) lines.push(`step: <code>${escapeHtml(targets)}</code>`)
  if (message.kind === "attention" && payload.consecutiveFailures !== undefined) {
    const next = typeof payload.nextAttemptAt === "number" ? `; next attempt ${new Date(payload.nextAttemptAt).toISOString().slice(11, 16)} UTC` : ""
    lines.push(`${payload.consecutiveFailures} consecutive failures, still retrying${next}`)
  }
  if (payload.diagnostic) lines.push(escapeHtml(truncate(payload.diagnostic, 600)))
  if (message.suppressed > 0) lines.push(`(${message.suppressed} similar suppressed)`)
  if (message.link) lines.push(`<a href="${escapeHtml(message.link)}">open</a>`)
  return lines.join("\n")
}

export function createTelegramChannel(config: TelegramChannelConfig): NotificationChannel {
  const doFetch = config.fetch ?? fetch
  const apiBase = (config.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "")
  const redact = (text: string) => text.split(config.token).join("<redacted>")
  return {
    id: config.id ?? "telegram",
    async send(message) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000)
      try {
        const response = await doFetch(`${apiBase}/bot${config.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: config.chatId,
            text: formatNotificationText(message),
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const body = await response.text().catch(() => "")
          throw new Error(`telegram sendMessage HTTP ${response.status}: ${truncate(body, 300)}`)
        }
      } catch (error) {
        throw new Error(redact(error instanceof Error ? error.message : String(error)))
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
