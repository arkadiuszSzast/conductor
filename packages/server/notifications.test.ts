import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { NotificationDispatcher, createTelegramChannel, formatNotificationText, type NotificationChannel, type NotificationMessage } from "./src/notifications.ts"

let directory: string
let connection: DatabaseConnection
let store: Store
let now = 1_000_000
const clock = { now: () => now }
const log = { log: () => {} }

class StubChannel implements NotificationChannel {
  readonly id = "telegram"
  sent: NotificationMessage[] = []
  failWith: Error | null = null
  async send(message: NotificationMessage): Promise<void> {
    if (this.failWith) throw this.failWith
    this.sent.push(message)
  }
}

beforeEach(() => {
  now = 1_000_000
  directory = mkdtempSync(join(tmpdir(), "conductor-notify-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db, clock)
  store.configureNotifications([{ id: "telegram" }])
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function feature(): string {
  return store.createFeature({ title: "Server Settled Masterwork Work", slug: "ssmw", projectDir: "/p", workflow: "w" }).id
}

const attention = (featureId: string) => store.upsertAttention({ featureId, jobId: "review", stepId: "review", source: "healing", consecutiveFailures: 3, lastDiagnostic: "session/new lost", nextAttemptAt: now + 60_000 })

describe("NotificationDispatcher", () => {
  it("delivers due notifications once and marks them sent", async () => {
    const channel = new StubChannel()
    const dispatcher = new NotificationDispatcher({ store, clock, log }, [channel], { publicBaseUrl: "https://c.example/" })
    const id = feature()
    store.markEscalated(id, "stuck")
    await dispatcher.drain()
    await dispatcher.drain()
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]?.link).toBe(`https://c.example/features/${id}`)
    expect(store.listNotifications(id)[0]?.status).toBe("sent")
  })

  it("suppresses a flapping attention within the window but always delivers recovered, folding the count", async () => {
    const channel = new StubChannel()
    const dispatcher = new NotificationDispatcher({ store, clock, log }, [channel], { rateLimitWindowMs: 15 * 60_000 })
    const id = feature()
    attention(id)
    await dispatcher.drain()
    store.clearAttention(id, "review", "review", true)
    await dispatcher.drain()
    now += 60_000
    attention(id)
    await dispatcher.drain()
    expect(channel.sent.map(m => m.kind)).toEqual(["attention", "recovered"])
    store.clearAttention(id, "review", "review", true)
    await dispatcher.drain()
    expect(channel.sent.map(m => m.kind)).toEqual(["attention", "recovered", "recovered"])
    expect(channel.sent[2]?.suppressed).toBe(1)
    now += 15 * 60_000
    attention(id)
    await dispatcher.drain()
    expect(channel.sent.at(-1)?.kind).toBe("attention")
  })

  it("retries a failing channel with backoff and gives up after the bound, never touching feature state", async () => {
    const channel = new StubChannel()
    channel.failWith = new Error("ECONNREFUSED")
    const dispatcher = new NotificationDispatcher({ store, clock, log }, [channel], { giveUpAfterMs: 60_000 })
    const id = feature()
    store.markEscalated(id, "stuck")
    const statusBefore = store.getFeature(id)?.status
    await dispatcher.drain()
    let [row] = store.listNotifications(id)
    expect(row?.status).toBe("pending")
    expect(row?.nextAttemptAt).toBe(now + 10_000)
    now += 10_000
    await dispatcher.drain()
    ;[row] = store.listNotifications(id)
    expect(row?.nextAttemptAt).toBe(now + 20_000)
    now += 50_000
    await dispatcher.drain()
    ;[row] = store.listNotifications(id)
    expect(row?.status).toBe("failed")
    expect(store.getFeature(id)?.status).toBe(statusBefore)
    channel.failWith = null
    await dispatcher.drain()
    expect(channel.sent).toHaveLength(0)
  })

  it("test() sends synchronously and reports per-channel results", async () => {
    const good = new StubChannel()
    const bad: NotificationChannel = { id: "other", send: async () => { throw new Error("HTTP 401") } }
    const dispatcher = new NotificationDispatcher({ store, clock, log }, [good, bad])
    expect(await dispatcher.test()).toEqual([{ channel: "telegram", ok: true }, { channel: "other", ok: false, error: "HTTP 401" }])
    expect(good.sent[0]?.kind).toBe("test")
  })
})

describe("telegram channel", () => {
  it("posts HTML-escaped text to the bot API", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const channel = createTelegramChannel({
      chatId: "-100", token: "123:SECRET",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) })
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    await channel.send({
      kind: "attention",
      payload: { kind: "attention", featureId: "f", title: "A <b> & c", slug: "s", projectDir: "/p", at: 0, targets: [{ jobId: "j", stepId: "s" }], consecutiveFailures: 3, nextAttemptAt: 0, diagnostic: "x < y" },
      suppressed: 0,
      link: null,
    })
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage")
    expect(calls[0]?.body).toMatchObject({ chat_id: "-100", parse_mode: "HTML" })
    expect(String(calls[0]?.body["text"])).toContain("A &lt;b&gt; &amp; c")
    expect(String(calls[0]?.body["text"])).toContain("3 consecutive failures, still retrying; next attempt 00:00 UTC")
  })

  it("never leaks the bot token in errors", async () => {
    const channel = createTelegramChannel({
      chatId: "-100", token: "123:SECRET",
      fetch: (async () => { throw new Error("connect failed for https://api.telegram.org/bot123:SECRET/sendMessage") }) as unknown as typeof fetch,
    })
    const error = await channel.send({ kind: "test", payload: { kind: "test", featureId: "", title: "t", slug: "t", projectDir: "", at: 0 }, suppressed: 0, link: null }).catch(e => e as Error)
    expect(String(error)).not.toContain("SECRET")
    expect(String(error)).toContain("<redacted>")
  })

  it("reports non-2xx responses with the status", async () => {
    const channel = createTelegramChannel({ chatId: "1", token: "t0k", fetch: (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch })
    await expect(channel.send({ kind: "test", payload: { kind: "test", featureId: "", title: "t", slug: "t", projectDir: "", at: 0 }, suppressed: 0, link: null })).rejects.toThrow("HTTP 401")
  })

  it("formats escalations with diagnostic and suppression count", () => {
    const text = formatNotificationText({
      kind: "escalated",
      payload: { kind: "escalated", featureId: "f", title: "T", slug: "s", projectDir: "/p", at: 0, diagnostic: "ACP create outcome unknown" },
      suppressed: 2,
      link: "https://c/features/f",
    })
    expect(text).toBe('<b>[escalated]</b> T\nACP create outcome unknown\n(2 similar suppressed)\n<a href="https://c/features/f">open</a>')
  })
})
