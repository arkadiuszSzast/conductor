/**
 * Bridge envelope parsing/encoding — pure, DOM-free (plugin-panels spec:
 * "Messages with an unknown version or malformed shape SHALL be
 * ignored"). DOM-dependent wiring (`usePluginBridge`'s origin/source
 * filtering) is covered by the mounted test.
 */
import { describe, expect, it } from "bun:test"
import { BRIDGE_VERSION, encodeHostMessage, parsePanelMessage } from "../src/plugins/bridge.ts"

describe("parsePanelMessage", () => {
  it("parses a valid ready message", () => {
    const message = parsePanelMessage({ conductor: true, v: 1, type: "ready", payload: { v: 1 } })
    expect(message).toEqual({ type: "ready", payload: { v: 1 } })
  })

  it("parses a valid navigate message with a feature target", () => {
    const message = parsePanelMessage({ conductor: true, v: 1, type: "navigate", payload: { to: { feature: "f-1" } } })
    expect(message).toEqual({ type: "navigate", payload: { to: { feature: "f-1" } } })
  })

  it("parses a valid refresh message", () => {
    const message = parsePanelMessage({ conductor: true, v: 1, type: "refresh", payload: {} })
    expect(message).toEqual({ type: "refresh", payload: {} })
  })

  it("drops a message missing the conductor discriminator", () => {
    expect(parsePanelMessage({ v: 1, type: "ready", payload: { v: 1 } })).toBeNull()
  })

  it("drops a message with an unsupported version", () => {
    expect(parsePanelMessage({ conductor: true, v: 2, type: "ready", payload: { v: 2 } })).toBeNull()
  })

  it("drops a message with an unknown type", () => {
    expect(parsePanelMessage({ conductor: true, v: 1, type: "eval", payload: { code: "alert(1)" } })).toBeNull()
  })

  it("drops a navigate message with a malformed payload shape", () => {
    expect(parsePanelMessage({ conductor: true, v: 1, type: "navigate", payload: { to: "not-an-object" } })).toBeNull()
    expect(parsePanelMessage({ conductor: true, v: 1, type: "navigate", payload: {} })).toBeNull()
  })

  it("drops non-object data entirely", () => {
    expect(parsePanelMessage(null)).toBeNull()
    expect(parsePanelMessage("a string")).toBeNull()
    expect(parsePanelMessage(42)).toBeNull()
  })

  it("drops a ready message whose payload lacks a numeric v", () => {
    expect(parsePanelMessage({ conductor: true, v: 1, type: "ready", payload: {} })).toBeNull()
  })
})

describe("encodeHostMessage", () => {
  it("wraps a context message in the versioned envelope, never carrying a token field", () => {
    const envelope = encodeHostMessage({
      type: "context",
      payload: { project: "/proj/a", selection: { feature: "f-1" }, theme: { mode: "dark" } },
    })
    expect(envelope).toEqual({
      conductor: true,
      v: BRIDGE_VERSION,
      type: "context",
      payload: { project: "/proj/a", selection: { feature: "f-1" }, theme: { mode: "dark" } },
    })
    expect(JSON.stringify(envelope)).not.toContain("token")
  })

  it("wraps a context-changed message identically to context", () => {
    const payload = { project: null, selection: { feature: null }, theme: { mode: "dark" as const } }
    const envelope = encodeHostMessage({ type: "context-changed", payload })
    expect(envelope.type).toBe("context-changed")
    expect(envelope.payload).toEqual(payload)
  })
})
