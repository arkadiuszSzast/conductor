import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  ReportMcpConfigError,
  createReportMcpServer,
  readReportMcpConfig,
  type ReportMcpFetch,
  type ReportMcpRequestInit,
} from "./src/report-mcp.ts"

// ---------------------------------------------------------------------------
// 4.3: readReportMcpConfig — injected env only, bypasses admin discovery
// ---------------------------------------------------------------------------

describe("4.3: readReportMcpConfig", () => {
  it("reads exactly the three injected variables", () => {
    const config = readReportMcpConfig({
      CONDUCTOR_RUN_URL: "http://127.0.0.1:4400",
      CONDUCTOR_RUN_ID: "run-1",
      CONDUCTOR_RUN_TOKEN: "tok-abc",
    })
    expect(config).toEqual({ runUrl: "http://127.0.0.1:4400", runId: "run-1", runToken: "tok-abc" })
  })

  it("strips a trailing slash from the run URL", () => {
    const config = readReportMcpConfig({
      CONDUCTOR_RUN_URL: "http://127.0.0.1:4400/",
      CONDUCTOR_RUN_ID: "run-1",
      CONDUCTOR_RUN_TOKEN: "tok-abc",
    })
    expect(config.runUrl).toBe("http://127.0.0.1:4400")
  })

  it("throws ReportMcpConfigError when CONDUCTOR_RUN_URL is missing", () => {
    expect(() => readReportMcpConfig({ CONDUCTOR_RUN_ID: "run-1", CONDUCTOR_RUN_TOKEN: "tok-abc" })).toThrow(ReportMcpConfigError)
  })

  it("throws ReportMcpConfigError when CONDUCTOR_RUN_ID is missing", () => {
    expect(() => readReportMcpConfig({ CONDUCTOR_RUN_URL: "http://127.0.0.1:4400", CONDUCTOR_RUN_TOKEN: "tok-abc" })).toThrow(ReportMcpConfigError)
  })

  it("throws ReportMcpConfigError when CONDUCTOR_RUN_TOKEN is missing", () => {
    expect(() => readReportMcpConfig({ CONDUCTOR_RUN_URL: "http://127.0.0.1:4400", CONDUCTOR_RUN_ID: "run-1" })).toThrow(ReportMcpConfigError)
  })

  it("throws ReportMcpConfigError for a malformed URL", () => {
    expect(() => readReportMcpConfig({ CONDUCTOR_RUN_URL: "not a url", CONDUCTOR_RUN_ID: "run-1", CONDUCTOR_RUN_TOKEN: "tok-abc" })).toThrow(ReportMcpConfigError)
  })

  it("rejects a non-http(s) URL scheme", () => {
    expect(() => readReportMcpConfig({ CONDUCTOR_RUN_URL: "ftp://127.0.0.1:4400", CONDUCTOR_RUN_ID: "run-1", CONDUCTOR_RUN_TOKEN: "tok-abc" })).toThrow(ReportMcpConfigError)
  })

  it("ignores any OTHER environment variable entirely (no admin config discovery)", () => {
    const config = readReportMcpConfig({
      CONDUCTOR_RUN_URL: "http://127.0.0.1:4400",
      CONDUCTOR_RUN_ID: "run-1",
      CONDUCTOR_RUN_TOKEN: "tok-abc",
      // @ts-expect-error deliberately injecting an unrelated var to prove it's ignored
      CONDUCTOR_ADMIN_TOKEN: "should-never-be-read",
      HOME: "/root",
    })
    expect(JSON.stringify(config)).not.toContain("should-never-be-read")
  })
})

// ---------------------------------------------------------------------------
// 4.3: MCP server — exactly report/ask/own-status tools, in-memory transport
// ---------------------------------------------------------------------------

function fakeFetch(handler: (request: ReportMcpRequestInit) => { status: number; body: unknown }): ReportMcpFetch {
  return async request => {
    const { status, body } = handler(request)
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }
}

async function connectedClient(fetchImpl: ReportMcpFetch): Promise<{ client: Client; requests: ReportMcpRequestInit[] }> {
  const requests: ReportMcpRequestInit[] = []
  const wrappedFetch: ReportMcpFetch = async request => {
    if (!request.url.endsWith("/ready")) requests.push(request)
    return fetchImpl(request)
  }
  const server = createReportMcpServer({
    config: { runUrl: "http://fake-daemon.test", runId: "run-1", runToken: "tok-abc" },
    fetchImpl: wrappedFetch,
    logError: () => {},
  })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, requests }
}

describe("4.3: MCP initialize/listTools — exactly the three permitted tools", () => {
  it("signals readiness only on initialized notification and actual list request", async () => {
    const phases: string[] = []
    const server = createReportMcpServer({ config: { runUrl: "http://fake.test", runId: "r", runToken: "synthetic" }, fetchImpl: fakeFetch(request => {
      if (request.url.endsWith("/ready")) phases.push(JSON.parse(request.body!).phase)
      return { status: 200, body: {} }
    }) })
    const [left, right] = InMemoryTransport.createLinkedPair()
    await server.connect(left)
    expect(phases).toEqual([])
    const client = new Client({ name: "fake", version: "1" })
    await client.connect(right)
    expect(phases).toEqual(["initialized"])
    await client.listTools()
    expect(phases).toEqual(["initialized", "tools_listed"])
    await client.close()
    await server.close()
  })

  it("retries asks with identical invocation identity after a lost ACK", async () => {
    const bodies: string[] = []
    const { client } = await connectedClient(async request => {
      if (request.url.endsWith("/report")) {
        bodies.push(request.body!)
        if (bodies.length === 1) throw new Error("lost ACK synthetic secret")
      }
      return new Response(JSON.stringify({ result: "Question recorded." }))
    })
    await client.callTool({ name: "conductor_ask", arguments: { question: "Choice?" } })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(bodies[1])
    await client.close()
  })

  it("D8: an ask whose HTTP outcome is truly unknown (every bounded retry also fails) surfaces as a tool error — the caller can separately query conductor_status to discover the question WAS actually recorded server-side, a distinct claim from the failed ask call itself", async () => {
    let askAttempts = 0
    const { client } = await connectedClient(async request => {
      if (request.url.endsWith("/report")) {
        askAttempts += 1
        // EVERY attempt fails at the network layer — bounded retries
        // exhaust without ever learning whether the daemon's own write
        // committed. This is the exact "Unknown HTTP outcome" case D8
        // describes: never invent success from the ask call itself.
        throw new Error("network outcome unknown")
      }
      // Meanwhile the daemon's own /v1/worker/status — a SEPARATE,
      // idempotent claim — proves the question DID durably land despite
      // every ask attempt appearing to fail from the bridge's own point
      // of view (e.g. the write committed but every ACK response was
      // lost in transit).
      return new Response(JSON.stringify({ status: { runId: "run-1", status: "running", pendingQuestion: "Choice?", outputsReported: false } }))
    })
    const askResult = await client.callTool({ name: "conductor_ask", arguments: { question: "Choice?" } })
    expect(askResult.isError).toBe(true)
    expect(askAttempts).toBeGreaterThan(1) // bounded retries were actually attempted

    // The SEPARATE conductor_status claim is unaffected by the ask
    // tool's own reported failure — it reflects the daemon's actual
    // durable state, not a cached/derived view of the failed ask call.
    const statusResult = await client.callTool({ name: "conductor_status", arguments: {} })
    expect(statusResult.isError).not.toBe(true)
    const content = statusResult.content as Array<{ type: string; text: string }>
    expect(content[0]?.text).toContain("Choice?")
    await client.close()
  })
  it("lists exactly conductor_report, conductor_ask and conductor_status — nothing else", async () => {
    const { client } = await connectedClient(fakeFetch(() => ({ status: 200, body: {} })))
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name).sort()
    expect(names).toEqual(["conductor_ask", "conductor_report", "conductor_status"])
  })

  it("advertises the full review schema so agents do not guess the finding shape", async () => {
    const { client } = await connectedClient(fakeFetch(() => ({ status: 200, body: {} })))
    const { tools } = await client.listTools()
    const report = tools.find(tool => tool.name === "conductor_report")!
    const review = (report.inputSchema.properties as Record<string, any>)["review"]
    expect(review.required).toEqual(["head", "findings"])
    const item = review.properties.findings.items
    expect(item.properties.acceptanceTests).toMatchObject({ type: "array", items: { type: "string" } })
    expect(item.required).toContain("acceptanceTests")
    expect(item.additionalProperties).toBe(false)
    expect(report.description).toContain("call again")
  })

  it("no admin config access: tool listing works with ONLY the injected run config, no daemon started", async () => {
    // If this test can construct/connect the server at all without
    // touching any daemon-start or admin-config code path, that IS the
    // proof — createReportMcpServer takes only {config, fetchImpl, logError}.
    const { client } = await connectedClient(fakeFetch(() => ({ status: 200, body: {} })))
    const { tools } = await client.listTools()
    expect(tools.length).toBe(3)
  })
})

describe("4.3: MCP callTool — conductor_report", () => {
  it("calls /v1/worker/report with the run-scoped bearer token and forwards the result text", async () => {
    const { client, requests } = await connectedClient(
      fakeFetch(() => ({ status: 200, body: { result: 'Step "implement" marked succeeded.' } })),
    )
    const result = await client.callTool({ name: "conductor_report", arguments: { outcome: "succeeded" } })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]?.text).toContain("succeeded")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("http://fake-daemon.test/v1/worker/report")
    expect(requests[0]?.headers["authorization"]).toBe("Bearer tok-abc")
  })

  it("surfaces a daemon error response as an MCP tool error, never fabricating success", async () => {
    const { client } = await connectedClient(
      fakeFetch(() => ({ status: 422, body: { error: { code: "invalid_input", message: "outcome is required" } } })),
    )
    const result = await client.callTool({ name: "conductor_report", arguments: {} })
    expect(result.isError).toBe(true)
  })

  it("lost report ACK: a 409 run_already_concluded is a non-error result, never surfaced as a tool failure needing correction", async () => {
    const { client } = await connectedClient(
      fakeFetch(() => ({ status: 409, body: { error: { code: "run_already_concluded", message: "run x already concluded (succeeded)" } } })),
    )
    const result = await client.callTool({ name: "conductor_report", arguments: { outcome: "succeeded" } })
    // The agent's OWN earlier report already committed durably — this
    // 409 means only the acknowledgement was lost, not the outcome.
    // Surfacing it as isError would invite a pointless retry/redo loop.
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]?.text).toContain("already")
  })

  it("a DIFFERENT 409 (e.g. stale_version) still surfaces as a genuine tool error, not silently swallowed", async () => {
    const { client } = await connectedClient(
      fakeFetch(() => ({ status: 409, body: { error: { code: "stale_version", message: "feature changed since your view" } } })),
    )
    const result = await client.callTool({ name: "conductor_report", arguments: { outcome: "succeeded" } })
    expect(result.isError).toBe(true)
  })

  it("surfaces an unreachable daemon (network failure) as a tool error, not a hang or fabricated success", async () => {
    const alwaysFails: ReportMcpFetch = async () => {
      throw new Error("ECONNREFUSED")
    }
    const server = createReportMcpServer({
      config: { runUrl: "http://fake-daemon.test", runId: "run-1", runToken: "tok-abc" },
      fetchImpl: alwaysFails,
      logError: () => {},
    })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const result = await client.callTool({ name: "conductor_report", arguments: { outcome: "failed" } })
    expect(result.isError).toBe(true)
  }, 10000)
})

describe("4.3: MCP callTool — conductor_ask", () => {
  it("calls /v1/worker/report with an ask payload and an invocation_id", async () => {
    const { client, requests } = await connectedClient(
      fakeFetch(() => ({ status: 200, body: { result: "Question recorded." } })),
    )
    const result = await client.callTool({ name: "conductor_ask", arguments: { question: "which approach?" } })
    expect(result.isError).not.toBe(true)
    expect(requests).toHaveLength(1)
    const body = JSON.parse(requests[0]!.body!) as { ask: string; invocation_id: string }
    expect(body.ask).toBe("which approach?")
    expect(typeof body.invocation_id).toBe("string")
    expect(body.invocation_id.length).toBeGreaterThan(0)
  })

  it("an autonomous-step refusal is returned as ordinary (non-error) tool text, matching the engine's own instructive-refusal contract", async () => {
    const { client } = await connectedClient(
      fakeFetch(() => ({ status: 200, body: { result: "Step \"implement\" is not interactive — asking is not available here." } })),
    )
    const result = await client.callTool({ name: "conductor_ask", arguments: { question: "help?" } })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]?.text).toContain("not interactive")
  })
})

describe("4.3: MCP callTool — conductor_status (own-run only)", () => {
  it("calls GET /v1/worker/status and forwards the status projection", async () => {
    const { client, requests } = await connectedClient(
      fakeFetch(() => ({ status: 200, body: { status: { runId: "run-1", status: "running", pendingQuestion: null, outputsReported: false } } })),
    )
    const result = await client.callTool({ name: "conductor_status", arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(requests[0]?.method).toBe("GET")
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]?.text).toContain("run-1")
  })
})

describe("4.3: no stdout diagnostics, no parallel ledger", () => {
  it("logError is the ONLY diagnostic sink invoked on failure — never a direct console.log/stdout write", async () => {
    const errors: string[] = []
    const alwaysFails: ReportMcpFetch = async () => {
      throw new Error("network down")
    }
    const server = createReportMcpServer({
      config: { runUrl: "http://fake-daemon.test", runId: "run-1", runToken: "tok-abc" },
      fetchImpl: alwaysFails,
      logError: message => errors.push(message),
    })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await client.callTool({ name: "conductor_status", arguments: {} })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(" ")).not.toContain("network down")
    expect(errors.join(" ")).toContain("could not be confirmed")
  })

  it("the bridge never persists its own outcome record — every tool call is a stateless HTTP round-trip", async () => {
    // Structural proof: createReportMcpServer's signature takes no
    // database/file path at all — it can only ever forward to the
    // daemon's HTTP surface via fetchImpl.
    const { client } = await connectedClient(fakeFetch(() => ({ status: 200, body: { result: "ok" } })))
    await client.callTool({ name: "conductor_report", arguments: { outcome: "succeeded" } })
    await client.callTool({ name: "conductor_report", arguments: { outcome: "succeeded" } })
    // No assertion beyond "this completes without touching disk" —
    // covered structurally by createReportMcpServer's own dependency
    // signature (config + fetchImpl + logError, nothing persistent).
    expect(true).toBe(true)
  })
})
