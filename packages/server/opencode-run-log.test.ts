import { describe, expect, it } from "bun:test"
import { OpencodeEventStream, OpencodeRunLogWriter, toolLine, type OpencodeRunLogLine } from "./src/opencode/run-log.ts"

function harness(bound: Record<string, string> = { ses_a: "r1" }) {
  const written: { runId: string; lines: readonly OpencodeRunLogLine[] }[] = []
  let pending: (() => void) | null = null
  const writer = new OpencodeRunLogWriter({
    sink: (runId, lines) => written.push({ runId, lines }),
    runIdForSession: id => bound[id],
    setTimer: callback => {
      pending = callback
      return () => { pending = null }
    },
  })
  const tick = () => { const cb = pending; pending = null; cb?.() }
  return { writer, written, tick }
}

const started = (sessionID: string, id: string, name: string) => ({ type: "session.tool.input.started", data: { sessionID, id, name } })
const called = (sessionID: string, id: string, input: unknown) => ({ type: "session.tool.called", data: { sessionID, id, input, executed: false } })
const text = (sessionID: string, t: string) => ({ type: "session.text.ended", data: { sessionID, ordinal: 0, text: t } })

describe("OpencodeRunLogWriter", () => {
  it("writes finished text parts as agent lines and tool calls as tool lines, in order", () => {
    const { writer, written, tick } = harness()
    writer.record(text("ses_a", "Looking at the standings model."))
    writer.record(started("ses_a", "t1", "read"))
    writer.record(called("ses_a", "t1", { path: "/repo/app/src/Standings.kt" }))
    writer.record({ type: "session.tool.success", data: { sessionID: "ses_a", id: "t1" } })
    expect(written).toHaveLength(0)
    tick()
    expect(written).toEqual([{ runId: "r1", lines: [
      { source: "agent", text: "Looking at the standings model." },
      { source: "tool", text: "reading Standings.kt" },
    ] }])
  })

  it("ignores text deltas and sessions without a running bound attempt", () => {
    const { writer, written, tick } = harness()
    writer.record({ type: "session.text.delta", data: { sessionID: "ses_a", delta: "Hel" } })
    writer.record(text("ses_root", "root chatter"))
    writer.record(started("ses_root", "t9", "shell"))
    writer.record(called("ses_root", "t9", { command: "ls" }))
    tick()
    expect(written).toHaveLength(0)
  })

  it("emits one line per call id and a failure line on session.tool.failed", () => {
    const { writer, written, tick } = harness()
    writer.record(started("ses_a", "t1", "shell"))
    writer.record(called("ses_a", "t1", { command: "cd app && ./gradlew test" }))
    writer.record(called("ses_a", "t1", { command: "cd app && ./gradlew test" }))
    writer.record({ type: "session.tool.failed", data: { sessionID: "ses_a", id: "t1" } })
    tick()
    expect(written[0]!.lines).toEqual([
      { source: "tool", text: "running gradlew" },
      { source: "tool", text: "shell failed" },
    ])
  })

  it("keeps tool arguments out of the log beyond a curated target", () => {
    expect(toolLine("shell", { command: "FOO=1 curl -H 'Authorization: Bearer abc' https://x" })).toBe("running curl")
    expect(toolLine("write", { path: "/repo/secrets/key.txt", content: "s3cret" })).toBe("writing key.txt")
    expect(toolLine("lsp", { operation: "findReferences", path: "/r/A.kt", line: 3 })).toBe("lsp findReferences A.kt")
    expect(toolLine("skill", { id: "kotest-patterns" })).toBe("loading skill kotest-patterns")
    expect(toolLine("repowise_get_risk", { targets: ["a"] })).toBe("repowise get_risk")
    expect(toolLine("execute", { code: "await tools.github.get_me({}); await tools.opencode[\"x\"]()" })).toBe("running code-mode tools github.get_me, opencode[\"x\"]")
    expect(toolLine("grep", { pattern: "storedValues" })).toBe("searching \"storedValues\"")
    expect(toolLine("webfetch", { url: "https://example.com/a?token=1" })).toBe("fetching example.com")
    expect(toolLine("mystery", {})).toBe("mystery")
  })

  it("redacts secrets in agent text and survives a throwing sink", () => {
    const written: OpencodeRunLogLine[][] = []
    let calls = 0
    const writer = new OpencodeRunLogWriter({
      runIdForSession: () => "r1",
      sink: (_runId, lines) => { calls++; if (calls === 1) throw new Error("db busy"); written.push([...lines]) },
      setTimer: () => () => {},
    })
    writer.record(text("ses_a", "using Bearer abc.def"))
    writer.flush()
    writer.record(text("ses_a", "password=hunter2 done"))
    writer.flush()
    expect(written).toEqual([[{ source: "agent", text: "password=[REDACTED] done" }]])
  })
})

describe("OpencodeEventStream", () => {
  it("parses data frames, skips comments, and reconnects after the stream ends", async () => {
    const events: unknown[] = []
    const bodies = [
      'data: {"type":"server.connected"}\n\n: heartbeat\n\ndata: {"type":"session.text.ended","data":{"sessionID":"s"}}\n\n',
      'data: {"type":"second"}\n\n',
    ]
    const requests: Request[] = []
    let stream!: OpencodeEventStream
    stream = new OpencodeEventStream({
      baseUrl: "http://srv/",
      password: () => "pw",
      onEvent: event => { events.push(event); if ((event as { type: string }).type === "second") void stream.stop() },
      fetch: async request => {
        requests.push(request)
        const body = bodies.shift() ?? ""
        return new Response(new Blob([body]).stream(), { status: 200 })
      },
      sleep: async () => {},
    })
    stream.start()
    for (let i = 0; i < 50 && events.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 1))
    await stream.stop()
    expect(events.map(e => (e as { type: string }).type)).toEqual(["server.connected", "session.text.ended", "second"])
    expect(requests[0]!.url).toBe("http://srv/api/event")
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`)
  })

  it("backs off and retries after a failed connection", async () => {
    const sleeps: number[] = []
    let attempts = 0
    let stream!: OpencodeEventStream
    stream = new OpencodeEventStream({
      baseUrl: "http://srv",
      password: () => "pw",
      onEvent: () => {},
      fetch: async () => { attempts++; if (attempts >= 3) void stream.stop(); return new Response("nope", { status: 503 }) },
      sleep: async ms => { sleeps.push(ms) },
      log: () => {},
    })
    stream.start()
    for (let i = 0; i < 50 && attempts < 3; i++) await new Promise(resolve => setTimeout(resolve, 1))
    await stream.stop()
    expect(sleeps.slice(0, 2)).toEqual([1000, 2000])
  })
})
