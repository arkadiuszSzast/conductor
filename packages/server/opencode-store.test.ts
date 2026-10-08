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
