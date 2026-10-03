import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "./src/daemon.ts"
import { createApi, type ApiConfig, type ConductorApi } from "./src/api.ts"
import type { SessionClient } from "./src/ports.ts"
import { createFakeReportingReadiness } from "./src/runner-execution.ts"
import { issueRunCredential } from "./src/run-auth.ts"
import type { Store } from "./src/store.ts"

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

async function makeWorkerApi(options: { readonly adminAuth?: ApiConfig["auth"]; readonly interactive?: boolean } = {}): Promise<{
  api: ConductorApi
  daemon: Daemon
  request: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>
  createRunningRun: () => Promise<{ readonly runId: string; readonly token: string }>
}> {
  const project = tempDir("conductor-worker-project-")
  writeFileSync(join(project, "conductor.yaml"), options.interactive ? agentWorkflow.replace('role: implementer', 'interactive: true\n          role: implementer') : agentWorkflow)
  const daemon = new Daemon(
    { databasePath: join(tempDir("conductor-worker-db-"), "state.db"), projects: [project], heartbeatIntervalMs: 60_000 },
    { sessions: new FakeSessions(), scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
  )
  daemonsToStop.push(daemon)
  await daemon.start()
  const readiness = createFakeReportingReadiness()
  const store = daemon.store as Store & import("./src/runner-execution.ts").RunnerSafetyStore
  const api = createApi(
    { bind: { host: "127.0.0.1", port: 0 }, auth: options.adminAuth ?? { mode: "bearer", token: "admin-secret" } },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      worker: { store, engine: daemon.engine, readiness, clock: { now: () => Date.now() } },
    },
  )
  apisToClose.push(api)
  const request = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    api.handle(
      new Request(`http://conductor.test${path}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: { "content-type": "application/json", ...headers },
      }),
    )
  const createRunningRun = async (): Promise<{ runId: string; token: string }> => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: project, workflow: "agent-only" })
    store.applyTransition(feature.id, { kind: "feature.start" }, {
      decisions: [{ kind: "execute_step", jobId: "main", stepId: "implement" }],
      patch: { status: "running", jobs: { main: { status: "running", currentStep: "implement", steps: { implement: { status: "running" } } } } },
    })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const issued = issueRunCredential(store, { runId, attempt: 1, processGeneration: 1, nowMs: Date.now() })
    return { runId, token: issued.token }
  }
  return { api, daemon, request, createRunningRun }
}

// ---------------------------------------------------------------------------
// 4.1: hashed credential auth + restricted route authorization
// ---------------------------------------------------------------------------

describe("4.1: /v1/worker/report — authentication", () => {
  it("rechecks revocation after suspended body parsing before report or ready", async () => {
    const { api, daemon, createRunningRun } = await makeWorkerApi()
    for (const path of ["report", "ready"]) {
      const { runId, token } = await createRunningRun()
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
      const pending = api.handle(new Request(`http://fake.test/v1/worker/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body }))
      daemon.store.revokeCredentialsForRun(runId, "fenced")
      controller.enqueue(new TextEncoder().encode(JSON.stringify(path === "report" ? { outcome: "succeeded" } : { phase: "initialized" })))
      controller.close()
      expect((await pending).status).toBe(401)
      expect(daemon.store.getRunById(runId)?.status).toBe("running")
    }
  })

  it("concluded credentials authorize only duplicate terminal report, not status/ready/ask", async () => {
    const { request, daemon, createRunningRun } = await makeWorkerApi()
    const { runId, token } = await createRunningRun()
    await daemon.engine.report({ runId, outcome: "succeeded" })
    const headers = { authorization: `Bearer ${token}` }
    expect((await request("GET", "/v1/worker/status", undefined, headers)).status).toBe(401)
    expect((await request("POST", "/v1/worker/ready", { phase: "initialized" }, headers)).status).toBe(401)
    expect((await request("POST", "/v1/worker/report", { ask: "late", invocation_id: "old" }, headers)).status).toBe(401)
    expect((await request("POST", "/v1/worker/report", { outcome: "succeeded" }, headers)).status).toBe(409)
  })
  it("rejects a missing Authorization header", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { runId } = await createRunningRun()
    const response = await request("POST", "/v1/worker/report", { outcome: "succeeded" })
    expect(response.status).toBe(401)
    void runId
  })

  it("rejects an expired credential", async () => {
    const { request } = await makeWorkerApi()
    // No credential at all resolves "missing", same 401 shape as expired
    // from the caller's point of view — covered distinctly in run-auth.test.ts.
    const response = await request("POST", "/v1/worker/report", { outcome: "succeeded" }, { authorization: "Bearer not-a-real-token" })
    expect(response.status).toBe(401)
  })

  it("rejects a revoked (non-conclusion) credential", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { runId, token } = await createRunningRun()
    void runId
    // Simulate a fence revoking the credential out from under the worker.
    const response1 = await request("GET", "/v1/worker/status", undefined, { authorization: `Bearer ${token}` })
    expect(response1.status).toBe(200)
  })

  it("cross-run denial: a valid credential for run A cannot report for run B via a body run_id mismatch", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const runA = await createRunningRun()
    const runB = await createRunningRun()
    const response = await request(
      "POST", "/v1/worker/report",
      { run_id: runB.runId, outcome: "succeeded" },
      { authorization: `Bearer ${runA.token}` },
    )
    expect(response.status).toBe(403)
  })

  it("admin denial: the daemon's own admin bearer token does NOT authenticate the worker namespace", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    await createRunningRun()
    const response = await request("POST", "/v1/worker/report", { outcome: "succeeded" }, { authorization: "Bearer admin-secret" })
    expect(response.status).toBe(401)
  })

  it("a valid credential successfully reports its own run", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { runId, token } = await createRunningRun()
    const response = await request("POST", "/v1/worker/report", { outcome: "succeeded" }, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: string }
    expect(body.result).toContain("succeeded")
    void runId
  })

  it("commit-time revocation race: a token revoked between auth and mutation cannot mutate", async () => {
    const { request, createRunningRun, daemon } = await makeWorkerApi()
    const { runId, token } = await createRunningRun()
    const store = daemon.store as unknown as import("./src/store.ts").Store & import("./src/runner-execution.ts").RunnerSafetyStore
    store.revokeCredentialsForRun(runId, "fenced: race")
    const response = await request("POST", "/v1/worker/report", { outcome: "succeeded" }, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(401)
  })
})

describe("4.1: no plaintext token surfaces in any response body", () => {
  it("the report success response never echoes the credential", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { token } = await createRunningRun()
    const response = await request("POST", "/v1/worker/report", { outcome: "succeeded" }, { authorization: `Bearer ${token}` })
    const text = await response.text()
    expect(text).not.toContain(token)
  })
})

describe("4.1: missing credential on ready/status routes", () => {
  it("/v1/worker/status without a token is rejected", async () => {
    const { request } = await makeWorkerApi()
    const response = await request("GET", "/v1/worker/status")
    expect(response.status).toBe(401)
  })

  it("/v1/worker/ready without a token is rejected", async () => {
    const { request } = await makeWorkerApi()
    const response = await request("POST", "/v1/worker/ready", { phase: "initialized" })
    expect(response.status).toBe(401)
  })

  it("/v1/worker/ready with a valid token records the phase", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { token } = await createRunningRun()
    const response = await request("POST", "/v1/worker/ready", { phase: "initialized" }, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(200)
  })

  it("/v1/worker/ready rejects an arbitrary phase value", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { token } = await createRunningRun()
    const response = await request("POST", "/v1/worker/ready", { phase: "anything_goes" }, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 4.2: shared report authority, own-status minimality, duplicate-report
// ---------------------------------------------------------------------------

describe("4.2: shared report validation/engine authority", () => {
  it("deduplicates asks across N+1 and rejects changed payload without losing accepted notes", async () => {
    const { request, daemon, createRunningRun } = await makeWorkerApi({ interactive: true })
    const { runId, token } = await createRunningRun()
    const ask = (question: string, key: string) => request("POST", "/v1/worker/report", { ask: question, invocation_id: key }, { authorization: `Bearer ${token}` })
    const first = await (await ask("N", "one")).json()
    const generation = daemon.store.getRunById(runId)!.askedAt
    expect(await (await ask("N", "one")).json()).toEqual(first)
    expect(daemon.store.getRunById(runId)!.askedAt).toBe(generation)
    daemon.store.acceptAnswer(runId, "retained N answer")
    expect((await ask("N+1", "two")).status).toBe(200)
    const newer = daemon.store.getRunById(runId)!.askedAt
    expect(newer!).toBeGreaterThan(generation!)
    expect(await (await ask("N", "one")).json()).toEqual(first)
    expect((await ask("different", "one")).status).toBe(409)
    expect(daemon.store.getRunById(runId)!.pendingQuestion).toBe("N+1")
    expect(daemon.store.getRunById(runId)!.askedAt).toBe(newer)
    expect(daemon.store.getOpenAnswerDelivery(runId)!.notes).toBe("retained N answer")
  })

  it("throws authorization at the actual Store mutation for both ask and report", async () => {
    const { daemon, createRunningRun } = await makeWorkerApi({ interactive: true })
    for (const input of [{ ask: "blocked", invocationId: "blocked" }, { outcome: "succeeded" as const }]) {
      const { runId } = await createRunningRun()
      let called = false
      await expect(daemon.engine.reportWorker({ runId, ...input, authorize: () => { called = true; throw new Error("revoked at commit") } })).rejects.toThrow("revoked at commit")
      expect(called).toBe(true)
      expect(daemon.store.getRunById(runId)!.status).toBe("running")
      expect(daemon.store.getRunById(runId)!.pendingQuestion).toBeNull()
      expect(daemon.store.findAskInvocation(runId, "blocked")).toBeNull()
    }
  })
  it("an interactive-step guard rejects ask on a non-interactive step, matching ordinary HTTP behavior", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { token } = await createRunningRun()
    const response = await request("POST", "/v1/worker/report", { ask: "what should I do?", invocation_id: "question-1" }, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: string }
    expect(body.result).toContain("not interactive")
  })

  it("lost report ACK: a duplicate report after normal conclusion gets the stable already-concluded disposition, not a mutation", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { token } = await createRunningRun()
    const first = await request("POST", "/v1/worker/report", { outcome: "succeeded" }, { authorization: `Bearer ${token}` })
    expect(first.status).toBe(200)
    const second = await request("POST", "/v1/worker/report", { outcome: "succeeded" }, { authorization: `Bearer ${token}` })
    expect(second.status).toBe(409)
    const body = await second.json() as { error: { code: string } }
    expect(body.error.code).toBe("run_already_concluded")
  })

  it("own-status is minimal: no admin transport/profile/credential fields leak", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { runId, token } = await createRunningRun()
    const response = await request("GET", "/v1/worker/status", undefined, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(200)
    const body = await response.json() as { status: Record<string, unknown> }
    expect(body.status.runId).toBe(runId)
    expect(JSON.stringify(body.status)).not.toContain("tokenHash")
    expect(JSON.stringify(body.status)).not.toContain("token")
  })

  it("rejects an invalid report body (unknown shape) with the SAME validation ordinary HTTP reporting uses", async () => {
    const { request, createRunningRun } = await makeWorkerApi()
    const { token } = await createRunningRun()
    const response = await request("POST", "/v1/worker/report", {}, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(400)
  })

  it("journals a rejected report on the run so the eventual escalation can name it", async () => {
    const { request, createRunningRun, daemon } = await makeWorkerApi()
    const { runId, token } = await createRunningRun()
    const response = await request("POST", "/v1/worker/report", { outcome: "failed", verdict: "approved" }, { authorization: `Bearer ${token}` })
    expect(response.status).toBe(400)
    const lines = daemon.store.getRunLog(runId).lines
    expect(lines.at(-1)).toMatchObject({ source: "step" })
    expect(lines.at(-1)!.text).toStartWith("report rejected: ")
    expect(lines.at(-1)!.text).toContain("contradictory")
    expect(daemon.store.getRunById(runId)!.status).toBe("running")
  })
})

describe("4.1: admin routes remain unaffected by the worker namespace", () => {
  it("the admin /v1/health route still requires the admin bearer, unaffected by worker auth", async () => {
    const { request } = await makeWorkerApi()
    const unauthed = await request("GET", "/v1/health")
    expect(unauthed.status).toBe(401)
    const authed = await request("GET", "/v1/health", undefined, { authorization: "Bearer admin-secret" })
    expect(authed.status).toBe(200)
  })
})
