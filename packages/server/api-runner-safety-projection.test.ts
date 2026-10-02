import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "./src/daemon.ts"
import { createApi, type ConductorApi } from "./src/api.ts"
import type { SessionClient } from "./src/ports.ts"
import type { Store } from "./src/store.ts"
import type { RunnerSafetyStore } from "./src/runner-execution.ts"

class FakeSessions implements SessionClient {
  private counter = 0
  async createSession(): Promise<{ id: string }> {
    return { id: `ses-${++this.counter}` }
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(): Promise<"busy" | "idle" | "retry" | "missing"> {
    return "busy"
  }
  async note(): Promise<void> {}
}

const temporaryDirectories: string[] = []
const daemonsToStop: Daemon[] = []
const apisToClose: ConductorApi[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(async () => {
  for (const api of apisToClose.splice(0)) api.close()
  for (const daemon of daemonsToStop.splice(0)) await daemon.stop()
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const agentWorkflow = `
name: agent-only
on: [manual]
roles:
  implementer: { agent: build }
jobs:
  main:
    steps:
      - id: implement
        agent:
          role: implementer
          prompt: "Implement it."
`

async function makeApi(): Promise<{
  daemon: Daemon
  store: Store & RunnerSafetyStore
  request: (method: string, path: string) => Promise<Response>
}> {
  const project = tempDir("conductor-projection-project-")
  writeFileSync(join(project, "conductor.yaml"), agentWorkflow)
  const daemon = new Daemon(
    { databasePath: join(tempDir("conductor-projection-db-"), "state.db"), projects: [project], heartbeatIntervalMs: 60_000 },
    { sessions: new FakeSessions(), scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
  )
  daemonsToStop.push(daemon)
  await daemon.start()
  const store = daemon.store as Store & RunnerSafetyStore
  const api = createApi(
    { bind: { host: "127.0.0.1", port: 0 }, auth: { mode: "none" } },
    {
      store: daemon.store, engine: daemon.engine, health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
    },
  )
  apisToClose.push(api)
  const request = (method: string, path: string) => api.handle(new Request(`http://conductor.test${path}`, { method }))
  return { daemon, store, request }
}

function seedRunningRun(store: Store & RunnerSafetyStore, projectDir: string): { featureId: string; runId: string } {
  const feature = store.createFeature({ title: "F", slug: "f", projectDir, workflow: "agent-only" })
  store.applyTransition(feature.id, { kind: "feature.start" }, {
    decisions: [{ kind: "execute_step", jobId: "main", stepId: "implement" }],
    patch: { status: "running", jobs: { main: { status: "running", currentStep: "implement", steps: { implement: { status: "running" } } } } },
  })
  const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
  return { featureId: feature.id, runId }
}

describe("4.4: safe run/feature projections for uncertainty", () => {
  it("a native run (no binding) shows NO transport/uncertain fields at all — zero shape change", async () => {
    const { store, request, daemon } = await makeApi()
    const { runId, featureId } = seedRunningRun(store, daemon.registry.list()[0]!.projectDir)
    const response = await request("GET", `/v1/runs/${runId}`)
    expect(response.status).toBe(200)
    const body = await response.json() as { run: Record<string, unknown> }
    expect(body.run["transport"]).toBeUndefined()
    expect(body.run["uncertain"]).toBeUndefined()
    void featureId
  })

  it("an ACP-bound run without a fence shows transport but no uncertain field", async () => {
    const { store, request, daemon } = await makeApi()
    const { runId } = seedRunningRun(store, daemon.registry.list()[0]!.projectDir)
    store.bindRunnerTransport({ runId, transport: "acp", profileId: "opencode-acp", directory: "/tmp", daemonGeneration: 1 })
    const response = await request("GET", `/v1/runs/${runId}`)
    const body = await response.json() as { run: Record<string, unknown> }
    expect(body.run["transport"]).toBe("acp")
    expect(body.run["profileId"]).toBe("opencode-acp")
    expect(body.run["uncertain"]).toBeUndefined()
  })

  it("a fenced run exposes uncertain reason/cleanup honestly, never tokens/env/raw config", async () => {
    const { store, request, daemon } = await makeApi()
    const { runId } = seedRunningRun(store, daemon.registry.list()[0]!.projectDir)
    store.bindRunnerTransport({ runId, transport: "acp", profileId: "opencode-acp", directory: "/tmp", daemonGeneration: 1 })
    store.recordFence({ runId, jobId: "main", stepId: "implement", reasonCode: "lost_prompt_response", cleanupState: "unconfirmed", diagnostic: "lost" })
    const response = await request("GET", `/v1/runs/${runId}`)
    const body = await response.json() as { run: { uncertain?: Record<string, unknown> } }
    expect(body.run.uncertain?.reasonCode).toBe("lost_prompt_response")
    expect(body.run.uncertain?.cleanupState).toBe("unconfirmed")
    expect(body.run.uncertain?.recoveryRequiresCleanupAcknowledgement).toBe(true)
    const text = JSON.stringify(body)
    expect(text).not.toContain("token")
    expect(text).not.toContain("env")
  })

  it("a resolved fence no longer shows an uncertain field (recovery already acknowledged)", async () => {
    const { store, request, daemon } = await makeApi()
    const { runId } = seedRunningRun(store, daemon.registry.list()[0]!.projectDir)
    store.bindRunnerTransport({ runId, transport: "acp", directory: "/tmp", daemonGeneration: 1 })
    store.recordFence({ runId, jobId: "main", stepId: "implement", reasonCode: "lost_prompt_response", cleanupState: "unconfirmed", diagnostic: "lost" })
    store.resolveFence(runId, "operator confirmed cleanup")
    const response = await request("GET", `/v1/runs/${runId}`)
    const body = await response.json() as { run: Record<string, unknown> }
    expect(body.run["uncertain"]).toBeUndefined()
  })

  it("D9: /resume on a fenced feature is a 409 conflict whose message NAMES the required recover+acknowledgeUncertain path, never a bare refusal", async () => {
    const { store, request, daemon } = await makeApi()
    const { featureId, runId } = seedRunningRun(store, daemon.registry.list()[0]!.projectDir)
    store.bindRunnerTransport({ runId, transport: "acp", profileId: "opencode-acp", directory: "/tmp", daemonGeneration: 1 })
    store.fenceRunnerExecution(
      { runId, jobId: "main", stepId: "implement", reasonCode: "cancellation_during_uncertain_write", diagnostic: "ACP interrupted without authoritative report" },
      () => undefined,
    )
    store.markRunActionHandled(runId)
    store.classifyFenceExecution(runId, { classification: "unsafe", evidence: {}, planHealing: () => ({ delayMs: 0, attention: false }) }, () => undefined)
    expect(store.hasUnresolvedRunnerFence(featureId)).toBe(true)

    const response = await request("POST", `/v1/features/${featureId}/resume`)
    expect(response.status).toBe(409)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe("conflict")
    // The API's OWN pre-check (never reaching engine.resume's throw) —
    // both paths must actually name "recover" and "acknowledgeUncertain"
    // so an integrating caller has the exact remedy, not a bare refusal.
    expect(body.error.message).toMatch(/recover/i)
    expect(body.error.message).toMatch(/acknowledgeUncertain/i)
    // The feature must remain escalated — a rejected resume can never
    // silently flip status.
    expect(store.getFeature(featureId)?.status).toBe("escalated")
  })

  it("rejects a stale/late worker's data leaking into another attempt's projection (each run has its own independent binding)", async () => {
    const { store, request, daemon } = await makeApi()
    const projectDir = daemon.registry.list()[0]!.projectDir
    const runA = seedRunningRun(store, projectDir)
    const runB = seedRunningRun(store, projectDir)
    store.bindRunnerTransport({ runId: runA.runId, transport: "acp", profileId: "profile-a", directory: "/tmp", daemonGeneration: 1 })
    store.bindRunnerTransport({ runId: runB.runId, transport: "acp", profileId: "profile-b", directory: "/tmp", daemonGeneration: 1 })
    const responseA = await request("GET", `/v1/runs/${runA.runId}`)
    const bodyA = await responseA.json() as { run: Record<string, unknown> }
    expect(bodyA.run["profileId"]).toBe("profile-a")
    const responseB = await request("GET", `/v1/runs/${runB.runId}`)
    const bodyB = await responseB.json() as { run: Record<string, unknown> }
    expect(bodyB.run["profileId"]).toBe("profile-b")
  })
})

describe("self-healing projections", () => {
  it("a healable fence shows healing activity, then attention with its targets", async () => {
    const { store, request, daemon } = await makeApi()
    const { featureId, runId } = seedRunningRun(store, daemon.registry.list()[0]!.projectDir)
    store.bindRunnerTransport({ runId, transport: "acp", profileId: "opencode-acp", directory: "/tmp", daemonGeneration: 1 })
    store.fenceRunnerExecution({ runId, jobId: "main", stepId: "implement", reasonCode: "lost_create_response", diagnostic: "session/new lost" }, () => undefined)
    store.markRunActionHandled(runId)
    store.classifyFenceExecution(runId, { classification: "no_effect", evidence: {}, planHealing: () => ({ delayMs: 60_000, attention: false }) }, () => undefined)

    let body = await (await request("GET", `/v1/features/${featureId}`)).json() as { feature: Record<string, any> }
    expect(body.feature["status"]).toBe("running")
    expect(body.feature["attention"]).toBeNull()
    expect(body.feature["activity"]).toMatchObject({ state: "waiting_retry", reason: "healing:no_effect", target: { jobId: "main", stepId: "implement" } })
    const run = await (await request("GET", `/v1/runs/${runId}`)).json() as { run: Record<string, any> }
    expect(run.run["uncertain"]).toMatchObject({ classification: "no_effect", autoHealing: true })

    store.upsertAttention({ featureId, jobId: "main", stepId: "implement", source: "healing", consecutiveFailures: 3, lastDiagnostic: "session/new lost", nextAttemptAt: 123 })
    body = await (await request("GET", `/v1/features/${featureId}`)).json() as { feature: Record<string, any> }
    expect(body.feature["activity"]).toMatchObject({ state: "attention", diagnostic: "session/new lost" })
    expect(body.feature["attention"].targets).toEqual([{ jobId: "main", stepId: "implement", source: "healing", consecutiveFailures: 3, lastDiagnostic: "session/new lost", nextAttemptAt: 123 }])
    const list = await (await request("GET", "/v1/features")).json() as { features: Record<string, any>[] }
    expect(list.features[0]?.["attention"]?.targets).toHaveLength(1)
  })
})
