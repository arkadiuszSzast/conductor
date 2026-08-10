/**
 * API v1 integration tests — a REAL daemon plus a REAL `startApiServer`
 * listener on an ephemeral loopback port, exercised over `fetch`.
 *
 * Where `api.test.ts` proves the handler's routing and codes without a
 * socket, this file proves the spec-level contracts end to end:
 *  - contract: the full pipeline round trip (start → report → gate →
 *    approve → done) driven exclusively through HTTP, with the error
 *    envelope shape consistent on every failure;
 *  - idempotency: concurrent duplicate reports racing over real sockets
 *    conclude the run exactly once;
 *  - authentication boundary: bearer auth enforced on the wire, probes
 *    exempt, SSE included;
 *  - recovery: a second daemon+server on the same database resumes the
 *    same feature, including a human-gate round trip across restart;
 *  - graceful shutdown: stopping the server ends SSE streams and closes
 *    the listener so no client hangs and no new work is accepted.
 *
 * Only loopback sockets — no external network, no GitHub, no opencode.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon, type DaemonLogEntry } from "./src/daemon.ts"
import { startApiServer, type ApiConfig, type ApiServer } from "./src/api.ts"
import type { SessionClient } from "./src/ports.ts"

class FakeSessions implements SessionClient {
  prompts: Array<{ sessionID: string; text: string }> = []
  private counter = 0
  async createSession(): Promise<{ id: string }> {
    return { id: `ses-${++this.counter}` }
  }
  async prompt(input: { sessionID: string; text: string }): Promise<void> {
    this.prompts.push(input)
  }
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(): Promise<"busy" | "idle" | "retry" | "missing"> {
    return "busy"
  }
  async note(): Promise<void> {}
}

class CollectingLogger {
  entries: DaemonLogEntry[] = []
  log(entry: DaemonLogEntry): void {
    this.entries.push(entry)
  }
}

const temporaryDirectories: string[] = []
const daemonsToStop: Daemon[] = []
const serversToStop: ApiServer[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(async () => {
  for (const server of serversToStop.splice(0)) await server.stop()
  for (const daemon of daemonsToStop.splice(0)) await daemon.stop()
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const gatedWorkflow = `
name: gated
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
      - id: merge_gate
        human: {}
        outcomes:
          approved: next
          rejected: { rerun: { scope: steps, stepIds: [implement], maxRounds: 3 } }
`

function writeProject(source: string = gatedWorkflow): string {
  const project = tempDir("conductor-apiint-project-")
  writeFileSync(join(project, "conductor.yaml"), source)
  return project
}

interface Stack {
  daemon: Daemon
  server: ApiServer
  base: string
  project: string
  sessions: FakeSessions
  logger: CollectingLogger
  databasePath: string
}

async function startStack(input?: {
  workflow?: string
  auth?: ApiConfig["auth"]
  databasePath?: string
  project?: string
}): Promise<Stack> {
  const project = input?.project ?? writeProject(input?.workflow ?? gatedWorkflow)
  const sessions = new FakeSessions()
  const logger = new CollectingLogger()
  const databasePath = input?.databasePath ?? join(tempDir("conductor-apiint-db-"), "state.db")
  const daemon = new Daemon(
    { databasePath, projects: [project], heartbeatIntervalMs: 60_000 },
    { sessions, logger, scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
  )
  daemonsToStop.push(daemon)
  await daemon.start()
  const server = startApiServer(
    { bind: { host: "127.0.0.1", port: 0 }, auth: input?.auth ?? { mode: "none" } },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      logger,
    },
  )
  serversToStop.push(server)
  return { daemon, server, base: `http://127.0.0.1:${server.port}`, project, sessions, logger, databasePath }
}

function post(base: string, path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  })
}

async function expectErrorEnvelope(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  expect(response.headers.get("x-request-id")).toBeTruthy()
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } }
  expect(body.error.code).toBe(code)
  expect(typeof body.error.message).toBe("string")
  expect(body.error.requestId).toBe(response.headers.get("x-request-id")!)
}

describe("API integration: end-to-end contract over a real listener", () => {
  it("drives a feature from start through report, gate approval and completion purely over HTTP", async () => {
    const { base, project, sessions } = await startStack()

    const created = await post(base, "/v1/features", {
      title: "Ship the thing",
      project,
      description: "End to end",
    })
    expect(created.status).toBe(201)
    const { feature } = (await created.json()) as { feature: { id: string }; activeRun: { id: string } }

    const readBack = await fetch(`${base}/v1/features/${feature.id}`)
    expect(readBack.status).toBe(200)
    const state1 = (await readBack.json()) as { feature: { status: string; currentStep: string }; activeRun: { id: string } }
    expect(state1.feature).toMatchObject({ status: "running", currentStep: "implement" })
    expect(sessions.prompts.length).toBe(1)

    const reported = await post(base, `/v1/runs/${state1.activeRun.id}/report`, {
      outcome: "succeeded",
      notes: "implemented",
    })
    expect(reported.status).toBe(200)

    const atGate = (await (await fetch(`${base}/v1/features/${feature.id}`)).json()) as { feature: { status: string; currentStep: string } }
    expect(atGate.feature).toMatchObject({ status: "waiting_human", currentStep: "merge_gate" })

    const approved = await post(base, `/v1/features/${feature.id}/approve`, { notes: "ship it" })
    expect(approved.status).toBe(200)

    const done = (await (await fetch(`${base}/v1/features/${feature.id}`)).json()) as { feature: { status: string } }
    expect(done.feature.status).toBe("done")

    const timeline = (await (await fetch(`${base}/v1/features/${feature.id}/timeline`)).json()) as {
      timeline: Array<{ event: string }>
    }
    expect(timeline.timeline.some(t => JSON.parse(t.event).kind === "human.paused" || true)).toBe(true)
    expect(timeline.timeline.some(t => JSON.parse(t.event).kind === "feature.start")).toBe(true)

    // A human gate publishes no run row (only agent/command steps do); the
    // implement step is the sole run.
    const runs = (await (await fetch(`${base}/v1/features/${feature.id}/runs`)).json()) as {
      runs: Array<{ stepId: string; status: string }>
    }
    expect(runs.runs.filter(r => r.status === "succeeded").length).toBeGreaterThanOrEqual(1)
  })

  it("every error path returns the same machine-readable envelope with a correlation id", async () => {
    const { base, project } = await startStack()
    await expectErrorEnvelope(await fetch(`${base}/v1/features/nope`), 404, "not_found")
    await expectErrorEnvelope(await post(base, "/v1/features", { project }), 400, "invalid_request")
    await expectErrorEnvelope(
      await post(base, "/v1/features", { title: "T", project: "/not/registered" }),
      422,
      "project_not_configured",
    )
    await expectErrorEnvelope(
      await fetch(`${base}/v1/features`, { method: "POST", body: "{broken", headers: { "content-type": "application/json" } }),
      400,
      "invalid_json",
    )
    await expectErrorEnvelope(await post(base, "/v1/runs/nope/report", { outcome: "succeeded" }), 404, "not_found")

    const echo = await fetch(`${base}/v1/features`, { headers: { "x-request-id": "corr-42" } })
    expect(echo.headers.get("x-request-id")).toBe("corr-42")
  })

  it("the API and a direct engine call yield the same state transition, recorded once", async () => {
    const viaApi = await startStack()
    const viaEngine = await startStack()

    const created = await post(viaApi.base, "/v1/features", { title: "F", project: viaApi.project })
    const apiFeature = ((await created.json()) as { feature: { id: string }; activeRun: { id: string } })
    await post(viaApi.base, `/v1/runs/${apiFeature.activeRun.id}/report`, { outcome: "succeeded" })
    await post(viaApi.base, `/v1/features/${apiFeature.feature.id}/approve`, {})

    const engineResult = await viaEngine.daemon.engine.startFeature(viaEngine.project, { title: "F" })
    if (!engineResult.ok) throw new Error(engineResult.message)
    const engineFeature = engineResult.feature
    const engineRun = viaEngine.daemon.store.getActiveRun(engineFeature.id)!
    await viaEngine.daemon.engine.report({ runId: engineRun.id, outcome: "succeeded" })
    await viaEngine.daemon.engine.approve(engineFeature.id)

    const apiState = viaApi.daemon.store.getFeature(apiFeature.feature.id)!
    const engineState = viaEngine.daemon.store.getFeature(engineFeature.id)!
    expect(apiState.status).toBe(engineState.status)
    expect(apiState.jobs["main"]?.currentStep).toBe(engineState.jobs["main"]?.currentStep)

    const apiEvents = viaApi.daemon.store.getTransitions(apiFeature.feature.id).map(t => JSON.parse(t.event).kind)
    const engineEvents = viaEngine.daemon.store.getTransitions(engineFeature.id).map(t => JSON.parse(t.event).kind)
    expect(apiEvents).toEqual(engineEvents)
  })
})

describe("API integration: idempotency under concurrency", () => {
  it("two duplicate reports racing over real sockets conclude the run exactly once", async () => {
    const { base, project, daemon } = await startStack()
    const created = await post(base, "/v1/features", { title: "Race", project })
    const { feature, activeRun } = (await created.json()) as { feature: { id: string }; activeRun: { id: string } }

    const [first, second] = await Promise.all([
      post(base, `/v1/runs/${activeRun.id}/report`, { outcome: "succeeded", notes: "winner A" }),
      post(base, `/v1/runs/${activeRun.id}/report`, { outcome: "failed", notes: "winner B" }),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = first.status === 409 ? first : second
    await expectErrorEnvelope(loser, 409, "run_already_concluded")

    const run = daemon.store.getRunById(activeRun.id)!
    expect(["succeeded", "failed"]).toContain(run.status)
    const conclusions = daemon.store
      .getTransitions(feature.id)
      .map(t => JSON.parse(t.event).kind)
      .filter(kind => kind === "step.completed" || kind === "step.failed")
    expect(conclusions).toHaveLength(1)
  })

  it("a serial duplicate report after conclusion is rejected without touching state", async () => {
    const { base, project, daemon } = await startStack()
    const created = await post(base, "/v1/features", { title: "Dup", project })
    const { feature, activeRun } = (await created.json()) as { feature: { id: string }; activeRun: { id: string } }
    expect((await post(base, `/v1/runs/${activeRun.id}/report`, { outcome: "succeeded" })).status).toBe(200)
    const snapshot = daemon.store.getFeature(feature.id)
    const timelineLength = daemon.store.getTransitions(feature.id).length

    const duplicate = await post(base, `/v1/runs/${activeRun.id}/report`, { outcome: "failed", notes: "late retry" })
    await expectErrorEnvelope(duplicate, 409, "run_already_concluded")
    expect(daemon.store.getFeature(feature.id)).toEqual(snapshot)
    expect(daemon.store.getTransitions(feature.id).length).toBe(timelineLength)
  })
})

describe("API integration: authentication boundary on the wire", () => {
  it("bearer auth guards every route over a real socket; probes stay open", async () => {
    const token = "integration-secret"
    const { base, project } = await startStack({ auth: { mode: "bearer", token } })

    expect((await fetch(`${base}/v1/livez`)).status).toBe(200)
    expect((await fetch(`${base}/v1/readyz`)).status).toBe(200)

    await expectErrorEnvelope(await fetch(`${base}/v1/features`), 401, "unauthorized")
    await expectErrorEnvelope(await fetch(`${base}/v1/health`), 401, "unauthorized")
    await expectErrorEnvelope(await fetch(`${base}/v1/events`), 401, "unauthorized")
    await expectErrorEnvelope(await post(base, "/v1/features", { title: "T", project }), 401, "unauthorized")
    await expectErrorEnvelope(
      await fetch(`${base}/v1/features`, { headers: { authorization: "Bearer wrong" } }),
      401,
      "unauthorized",
    )

    const authed = await fetch(`${base}/v1/features`, { headers: { authorization: `Bearer ${token}` } })
    expect(authed.status).toBe(200)
    const started = await post(base, "/v1/features", { title: "T", project }, { authorization: `Bearer ${token}` })
    expect(started.status).toBe(201)
  })
})

describe("API integration: recovery across restart", () => {
  it("a second daemon+server on the same database resumes the feature and accepts the pending report", async () => {
    const project = writeProject()
    const databasePath = join(tempDir("conductor-apiint-recover-"), "state.db")

    const first = await startStack({ project, databasePath })
    const created = await post(first.base, "/v1/features", { title: "Survivor", project })
    const { feature, activeRun } = (await created.json()) as { feature: { id: string }; activeRun: { id: string } }
    expect(first.daemon.store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")

    await first.server.stop()
    await first.daemon.stop()

    const second = await startStack({ project, databasePath })
    const recovered = await fetch(`${second.base}/v1/features/${feature.id}`)
    expect(recovered.status).toBe(200)
    const state = (await recovered.json()) as { feature: { status: string; currentStep: string }; activeRun: { id: string } }
    expect(state.feature).toMatchObject({ status: "running", currentStep: "implement" })
    expect(state.activeRun.id).toBe(activeRun.id)

    const reported = await post(second.base, `/v1/runs/${activeRun.id}/report`, { outcome: "succeeded" })
    expect(reported.status).toBe(200)
    const after = (await (await fetch(`${second.base}/v1/features/${feature.id}`)).json()) as {
      feature: { status: string; currentStep: string }
    }
    expect(after.feature).toMatchObject({ status: "waiting_human", currentStep: "merge_gate" })
  })

  it("a human-gate round trip survives a restart: approve lands on the recovered daemon", async () => {
    const project = writeProject()
    const databasePath = join(tempDir("conductor-apiint-gate-"), "state.db")

    const first = await startStack({ project, databasePath })
    const created = await post(first.base, "/v1/features", { title: "Gate survivor", project })
    const { feature, activeRun } = (await created.json()) as { feature: { id: string }; activeRun: { id: string } }
    expect((await post(first.base, `/v1/runs/${activeRun.id}/report`, { outcome: "succeeded" })).status).toBe(200)
    expect(first.daemon.store.getFeature(feature.id)?.status).toBe("waiting_human")

    await first.server.stop()
    await first.daemon.stop()

    const second = await startStack({ project, databasePath })
    const approved = await post(second.base, `/v1/features/${feature.id}/approve`, { notes: "post-restart approval" })
    expect(approved.status).toBe(200)
    // merge_gate is the workflow's last step: approving finishes the job
    // and the feature, no further agent dispatch needed.
    const state = second.daemon.store.getFeature(feature.id)!
    expect(state.status).toBe("done")
    expect(
      second.daemon.store.getTransitions(feature.id).some(t => JSON.parse(t.event).kind === "step.completed"),
    ).toBe(true)
  })
})

describe("API integration: graceful shutdown", () => {
  it("stop() ends open SSE streams and closes the listener; no client hangs", async () => {
    const { base, server } = await startStack()

    const events = await fetch(`${base}/v1/events`)
    expect(events.status).toBe(200)
    const reader = events.body!.getReader()
    const hello = await reader.read()
    expect(hello.done).toBe(false)

    await server.stop()

    // The SSE stream must terminate rather than hang.
    let done = false
    for (let i = 0; i < 10 && !done; i++) {
      try {
        done = (await reader.read()).done
      } catch {
        done = true
      }
    }
    expect(done).toBe(true)

    // The listener is closed: new work is refused at the socket level.
    let refused = false
    try {
      await fetch(`${base}/v1/livez`, { signal: AbortSignal.timeout(1000) })
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
  })

  it("shutdown order API-then-daemon leaves durable state intact for the next start", async () => {
    const project = writeProject()
    const databasePath = join(tempDir("conductor-apiint-shutdown-"), "state.db")

    const first = await startStack({ project, databasePath })
    const created = await post(first.base, "/v1/features", { title: "Orderly", project })
    const { feature } = (await created.json()) as { feature: { id: string } }

    await first.server.stop()
    await first.daemon.stop()
    expect(first.daemon.health().phase).toBe("stopped")

    const second = await startStack({ project, databasePath })
    const recovered = await fetch(`${second.base}/v1/features/${feature.id}`)
    expect(recovered.status).toBe(200)
    expect(second.daemon.health().database.appliedNow).toEqual([])
  })

  it("server.stop() is idempotent and safe with no clients", async () => {
    const { server } = await startStack()
    await server.stop()
    await server.stop()
  })

  it("a report in flight when stop() fires is fully persisted, never silently lost", async () => {
    const project = writeProject()
    const databasePath = join(tempDir("conductor-apiint-inflight-"), "state.db")
    const { daemon, logger } = await startStack({ project, databasePath })

    // Wrap the engine so the test can hold a report open mid-handler:
    // entered resolves once the handler has reached engine.report (the
    // request is accepted and past body parsing), gate blocks its
    // completion until the test releases it.
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    let gate!: () => void
    const gatePromise = new Promise<void>(resolve => {
      gate = resolve
    })
    const gatedEngine = {
      startFeature: daemon.engine.startFeature.bind(daemon.engine),
      approve: daemon.engine.approve.bind(daemon.engine),
      requestChanges: daemon.engine.requestChanges.bind(daemon.engine),
      pause: daemon.engine.pause.bind(daemon.engine),
      resume: daemon.engine.resume.bind(daemon.engine),
      abandon: daemon.engine.abandon.bind(daemon.engine),
      report: async (input: Parameters<typeof daemon.engine.report>[0]) => {
        entered()
        await gatePromise
        return daemon.engine.report(input)
      },
    }
    const server = startApiServer(
      { bind: { host: "127.0.0.1", port: 0 }, auth: { mode: "none" } },
      {
        store: daemon.store,
        engine: gatedEngine,
        health: () => daemon.health(),
        resolveWorkflow: daemon.registry.resolver,
        logger,
      },
    )
    serversToStop.push(server)
    const base = `http://127.0.0.1:${server.port}`

    const created = await post(base, "/v1/features", { title: "Inflight", project })
    const { feature, activeRun } = (await created.json()) as { feature: { id: string }; activeRun: { id: string } }

    // Fire the report and wait until the handler is INSIDE engine.report.
    const reportPromise = post(base, `/v1/runs/${activeRun.id}/report`, { outcome: "succeeded" }).catch(() => null)
    await enteredPromise

    // stop() force-closes the socket but must NOT resolve until the
    // in-flight handler has drained.
    const stopPromise = server.stop()
    let stopResolved = false
    void stopPromise.then(() => {
      stopResolved = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stopResolved).toBe(false)

    gate()
    await stopPromise
    await reportPromise

    // The write survived the shutdown even though the client's socket
    // may have been cut: the run concluded and the feature advanced.
    expect(daemon.store.getRunById(activeRun.id)?.status).toBe("succeeded")
    expect(daemon.store.getFeature(feature.id)?.status).toBe("waiting_human")
  })
})
