import { describe, expect, it } from "bun:test"
import type * as schema from "@agentclientprotocol/sdk"
import { AcpRunLogWriter, toolPhrase, type AcpRunLogLine } from "./src/acp/run-log.ts"

function harness() {
  const written: { runId: string; lines: readonly AcpRunLogLine[] }[] = []
  let pending: (() => void) | null = null
  const writer = new AcpRunLogWriter({
    sink: (runId, lines) => written.push({ runId, lines }),
    setTimer: callback => {
      pending = callback
      return () => { pending = null }
    },
  })
  const tick = () => { const cb = pending; pending = null; cb?.() }
  return { writer, written, tick }
}

const text = (t: string): schema.SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } })

describe("AcpRunLogWriter", () => {
  it("coalesces adjacent agent chunks into one line per flush window", () => {
    const { writer, written, tick } = harness()
    writer.record("r1", text("Hello "))
    writer.record("r1", text("world"))
    expect(written).toHaveLength(0)
    tick()
    expect(written).toEqual([{ runId: "r1", lines: [{ source: "agent", text: "Hello world" }] }])
  })

  it("emits one tool line per toolCallId from the declared kind only", () => {
    const { writer, written, tick } = harness()
    writer.record("r1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "cat /secret/path", kind: "execute", rawInput: { cmd: "x" } })
    writer.record("r1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" })
    writer.record("r1", text("done"))
    tick()
    expect(written[0]!.lines).toEqual([
      { source: "tool", text: "running command" },
      { source: "agent", text: "done" },
    ])
    expect(JSON.stringify(written)).not.toContain("secret")
  })

  it("never writes thought content and redacts credentials in agent text", () => {
    const { writer, written, tick } = harness()
    writer.record("r1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } })
    writer.record("r1", text("token Bearer abc.def"))
    tick()
    expect(JSON.stringify(written)).not.toContain("private thought")
    expect(JSON.stringify(written)).not.toContain("abc.def")
  })

  it("flush and release drain immediately; a throwing sink is swallowed", () => {
    const writer = new AcpRunLogWriter({ sink: () => { throw new Error("db down") }, setTimer: () => () => {} })
    writer.record("r1", text("x"))
    expect(() => writer.release("r1")).not.toThrow()
  })

  it("maps unknown tool kinds to a generic phrase", () => {
    expect(toolPhrase("other")).toBe("using tool")
    expect(toolPhrase(undefined)).toBe("using tool")
    expect(toolPhrase("read")).toBe("reading file")
  })
})
