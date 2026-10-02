// Offline composition fixture. No provider, model, or host auth access.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createInterface } from "node:readline"
let bridge: Client | undefined
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const request = JSON.parse(line)
  const respond = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
  if (request.method === "initialize") respond({ protocolVersion: 1, agentCapabilities: {} })
  else if (request.method === "session/new" && process.argv.includes("--hang-session-new")) {
    // Reproduces a host stall: session/new never answers (self-healing e2e).
  } else if (request.method === "session/new") {
    // --no-bridge-connect: composition conformance fixture for "missing
    // readiness -> zero prompt" (D8: "Missing readiness fails closed
    // with zero prompts") — deliberately never connects to the injected
    // MCP bridge at all, so the daemon's readiness tracker never
    // observes initialized/tools_listed for this run.
    if (!process.argv.includes("--no-bridge-connect")) {
      const server = request.params.mcpServers[0]
      bridge = new Client({ name: "fake-acp", version: "1" })
      await bridge.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map((v: { name: string; value: string }) => [v.name, v.value])), stderr: "pipe" }))
      await bridge.listTools()
    }
    respond({ sessionId: "fake-session", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } })
  } else if (request.method === "session/prompt") {
    if (process.argv.includes("--ask-report")) {
      const answer = request.params.prompt.some((part: { text?: string }) => part.text?.includes("The human answered"))
      const result = await bridge!.callTool(answer
        ? { name: "conductor_report", arguments: { outcome: "succeeded", notes: "durable fake result" } }
        : { name: "conductor_ask", arguments: { question: "Which offline choice?" } })
      if (result.isError) throw new Error("Fake bridge tool rejected")
    }
    respond({ stopReason: "end_turn" })
  }
  else if (request.method === "session/cancel") { await bridge?.close(); process.exit(0) }
  else if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported" } }) + "\n")
}
await bridge?.close()
