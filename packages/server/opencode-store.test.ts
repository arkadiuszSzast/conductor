import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"

let directory: string
let connection: DatabaseConnection
let store: Store
const clock = { now: () => 1_000_000 }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-opencode-store-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db, clock)
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function run(step: string): string {
  const feature = store.createFeature({ title: step, slug: step, projectDir: "/p", workflow: "w" })
  return store.insertRun({ featureId: feature.id, jobId: "main", stepId: step, stepType: "agent", attempt: 1 })
}

it("accepts the opencode transport and still rejects unknown ones", () => {
  const runId = run("a")
  const binding = store.bindRunnerTransport({ runId, transport: "opencode", profileId: "v2", directory: "/p", daemonGeneration: 1 })
  expect(binding.transport).toBe("opencode")
  expect(() => connection.db.run(
    "INSERT INTO runner_binding (run_id, transport, directory, daemon_generation, time_created, time_updated) VALUES (?, 'bogus', '/p', 1, 0, 0)",
    [run("b")],
  )).toThrow()
})

it("counts running runs per profile and resolves bindings by session ref", () => {
  const a = run("a")
  const b = run("b")
  const c = run("c")
  store.bindRunnerTransport({ runId: a, transport: "opencode", profileId: "v2", directory: "/p", daemonGeneration: 1 })
  store.bindRunnerTransport({ runId: b, transport: "opencode", profileId: "v2", directory: "/p", daemonGeneration: 1 })
  store.bindRunnerTransport({ runId: c, transport: "opencode", profileId: "other", directory: "/p", daemonGeneration: 1 })
  expect(store.countRunningBoundRuns("opencode", "v2")).toBe(2)
  expect(store.countRunningBoundRuns("acp", "v2")).toBe(0)
  expect(store.setBindingSessionRef(a, "ses_ca", "ses_ca")).toBe(true)
  expect(store.getRunnerBindingBySessionRef("ses_ca")?.runId).toBe(a)
  expect(store.getRunnerBindingBySessionRef("ses_none")).toBeNull()
})

it("composed opencode runners stream a bound running session's events into its run log", async () => {
  const { composeOpencodeRunners } = await import("./src/runner-router.ts")
  const runId = run("impl")
  store.bindRunnerTransport({ runId, transport: "opencode", profileId: "v2", directory: "/p", daemonGeneration: 1 })
  store.setBindingSessionRef(runId, "ses_impl", "ses_impl")
  const frames = [
    { type: "session.text.ended", data: { sessionID: "ses_impl", text: "Renaming the field." } },
    { type: "session.tool.input.started", data: { sessionID: "ses_impl", id: "t1", name: "edit" } },
    { type: "session.tool.called", data: { sessionID: "ses_impl", id: "t1", input: { path: "/p/Standings.kt", oldString: "a", newString: "b" } } },
    { type: "session.text.ended", data: { sessionID: "ses_root", text: "not a run" } },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")
  const realFetch = globalThis.fetch
  let served = false
  globalThis.fetch = (async (request: Request) => {
    if (served) return new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))))
    served = true
    return new Response(new Blob([frames]).stream(), { status: 200 })
  }) as unknown as typeof fetch
  const runners = composeOpencodeRunners({
    default: "native",
    projects: { "/p": "v2" },
    acp: {},
    opencode: { v2: { baseUrl: "http://fake", passwordEnv: "PW", allowedRoots: ["/p"], maxConcurrent: 1, bindings: {} } },
  }, store, clock as never, () => "http://daemon", { PW: "pw" })
  try {
    runners.start()
    for (let i = 0; i < 100 && !served; i++) await new Promise(resolve => setTimeout(resolve, 1))
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    globalThis.fetch = realFetch
  }
  await runners.stop()
  const lines = (connection.db.query("SELECT source, chunk FROM run_log WHERE run_id = ? ORDER BY seq").all(runId) as { source: string; chunk: string }[])
  expect(lines).toEqual([
    { source: "agent", chunk: "Renaming the field." },
    { source: "tool", chunk: "editing Standings.kt" },
  ])
})
