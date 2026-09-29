/**
 * Offline test fixture (real finding: OpenCode's shell tool runs a
 * background command via `setsid` — a NEW process group AND a NEW
 * session, invisible to `process.kill(-leaderPid, ...)`). A REAL
 * spawned process — not an in-process fake — that speaks minimal ACP 1
 * JSON-RPC over its own real stdio, and on `session/new` forks a
 * TERM-ignoring descendant THAT CALLS ITS OWN `setsid()` (unlike
 * `fake-acp-agent-with-descendant.ts`'s same-group descendant) before
 * answering. Used by `acp-sessions.test.ts` to prove
 * `ManagedSessions.cleanupRun`/`terminate()` (through the REAL
 * `realAcpProcessSpawner`) still reaches and confirms termination of a
 * descendant that has escaped the leader's own process group entirely —
 * the exact live gap a leader-group-only `groupAbsent()` probe cannot
 * see, and the exact shape (`PPID` reparented to 1, `PGID==PID`,
 * `SID==PID`) observed live in production.
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
    // `setsid sh -c '...'` — the descendant becomes its OWN process
    // group leader AND session leader, deliberately escaping the ACP
    // agent leader's group (the realistic shape of OpenCode's shell
    // tool backgrounding `sleep 240` via `setsid`). This process (the
    // ACP "agent leader") never itself ignores TERM; only the
    // setsid'd descendant does. `DESCENDANT_PIDFILE`, when set, lets a
    // test independently verify (via `process.kill(pid, 0)`, a pure
    // liveness probe) that the setsid'd descendant genuinely survives
    // TERM and genuinely dies once KILL reaches it — never merely
    // inferred from this module's own self-reported `groupAbsent()`.
    const pidFile = process.env["DESCENDANT_PIDFILE"]
    const script = pidFile
      ? `trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 1; done`
      : "trap '' TERM; while :; do sleep 1; done"
    spawn("setsid", ["sh", "-c", script], {
      stdio: "ignore",
    }).unref()
    respond(request.id, { sessionId: "fake-session-with-setsid-descendant", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } })
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
