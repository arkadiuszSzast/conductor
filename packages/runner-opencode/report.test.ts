import { describe, expect, it } from "bun:test"
import { ConductorReportPlugin, PLUGIN_ID } from "./src/plugin.ts"
import { UNBOUND_MESSAGE, createReportTools, credentialFromMetadata } from "./src/report.ts"

const bound = { data: { id: "ses_1", metadata: { conductor: { runUrl: "http://127.0.0.1:4400", runId: "run-1", token: "secret-token" } } } }

function harness(metadata: unknown = bound, respond: (url: string, body: unknown) => Response = () => Response.json({ result: "Recorded." })) {
  const calls: { url: string; method: string; auth?: string; body?: unknown }[] = []
  const tools = createReportTools({
    sessionMetadata: async () => metadata,
    newInvocationId: () => "inv-1",
    sleep: async () => {},
    fetch: async (url, init) => {
      const body = init.body !== undefined ? JSON.parse(init.body) as unknown : undefined
      calls.push({ url, method: init.method, ...(init.headers.authorization ? { auth: init.headers.authorization } : {}), ...(body !== undefined ? { body } : {}) })
      return respond(url, body)
    },
  })
  return { tools, calls }
}

describe("credentialFromMetadata", () => {
  it("reads the session-bound credential and normalizes the origin", () => {
    expect(credentialFromMetadata(bound)).toEqual({ runUrl: "http://127.0.0.1:4400", runId: "run-1", token: "secret-token" })
    expect(credentialFromMetadata(bound.data)?.runId).toBe("run-1")
  })

  it("rejects missing, partial or unsafe metadata", () => {
    expect(credentialFromMetadata({ data: { metadata: {} } })).toBeNull()
    expect(credentialFromMetadata(null)).toBeNull()
    expect(credentialFromMetadata({ metadata: { conductor: { runUrl: "http://x", runId: "r" } } })).toBeNull()
    expect(credentialFromMetadata({ metadata: { conductor: { runUrl: "file:///etc", runId: "r", token: "t" } } })).toBeNull()
    expect(credentialFromMetadata({ metadata: { conductor: { runUrl: "http://u:p@x", runId: "r", token: "t" } } })).toBeNull()
  })
})

describe("report tools", () => {
  it("reports with the session credential and never forwards run_id", async () => {
    const { tools, calls } = harness()
    const result = await tools.report({ outcome: "succeeded", notes: "done", run_id: "run-1" }, "ses_1")
    expect(result.content).toBe("Recorded.")
    expect(calls).toEqual([{ url: "http://127.0.0.1:4400/v1/worker/report", method: "POST", auth: "Bearer secret-token", body: { outcome: "succeeded", notes: "done" } }])
  })

  it("rejects a mismatched run_id without contacting the daemon", async () => {
    const { tools, calls } = harness()
    const result = await tools.report({ outcome: "succeeded", run_id: "run-2" }, "ses_1")
    expect(result.metadata?.["error"]).toBe("run_id_mismatch")
    expect(calls).toHaveLength(0)
  })

  it("refuses unbound sessions without contacting the daemon", async () => {
    for (const metadata of [{ data: { metadata: {} } }, null]) {
      const { tools, calls } = harness(metadata)
      expect((await tools.report({ outcome: "succeeded" }, "ses_user")).content).toBe(UNBOUND_MESSAGE)
      expect((await tools.ask({ question: "?" }, "ses_user")).content).toBe(UNBOUND_MESSAGE)
      expect((await tools.status({}, "ses_user")).content).toBe(UNBOUND_MESSAGE)
      expect(calls).toHaveLength(0)
    }
    const failing = createReportTools({ sessionMetadata: async () => { throw new Error("not found") } })
    expect((await failing.report({}, "ses_x")).content).toBe(UNBOUND_MESSAGE)
  })

  it("treats run_already_concluded as already recorded and surfaces other rejections", async () => {
    const concluded = harness(bound, () => Response.json({ error: { code: "run_already_concluded", message: "Run already concluded" } }, { status: 409 }))
    expect((await concluded.tools.report({ outcome: "succeeded" }, "ses_1")).content).toBe("Already reported: Run already concluded")
    const invalid = harness(bound, () => Response.json({ error: { code: "invalid_request", message: "verdict required" } }, { status: 400 }))
    const result = await invalid.tools.report({ outcome: "succeeded" }, "ses_1")
    expect(result.content).toBe("Report failed (400): verdict required")
    expect(result.metadata?.["error"]).toBe("invalid_request")
  })

  it("retries transport failures with the same body, never inventing success", async () => {
    let attempts = 0
    const { tools, calls } = harness(bound, () => { attempts++; throw new Error("ECONNRESET secret-token") })
    const result = await tools.report({ outcome: "failed" }, "ses_1")
    expect(attempts).toBe(3)
    expect(new Set(calls.map(c => JSON.stringify(c.body))).size).toBe(1)
    expect(result.content).not.toContain("secret-token")
    expect(result.metadata?.["error"]).toBe("unreachable")
  })

  it("asks with a stable invocation id and reads own status", async () => {
    const { tools, calls } = harness(bound, url => url.endsWith("/status") ? Response.json({ status: { runId: "run-1", status: "running" } }) : Response.json({ result: "Question recorded." }))
    expect((await tools.ask({ question: "which db?" }, "ses_1")).content).toContain("End your turn now")
    expect(calls[0]!.body).toEqual({ ask: "which db?", invocation_id: "inv-1" })
    expect(JSON.parse((await tools.status({}, "ses_1")).content)).toEqual({ runId: "run-1", status: "running" })
    expect(calls[1]).toMatchObject({ url: "http://127.0.0.1:4400/v1/worker/status", method: "GET", auth: "Bearer secret-token" })
  })
})

describe("ConductorReportPlugin", () => {
  it("registers exactly the three tools with codemode disabled and resolves the calling session", async () => {
    const added: { name: string; options?: { codemode: boolean }; execute: (input: unknown, context: { sessionID: string }) => Promise<unknown> }[] = []
    const looked: string[] = []
    await ConductorReportPlugin.setup({
      session: { get: async ({ sessionID }) => { looked.push(sessionID); return { data: { metadata: {} } } } },
      tool: { transform: edit => edit({ add: tool => { added.push(tool) } }) },
    })
    expect(PLUGIN_ID).toBe("conductor.report")
    expect(added.map(t => t.name)).toEqual(["conductor_report", "conductor_ask", "conductor_status"])
    expect(added.every(t => t.options?.codemode === false)).toBe(true)
    expect(await added[0]!.execute({ outcome: "succeeded" }, { sessionID: "ses_abc" })).toMatchObject({ content: UNBOUND_MESSAGE })
    expect(looked).toEqual(["ses_abc"])
  })
})
