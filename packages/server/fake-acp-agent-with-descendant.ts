/**
 * Offline test fixture (task 1 group-cleanup regression): a REAL spawned
 * process — not an in-process fake — that speaks minimal ACP 1 JSON-RPC
 * over its own real stdio, and on `session/new` forks a TERM-ignoring
 * descendant of its own (same process group — the realistic shape of a
 * tool the agent itself spawned) before answering. Used by
 * `acp-sessions.test.ts` to prove `ManagedSessions.cleanupRun` (through
 * the REAL `realAcpProcessSpawner`, not the in-process fake spawner
 * every other `acp-sessions.test.ts` case uses) reports "unconfirmed"
 * while the descendant survives TERM/a too-short killMs, and
 * "confirmed_terminated" only once KILL actually reaches the whole
 * process group within a sufficient killMs — never inferring cleanup
 * from the AGENT LEADER's own exit/cancel acknowledgement alone.
 *
 * No provider, model or host credential access — this is a synthetic
 * peer that never calls out anywhere.
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const lines = createInterface({ input: process.stdin })
const respond = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")

for await (const line of lines) {
  if (!line.trim()) continue
  const request = JSON.parse(line) as { id?: unknown; method: string; params?: Record<string, unknown> }
  if (request.method === "initialize") respond(request.id, { protocolVersion: 1, agentCapabilities: {} })
  else if (request.method === "session/new") {
    // Fork our OWN TERM-ignoring descendant — deliberately WITHOUT its
    // own `detached`/setsid, so it stays in the SAME POSIX process
    // group as this agent leader (the realistic shape: a tool the agent
    // itself spawned, still reachable by the daemon's group-wide
    // TERM/KILL). This process (the ACP "agent leader") never itself
    // ignores TERM; only its descendant does.
    spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
      stdio: "ignore",
    }).unref()
    respond(request.id, { sessionId: "fake-session-with-descendant", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } })
  } else if (request.method === "session/prompt") {
    // Never resolves on its own — the test drives cleanup via abort()/
    // cleanupRun(), never a normal turn conclusion.
  } else if (request.method === "session/cancel") {
    // Acknowledge cancellation but deliberately do NOT exit — matches
    // D9's "acknowledge committed result and perform cleanup
    // asynchronously": the adapter's OWN bounded TERM/KILL cleanup,
    // never the agent's cooperative cancel ack, is what proves absence.
  } else if (request.id !== undefined) {
    respond(request.id, undefined)
  }
}
