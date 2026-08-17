/**
 * HTTP API v1 — routing, validation, command projection, SSE
 * invalidation and shutdown. The handler is exercised directly as a
 * fetch-style function (no socket); one integration block binds a real
 * listener on an ephemeral loopback port to prove startApiServer's
 * bind/stop semantics. Cross-client contract/idempotency/recovery
 * integration coverage lives in `api-integration.test.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon, type DaemonLogEntry } from "./src/daemon.ts"
import { createApi, startApiServer, type ApiConfig, type ConductorApi } from "./src/api.ts"
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

function writeProject(source: string = agentWorkflow): string {
  const project = tempDir("conductor-api-project-")
  writeFileSync(join(project, "conductor.yaml"), source)
  return project
}

async function makeApi(input?: {
  workflow?: string
  auth?: ApiConfig["auth"]
  ui?: ApiConfig["ui"]
}): Promise<{
  api: ConductorApi
  daemon: Daemon
  project: string
  sessions: FakeSessions
  logger: CollectingLogger
  request: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>
}> {
  const project = writeProject(input?.workflow ?? agentWorkflow)
  const sessions = new FakeSessions()
  const logger = new CollectingLogger()
  const daemon = new Daemon(
    {
      databasePath: join(tempDir("conductor-api-db-"), "state.db"),
      projects: [project],
      heartbeatIntervalMs: 60_000,
    },
    {
      sessions,
      logger,
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
    },
  )
  daemonsToStop.push(daemon)
  await daemon.start()
  const api = createApi(
    {
      bind: { host: "127.0.0.1", port: 0 },
      auth: input?.auth ?? { mode: "none" },
      ...(input?.ui !== undefined ? { ui: input.ui } : {}),
    },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      workflowStatus: (dir) => daemon.registry.getStatus(dir),
      registerProject: dir => daemon.registry.register(dir),
      logger,
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
  return { api, daemon, project, sessions, logger, request }
}

async function startFeature(
  request: (method: string, path: string, body?: unknown) => Promise<Response>,
  project: string,
  extra?: Record<string, unknown>,
): Promise<{ id: string; status: string; currentStep: string | null }> {
  const response = await request("POST", "/v1/features", { title: "Test feature", project, ...extra })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { feature: { id: string; status: string; currentStep: string | null } }
  return body.feature
}

describe("API: health and probes", () => {
  it("livez/readyz reflect daemon health and stay unauthenticated under bearer auth", async () => {
    const { request } = await makeApi({ auth: { mode: "bearer", token: "secret-token" } })
    const livez = await request("GET", "/v1/livez")
    expect(livez.status).toBe(200)
    expect(await livez.json()).toMatchObject({ alive: true, phase: "ready" })
    const readyz = await request("GET", "/v1/readyz")
    expect(readyz.status).toBe(200)
    expect(await readyz.json()).toMatchObject({ ready: true })
  })

  it("probes report 503 once the daemon has stopped", async () => {
    const { request, daemon } = await makeApi()
    await daemon.stop()
    const livez = await request("GET", "/v1/livez")
    expect(livez.status).toBe(503)
    const readyz = await request("GET", "/v1/readyz")
    expect(readyz.status).toBe(503)
  })

  it("/v1/health serves the daemon.health() snapshot verbatim", async () => {
    const { request, daemon } = await makeApi()
    const response = await request("GET", "/v1/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(daemon.health())))
  })
})

describe("API: authentication boundary", () => {
  it("bearer mode rejects requests without the token and accepts the right one", async () => {
    const { request } = await makeApi({ auth: { mode: "bearer", token: "secret-token" } })
    const denied = await request("GET", "/v1/features")
    expect(denied.status).toBe(401)
    const body = (await denied.json()) as { error: { code: string; requestId: string } }
    expect(body.error.code).toBe("unauthorized")
    expect(body.error.requestId).toBeTruthy()

    const wrong = await request("GET", "/v1/features", undefined, { authorization: "Bearer nope" })
    expect(wrong.status).toBe(401)

    const allowed = await request("GET", "/v1/features", undefined, { authorization: "Bearer secret-token" })
    expect(allowed.status).toBe(200)
  })

  it("auth mode none is explicit and allows without a header", async () => {
    const { request } = await makeApi({ auth: { mode: "none" } })
    const response = await request("GET", "/v1/features")
    expect(response.status).toBe(200)
  })
})

describe("API: feature resources", () => {
  it("POST /v1/features starts a feature through the engine and returns 201 with durable ids", async () => {
    const { request, project, daemon, sessions } = await makeApi()
    const response = await request("POST", "/v1/features", {
      title: "Add dark mode",
      project,
      description: "Full description",
    })
    expect(response.status).toBe(201)
    expect(response.headers.get("x-request-id")).toBeTruthy()
    const body = (await response.json()) as { feature: { id: string; status: string; currentStep: string }; activeRun: { id: string } }
    expect(body.feature.status).toBe("running")
    expect(body.feature.currentStep).toBe("implement")
    expect(body.activeRun.id).toBeTruthy()
    expect(sessions.prompts.length).toBe(1)
    const timeline = daemon.store.getTransitions(body.feature.id)
    expect(timeline.some(t => t.event.kind === "feature.start")).toBe(true)
  })

  it("POST /v1/features validates the body with machine-readable codes", async () => {
    const { request, project, api } = await makeApi()
    const noTitle = await request("POST", "/v1/features", { project })
    expect(noTitle.status).toBe(400)
    expect(((await noTitle.json()) as { error: { code: string } }).error.code).toBe("invalid_request")

    const noProject = await request("POST", "/v1/features", { title: "T" })
    expect(noProject.status).toBe(400)

    const badPr = await request("POST", "/v1/features", { title: "T", project, pr: -1 })
    expect(badPr.status).toBe(400)

    const badJson = await api.handle(
      new Request("http://conductor.test/v1/features", { method: "POST", body: "{not json" }),
    )
    expect(badJson.status).toBe(400)
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe("invalid_json")
  })

  it("rejects an unregistered project and an unknown workflow with 422", async () => {
    const { request, project } = await makeApi()
    const badProject = await request("POST", "/v1/features", { title: "T", project: "/nowhere/at/all" })
    expect(badProject.status).toBe(422)
    expect(((await badProject.json()) as { error: { code: string } }).error.code).toBe("project_not_configured")

    const badWorkflow = await request("POST", "/v1/features", { title: "T", project, workflow: "missing" })
    expect(badWorkflow.status).toBe(422)
    expect(((await badWorkflow.json()) as { error: { code: string } }).error.code).toBe("unknown_workflow")
  })

  it("lists features with active/project filters and reads a single feature", async () => {
    const { request, project } = await makeApi()
    const feature = await startFeature(request, project)

    const list = await request("GET", "/v1/features")
    expect(list.status).toBe(200)
    expect(((await list.json()) as { features: unknown[] }).features).toHaveLength(1)

    const filtered = await request("GET", `/v1/features?project=${encodeURIComponent("/other/project")}`)
    expect(((await filtered.json()) as { features: unknown[] }).features).toHaveLength(0)

    const single = await request("GET", `/v1/features/${feature.id}`)
    expect(single.status).toBe(200)
    const body = (await single.json()) as { feature: { id: string }; activeRun: { stepId: string } }
    expect(body.feature.id).toBe(feature.id)
    expect(body.activeRun.stepId).toBe("implement")
  })

  it("unknown feature ids return 404 with a not_found code on every route", async () => {
    const { request } = await makeApi()
    for (const path of ["/v1/features/nope", "/v1/features/nope/runs", "/v1/features/nope/findings", "/v1/features/nope/timeline"]) {
      const response = await request("GET", path)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found")
    }
    const command = await request("POST", "/v1/features/nope/approve", {})
    expect(command.status).toBe(404)
  })

  it("serves runs, findings and timeline for a feature", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    daemon.store.insertFindings(feature.id, "implement", [
      { path: "src/a.ts", line: 3, severity: "major", tags: [], body: "bug" },
    ])

    const runs = await request("GET", `/v1/features/${feature.id}/runs`)
    const runsBody = (await runs.json()) as { runs: Array<{ stepId: string; status: string }> }
    expect(runsBody.runs).toHaveLength(1)
    expect(runsBody.runs[0]).toMatchObject({ stepId: "implement", status: "running" })

    const findings = await request("GET", `/v1/features/${feature.id}/findings`)
    const findingsBody = (await findings.json()) as { findings: Array<{ id: string; severity: string }> }
    expect(findingsBody.findings).toHaveLength(1)
    expect(findingsBody.findings[0]).toMatchObject({ id: "F1", severity: "major" })

    const timeline = await request("GET", `/v1/features/${feature.id}/timeline`)
    const timelineBody = (await timeline.json()) as { timeline: Array<{ decisions: Array<{ kind: string }> }> }
    expect(timelineBody.timeline.length).toBeGreaterThanOrEqual(1)
    expect(timelineBody.timeline.some(t => t.decisions.some(d => d.kind === "execute_step"))).toBe(true)
  })

  it("unknown routes and methods return 404", async () => {
    const { request } = await makeApi()
    expect((await request("GET", "/v1/nope")).status).toBe(404)
    expect((await request("DELETE", "/v1/features")).status).toBe(404)
    expect((await request("PUT", "/v1/features/abc")).status).toBe(404)
  })
})

describe("API: UI projections", () => {
  it("list and detail payloads carry createdAt/updatedAt from the store row", async () => {
    const { request, project } = await makeApi()
    const before = Date.now()
    const feature = await startFeature(request, project)

    const list = await request("GET", "/v1/features")
    const listBody = (await list.json()) as { features: Array<{ createdAt: number; updatedAt: number }> }
    expect(listBody.features[0]!.createdAt).toBeGreaterThanOrEqual(before)
    expect(listBody.features[0]!.updatedAt).toBeGreaterThanOrEqual(listBody.features[0]!.createdAt)

    const detail = await request("GET", `/v1/features/${feature.id}`)
    const detailBody = (await detail.json()) as { feature: { createdAt: number; updatedAt: number } }
    expect(detailBody.feature.createdAt).toBe(listBody.features[0]!.createdAt)
    expect(detailBody.feature.updatedAt).toBeGreaterThanOrEqual(detailBody.feature.createdAt)
  })

  it("detail returns full per-step runtime while the list keeps the summary", async () => {
    const { request, project } = await makeApi({ workflow: gatedWorkflow })
    const feature = await startFeature(request, project)
    const detailBefore = await request("GET", `/v1/features/${feature.id}`)
    const runId = ((await detailBefore.json()) as { activeRun: { id: string } }).activeRun.id
    await request("POST", `/v1/runs/${runId}/report`, { outcome: "succeeded", notes: "did the thing" })

    const detail = await request("GET", `/v1/features/${feature.id}`)
    const body = (await detail.json()) as {
      feature: {
        jobs: Record<string, {
          status: string
          currentStep: string | null
          attempts: Record<string, number>
          reruns: Record<string, number>
          outputs: Record<string, unknown>
          steps: Record<string, { status: string; outputs: Record<string, string> }>
        }>
      }
    }
    const main = body.feature.jobs["main"]!
    expect(main.steps["implement"]).toMatchObject({ status: "succeeded" })
    expect(main.steps["implement"]!.outputs["report"]).toBe("did the thing")
    expect(main.steps["merge_gate"]).toMatchObject({ status: "waiting_human" })
    expect(main.attempts).toBeDefined()
    expect(main.reruns).toBeDefined()

    const list = await request("GET", "/v1/features")
    const listBody = (await list.json()) as { features: Array<{ jobs: Record<string, Record<string, unknown>> }> }
    expect(Object.keys(listBody.features[0]!.jobs["main"]!).sort()).toEqual(["currentStep", "status"])
  })

  it("carries the rendered gate prompt on the waiting step and omits it for promptless gates", async () => {
    const promptedWorkflow = `
name: prompted
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
        human:
          prompt: "Questions: {{ steps.implement.outputs.report }}"
        outcomes:
          approved: next
`
    const { request, project } = await makeApi({ workflow: promptedWorkflow })
    const feature = await startFeature(request, project)
    const before = await request("GET", `/v1/features/${feature.id}`)
    const runId = ((await before.json()) as { activeRun: { id: string } }).activeRun.id
    await request("POST", `/v1/runs/${runId}/report`, { outcome: "succeeded", notes: "which db?" })

    const detail = await request("GET", `/v1/features/${feature.id}`)
    const body = (await detail.json()) as {
      feature: { status: string; jobs: Record<string, { steps: Record<string, { status: string; prompt?: string }> }> }
    }
    expect(body.feature.status).toBe("waiting_human")
    expect(body.feature.jobs["main"]!.steps["merge_gate"]!.prompt).toBe("Questions: which db?")
  })

  it("a promptless waiting gate carries no prompt field", async () => {
    const { request, project } = await makeApi({ workflow: gatedWorkflow })
    const feature = await startFeature(request, project)
    const before = await request("GET", `/v1/features/${feature.id}`)
    const runId = ((await before.json()) as { activeRun: { id: string } }).activeRun.id
    await request("POST", `/v1/runs/${runId}/report`, { outcome: "succeeded" })

    const detail = await request("GET", `/v1/features/${feature.id}`)
    const body = (await detail.json()) as {
      feature: { status: string; jobs: Record<string, { steps: Record<string, { status: string; prompt?: string }> }> }
    }
    expect(body.feature.status).toBe("waiting_human")
    expect(body.feature.jobs["main"]!.steps["merge_gate"]!.status).toBe("waiting_human")
    expect("prompt" in body.feature.jobs["main"]!.steps["merge_gate"]!).toBe(false)
  })

  it("truncates oversized step outputs in the detail and points at the newest run", async () => {
    const { request, project } = await makeApi()
    const feature = await startFeature(request, project)
    const detailBefore = await request("GET", `/v1/features/${feature.id}`)
    const runId = ((await detailBefore.json()) as { activeRun: { id: string } }).activeRun.id
    const longNotes = "x".repeat(2_000)
    await request("POST", `/v1/runs/${runId}/report`, { outcome: "succeeded", notes: longNotes })

    const detail = await request("GET", `/v1/features/${feature.id}`)
    const body = (await detail.json()) as {
      feature: { jobs: Record<string, { steps: Record<string, { outputs: Record<string, string>; truncated?: boolean; runId?: string }> }> }
    }
    const step = body.feature.jobs["main"]!.steps["implement"]!
    expect(step.outputs["report"]!.length).toBe(500)
    expect(step.truncated).toBe(true)
    expect(step.runId).toBe(runId)

    const run = await request("GET", `/v1/runs/${runId}`)
    const runBody = (await run.json()) as { run: { outputs: Record<string, string> } }
    expect(runBody.run.outputs["report"]).toBe(longNotes)
  })

  it("detail carries a workflowRef hint for the project's resolved workflow", async () => {
    const { request, project } = await makeApi()
    const feature = await startFeature(request, project)
    const detail = await request("GET", `/v1/features/${feature.id}`)
    const body = (await detail.json()) as { feature: { workflowRef: { name: string; stale: boolean } } }
    expect(body.feature.workflowRef).toEqual({ name: "agent-only", stale: false })
  })

  it("detail carries the rerun feedback snapshot; the list never does", async () => {
    const { request, project } = await makeApi({ workflow: gatedWorkflow })
    const feature = await startFeature(request, project)

    const before = await request("GET", `/v1/features/${feature.id}`)
    const beforeBody = (await before.json()) as { feature: { feedback: unknown }; activeRun: { id: string } }
    expect(beforeBody.feature.feedback).toBeNull()

    await request("POST", `/v1/runs/${beforeBody.activeRun.id}/report`, { outcome: "succeeded", notes: "done" })
    await request("POST", `/v1/features/${feature.id}/request-changes`, { notes: "fix the naming" })

    const after = await request("GET", `/v1/features/${feature.id}`)
    const afterBody = (await after.json()) as { feature: { feedback: { message: string; jobs: Record<string, unknown> } | null } }
    expect(afterBody.feature.feedback).not.toBeNull()
    expect(afterBody.feature.feedback!.message).toContain("rejected")
    expect(JSON.stringify(afterBody.feature.feedback!.jobs)).toContain("fix the naming")

    const list = await request("GET", "/v1/features")
    const listBody = (await list.json()) as { features: Array<Record<string, unknown>> }
    expect("feedback" in listBody.features[0]!).toBe(false)
  })

  it("filters the feature list by status and rejects unknown values", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const other = daemon.store.createFeature({ title: "Done one", slug: "done-one", projectDir: project, workflow: "agent-only" })
    daemon.store.applyTransition(other.id, { kind: "feature.start" }, { decisions: [], patch: { status: "done" } })

    const done = await request("GET", "/v1/features?status=done")
    const doneBody = (await done.json()) as { features: Array<{ id: string }> }
    expect(doneBody.features.map(f => f.id)).toEqual([other.id])

    const both = await request("GET", "/v1/features?status=done,running")
    expect(((await both.json()) as { features: unknown[] }).features).toHaveLength(2)
    expect(feature.id).toBeTruthy()

    const bad = await request("GET", "/v1/features?status=bogus")
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_request")
  })

  it("list items carry grouped findingCounts with zeros for finding-less features", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const bare = daemon.store.createFeature({ title: "Bare", slug: "bare", projectDir: project, workflow: "agent-only" })
    daemon.store.insertFindings(feature.id, "implement", [
      { path: "a.ts", line: 1, severity: "major", tags: [], body: "x" },
      { path: "b.ts", line: 2, severity: "minor", tags: [], body: "y" },
    ])
    daemon.store.setFindingStatus(feature.id, "F2", "dismissed", "not relevant")

    const list = await request("GET", "/v1/features")
    const body = (await list.json()) as { features: Array<{ id: string; findingCounts: Record<string, number> }> }
    const withFindings = body.features.find(f => f.id === feature.id)!
    const without = body.features.find(f => f.id === bare.id)!
    expect(withFindings.findingCounts).toEqual({ new: 1, fixed: 0, dismissed: 1, reopened: 0 })
    expect(without.findingCounts).toEqual({ new: 0, fixed: 0, dismissed: 0, reopened: 0 })
  })

  it("timeline serves event as a parsed object", async () => {
    const { request, project } = await makeApi()
    const feature = await startFeature(request, project)
    const timeline = await request("GET", `/v1/features/${feature.id}/timeline`)
    const body = (await timeline.json()) as { timeline: Array<{ event: { kind: string } }> }
    expect(body.timeline.some(t => t.event.kind === "feature.start")).toBe(true)
    for (const entry of body.timeline) expect(typeof entry.event).toBe("object")
  })
})

describe("API: project workflow structure", () => {
  it("returns the structure of a valid workflow without any authoring content", async () => {
    const { request, project } = await makeApi({ workflow: gatedWorkflow })
    const response = await request("GET", `/v1/projects/workflow?dir=${encodeURIComponent(project)}`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain("Implement it.")
    expect(text).not.toContain("prompt")
    const body = JSON.parse(text) as {
      name: string
      stale: boolean
      jobs: Record<string, { needs: string[]; steps: Array<{ id: string; kind: string }> }>
      diagnostics: unknown[]
    }
    expect(body.name).toBe("gated")
    expect(body.stale).toBe(false)
    expect(body.diagnostics).toEqual([])
    expect(body.jobs["main"]!.needs).toEqual([])
    expect(body.jobs["main"]!.steps).toEqual([
      { id: "implement", kind: "agent" },
      { id: "merge_gate", kind: "human" },
    ])
  })

  it("marks interactive agent steps in the projection", async () => {
    const interactiveWorkflow = gatedWorkflow.replace('prompt: "Implement it."', 'prompt: "Implement it."\n          interactive: true')
    const { request, project } = await makeApi({ workflow: interactiveWorkflow })
    const response = await request("GET", `/v1/projects/workflow?dir=${encodeURIComponent(project)}`)
    const body = (await response.json()) as { jobs: Record<string, { steps: Array<{ id: string; kind: string; interactive?: boolean }> }> }
    expect(body.jobs["main"]!.steps).toEqual([
      { id: "implement", kind: "agent", interactive: true },
      { id: "merge_gate", kind: "human" },
    ])
  })

  it("serves the last valid structure with stale=true and diagnostics after a broken reload", async () => {
    const { request, project, daemon } = await makeApi()
    writeFileSync(join(project, "conductor.yaml"), "name: [broken")
    daemon.registry.reload(project)
    const response = await request("GET", `/v1/projects/workflow?dir=${encodeURIComponent(project)}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { name: string; stale: boolean; diagnostics: unknown[] }
    expect(body.name).toBe("agent-only")
    expect(body.stale).toBe(true)
    expect(body.diagnostics.length).toBeGreaterThan(0)
  })

  it("responds 409 with diagnostics for a never-valid project and 404 for an unregistered one", async () => {
    const { request, daemon } = await makeApi()
    const broken = tempDir("conductor-api-broken-")
    writeFileSync(join(broken, "conductor.yaml"), "name: [broken")
    daemon.registry.register(broken)
    const invalid = await request("GET", `/v1/projects/workflow?dir=${encodeURIComponent(broken)}`)
    expect(invalid.status).toBe(409)
    expect(((await invalid.json()) as { error: { code: string; message: string } }).error.code).toBe("conflict")

    const unregistered = await request("GET", `/v1/projects/workflow?dir=${encodeURIComponent("/never/registered")}`)
    expect(unregistered.status).toBe(404)

    const missingDir = await request("GET", "/v1/projects/workflow")
    expect(missingDir.status).toBe(400)
  })
})

describe("API: static UI serving", () => {
  function writeSpa(): string {
    const dir = tempDir("conductor-api-ui-")
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>conductor ui</title>")
    mkdirSync(join(dir, "assets"))
    writeFileSync(join(dir, "assets", "app.js"), "console.log('ui')")
    return dir
  }

  it("serves index.html, assets by content type, and SPA fallback for client routes", async () => {
    const staticDir = writeSpa()
    const { request } = await makeApi({ ui: { staticDir } })

    const root = await request("GET", "/")
    expect(root.status).toBe(200)
    expect(root.headers.get("content-type")).toContain("text/html")
    expect(await root.text()).toContain("conductor ui")

    const asset = await request("GET", "/assets/app.js")
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("javascript")

    const fallback = await request("GET", "/features/abc-123")
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toContain("conductor ui")
  })

  it("keeps /v1 routes first and never emits CORS headers", async () => {
    const staticDir = writeSpa()
    const { request } = await makeApi({ ui: { staticDir } })
    const api = await request("GET", "/v1/features")
    expect(api.status).toBe(200)
    expect(api.headers.get("access-control-allow-origin")).toBeNull()

    const unknownApi = await request("GET", "/v1/definitely-not-a-route")
    expect(unknownApi.status).toBe(404)
    expect(((await unknownApi.json()) as { error: { code: string } }).error.code).toBe("not_found")

    const root = await request("GET", "/")
    expect(root.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("rejects path traversal outside the configured directory", async () => {
    // The secret sits at the LITERAL parent of staticDir, so a naive
    // `resolve(root, "../secret.txt")` without the prefix guard would
    // actually reach it — the fixture proves the guard, not luck.
    const parent = tempDir("conductor-api-ui-parent-")
    writeFileSync(join(parent, "secret.txt"), "top secret")
    const staticDir = join(parent, "dist")
    mkdirSync(staticDir)
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>conductor ui</title>")
    const { api } = await makeApi({ ui: { staticDir } })
    for (const path of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"]) {
      const response = await api.handle(new Request(`http://conductor.test${path}`))
      const text = await response.text()
      expect(text).not.toContain("top secret")
    }
  })

  it("serves static assets without a token under bearer auth while /v1 stays guarded", async () => {
    const staticDir = writeSpa()
    const { request } = await makeApi({ ui: { staticDir }, auth: { mode: "bearer", token: "secret-token" } })

    const root = await request("GET", "/")
    expect(root.status).toBe(200)
    expect(await root.text()).toContain("conductor ui")

    const asset = await request("GET", "/assets/app.js")
    expect(asset.status).toBe(200)

    const denied = await request("GET", "/v1/features")
    expect(denied.status).toBe(401)
    const allowed = await request("GET", "/v1/features", undefined, { authorization: "Bearer secret-token" })
    expect(allowed.status).toBe(200)
  })

  it("without ui config the root path stays the JSON 404 envelope", async () => {
    const { request } = await makeApi()
    const root = await request("GET", "/")
    expect(root.status).toBe(404)
    expect(((await root.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })
})

describe("API: human gates", () => {
  async function gatedFeature() {
    const context = await makeApi({ workflow: gatedWorkflow })
    const feature = await startFeature(context.request, context.project)
    const run = context.daemon.store.getActiveRun(feature.id)!
    const report = await context.request("POST", `/v1/runs/${run.id}/report`, { outcome: "succeeded" })
    expect(report.status).toBe(200)
    expect(context.daemon.store.getFeature(feature.id)?.status).toBe("waiting_human")
    return { ...context, feature }
  }

  it("approve routes through the engine and records the transition once", async () => {
    const { request, daemon, feature } = await gatedFeature()
    const before = daemon.store.getTransitions(feature.id).length
    const response = await request("POST", `/v1/features/${feature.id}/approve`, { notes: "ship it" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { result: string; feature: { status: string } }
    expect(body.result).toContain("Approved")
    const after = daemon.store.getTransitions(feature.id)
    expect(after.length).toBe(before + 1)
  })

  it("request-changes requires notes and reruns the gated step", async () => {
    const { request, daemon, feature } = await gatedFeature()
    const missingNotes = await request("POST", `/v1/features/${feature.id}/request-changes`, {})
    expect(missingNotes.status).toBe(400)
    expect(((await missingNotes.json()) as { error: { code: string } }).error.code).toBe("invalid_request")

    const response = await request("POST", `/v1/features/${feature.id}/request-changes`, { notes: "fix X" })
    expect(response.status).toBe(200)
    const state = daemon.store.getFeature(feature.id)!
    expect(state.jobs["main"]?.currentStep).toBe("implement")
    expect(state.status).toBe("running")
  })

  it("approve/request-changes on a feature that is not waiting return 409 conflict", async () => {
    const { request, project } = await makeApi()
    const feature = await startFeature(request, project)
    const approve = await request("POST", `/v1/features/${feature.id}/approve`, {})
    expect(approve.status).toBe(409)
    expect(((await approve.json()) as { error: { code: string } }).error.code).toBe("conflict")
    const reject = await request("POST", `/v1/features/${feature.id}/request-changes`, { notes: "n" })
    expect(reject.status).toBe(409)
  })

  it("pause and abandon on a terminal feature return 409 and never resurrect it", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    expect((await request("POST", `/v1/runs/${run.id}/report`, { outcome: "succeeded" })).status).toBe(200)
    expect(daemon.store.getFeature(feature.id)?.status).toBe("done")

    const pause = await request("POST", `/v1/features/${feature.id}/pause`)
    expect(pause.status).toBe(409)
    expect(((await pause.json()) as { error: { code: string } }).error.code).toBe("conflict")
    expect(daemon.store.getFeature(feature.id)?.status).toBe("done")

    const abandon = await request("POST", `/v1/features/${feature.id}/abandon`)
    expect(abandon.status).toBe(409)
    expect(daemon.store.getFeature(feature.id)?.status).toBe("done")

    const other = await startFeature(request, project)
    expect((await request("POST", `/v1/features/${other.id}/abandon`)).status).toBe(200)
    expect(daemon.store.getFeature(other.id)?.status).toBe("abandoned")
    expect((await request("POST", `/v1/features/${other.id}/pause`)).status).toBe(409)
    expect((await request("POST", `/v1/features/${other.id}/abandon`)).status).toBe(409)
    expect(daemon.store.getFeature(other.id)?.status).toBe("abandoned")
  })

  it("a gate command that loses the pre-check race still maps to 409 via the engine result", async () => {
    const { api, request, project, daemon } = await makeApi({ workflow: gatedWorkflow })
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    expect((await request("POST", `/v1/runs/${run.id}/report`, { outcome: "succeeded" })).status).toBe(200)
    expect(daemon.store.getFeature(feature.id)?.status).toBe("waiting_human")

    // Approve through the engine AFTER the API has read its snapshot:
    // stall the body read so the status flips mid-request.
    const stalledBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        await daemon.engine.approve(feature.id)
        controller.enqueue(new TextEncoder().encode("{}"))
        controller.close()
      },
    })
    const raced = await api.handle(
      new Request(`http://conductor.test/v1/features/${feature.id}/approve`, {
        method: "POST",
        body: stalledBody,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(raced.status).toBe(409)
    expect(((await raced.json()) as { error: { code: string } }).error.code).toBe("conflict")
  })

  it("pause, resume and abandon dispatch the same engine events", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)

    const paused = await request("POST", `/v1/features/${feature.id}/pause`)
    expect(paused.status).toBe(200)
    expect(daemon.store.getFeature(feature.id)?.status).toBe("paused")

    const resumed = await request("POST", `/v1/features/${feature.id}/resume`)
    expect(resumed.status).toBe(200)
    expect(daemon.store.getFeature(feature.id)?.status).toBe("running")

    const abandoned = await request("POST", `/v1/features/${feature.id}/abandon`)
    expect(abandoned.status).toBe(200)
    expect(daemon.store.getFeature(feature.id)?.status).toBe("abandoned")
  })
})

describe("API: run reports", () => {
  it("reports an outcome through the engine and advances the feature", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    const response = await request("POST", `/v1/runs/${run.id}/report`, { outcome: "succeeded", notes: "done" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { result: string; run: { status: string } }
    expect(body.result).toContain("succeeded")
    expect(body.run.status).toBe("succeeded")
    expect(daemon.store.getFeature(feature.id)?.status).toBe("done")
  })

  it("rejects a duplicate report idempotently with 409 and leaves state unchanged", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    expect((await request("POST", `/v1/runs/${run.id}/report`, { outcome: "succeeded" })).status).toBe(200)
    const stateAfterFirst = daemon.store.getFeature(feature.id)
    const timelineAfterFirst = daemon.store.getTransitions(feature.id).length

    const duplicate = await request("POST", `/v1/runs/${run.id}/report`, { outcome: "failed" })
    expect(duplicate.status).toBe(409)
    expect(((await duplicate.json()) as { error: { code: string } }).error.code).toBe("run_already_concluded")
    expect(daemon.store.getFeature(feature.id)).toEqual(stateAfterFirst)
    expect(daemon.store.getTransitions(feature.id).length).toBe(timelineAfterFirst)
  })

  it("a verdict whose text contains 'already concluded' is not misreported as a duplicate", async () => {
    const trickyWorkflow = `
name: tricky
on: [manual]
roles:
  reviewer: { agent: review }
jobs:
  main:
    steps:
      - id: review
        agent:
          role: reviewer
          prompt: "go"
        outcomes:
          "already concluded": next
`
    const { request, project, daemon } = await makeApi({ workflow: trickyWorkflow })
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    const response = await request("POST", `/v1/runs/${run.id}/report`, { verdict: "already concluded" })
    expect(response.status).toBe(200)
    expect(daemon.store.getFeature(feature.id)?.status).toBe("done")
  })

  it("validates report bodies: unknown run, missing outcome/verdict, both at once", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!

    const unknown = await request("POST", "/v1/runs/nope/report", { outcome: "succeeded" })
    expect(unknown.status).toBe(404)

    const neither = await request("POST", `/v1/runs/${run.id}/report`, {})
    expect(neither.status).toBe(400)

    const contradictory = await request("POST", `/v1/runs/${run.id}/report`, { outcome: "failed", verdict: "approved" })
    expect(contradictory.status).toBe(400)

    const badOutcome = await request("POST", `/v1/runs/${run.id}/report`, { outcome: "maybe" })
    expect(badOutcome.status).toBe(400)

    expect(daemon.store.getRunById(run.id)?.status).toBe("running")
  })

  it("reads a single run", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    const response = await request("GET", `/v1/runs/${run.id}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { run: { id: string; stepId: string; status: string } }
    expect(body.run).toMatchObject({ id: run.id, stepId: "implement", status: "running" })
  })
})

describe("API: run logs", () => {
  interface LogPage {
    lines: Array<{ seq: number; time: number; source: string; text: string }>
    nextSeq: number
    truncated: boolean
  }

  it("GET returns appended lines with the cursor contract", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    daemon.store.appendRunLog(run.id, [
      { source: "process", text: "line one" },
      { source: "process", text: "line two" },
      { source: "process", text: "line three" },
    ])

    const first = await request("GET", `/v1/runs/${run.id}/logs?limit=2`)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as LogPage
    expect(firstBody.lines.map(line => line.text)).toEqual(["line one", "line two"])
    expect(firstBody.lines.map(line => line.source)).toEqual(["process", "process"])
    expect(firstBody.lines[0]!.seq).toBe(1)
    expect(firstBody.lines[0]!.time).toBeGreaterThan(0)
    expect(firstBody.nextSeq).toBe(2)
    expect(firstBody.truncated).toBe(true)

    const tail = await request("GET", `/v1/runs/${run.id}/logs?after=${firstBody.nextSeq}`)
    expect(tail.status).toBe(200)
    const tailBody = (await tail.json()) as LogPage
    expect(tailBody.lines.map(line => line.text)).toEqual(["line three"])
    expect(tailBody.nextSeq).toBe(3)
    expect(tailBody.truncated).toBe(false)

    const empty = await request("GET", `/v1/runs/${run.id}/logs?after=3`)
    expect((await empty.json()) as LogPage).toEqual({ lines: [], nextSeq: 3, truncated: false })
  })

  it("GET clamps limit to the hard maximum", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    daemon.store.appendRunLog(run.id, Array.from({ length: 5 }, (_, i) => ({ source: "step" as const, text: `l${i + 1}` })))
    const response = await request("GET", `/v1/runs/${run.id}/logs?limit=1`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as LogPage
    expect(body.lines).toHaveLength(1)
    expect(body.truncated).toBe(true)

    const bad = await request("GET", `/v1/runs/${run.id}/logs?limit=0`)
    expect(bad.status).toBe(400)
    const badAfter = await request("GET", `/v1/runs/${run.id}/logs?after=-1`)
    expect(badAfter.status).toBe(400)
  })

  it("GET on an unknown run is 404", async () => {
    const { request } = await makeApi()
    const response = await request("GET", "/v1/runs/does-not-exist/logs")
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })

  it("POST appends a batch with the default step source", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!

    const response = await request("POST", `/v1/runs/${run.id}/logs`, {
      lines: [{ text: "checkpoint one" }, { text: "checkpoint two", source: "agent" }],
    })
    expect(response.status).toBe(201)
    expect(((await response.json()) as { appended: number }).appended).toBe(2)

    const page = (await (await request("GET", `/v1/runs/${run.id}/logs`)).json()) as LogPage
    expect(page.lines.map(line => [line.source, line.text])).toEqual([
      ["step", "checkpoint one"],
      ["agent", "checkpoint two"],
    ])
  })

  it("POST validates the body and the source values", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!

    const noLines = await request("POST", `/v1/runs/${run.id}/logs`, {})
    expect(noLines.status).toBe(400)

    const badSource = await request("POST", `/v1/runs/${run.id}/logs`, { lines: [{ text: "x", source: "process" }] })
    expect(badSource.status).toBe(400)
    expect(((await badSource.json()) as { error: { message: string } }).error.message).toContain("source")

    const badShape = await request("POST", `/v1/runs/${run.id}/logs`, { lines: ["not an object"] })
    expect(badShape.status).toBe(400)

    const unknownRun = await request("POST", "/v1/runs/nope/logs", { lines: [{ text: "x" }] })
    expect(unknownRun.status).toBe(404)
  })

  it("POST rejects an oversized line with 400 before touching the store", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    const response = await request("POST", `/v1/runs/${run.id}/logs`, {
      lines: [{ text: "x".repeat(64 * 1024 + 1) }],
    })
    expect(response.status).toBe(400)
    expect(daemon.store.getRunLog(run.id).lines).toEqual([])
  })

  it("POST loses the race to a concurrent conclusion: the store's atomic guard maps to 409", async () => {
    const { api, request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!

    // Simulate the TOCTOU window: the handler snapshots the run as
    // running, then the run concludes while the request body is still
    // being read. A streamed body whose read yields lets the conclusion
    // land between the pre-check and the append.
    let releaseBody!: () => void
    const gate = new Promise<void>(resolve => {
      releaseBody = resolve
    })
    const encoderLocal = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate
        controller.enqueue(encoderLocal.encode(JSON.stringify({ lines: [{ text: "raced" }] })))
        controller.close()
      },
    })
    const pending = api.handle(
      new Request(`http://conductor.test/v1/runs/${run.id}/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    )
    await request("POST", `/v1/runs/${run.id}/report`, { outcome: "succeeded" })
    releaseBody()
    const raced = await pending
    expect(raced.status).toBe(409)
    expect(((await raced.json()) as { error: { code: string } }).error.code).toBe("run_already_concluded")
    expect(daemon.store.getRunLog(run.id).lines).toEqual([])
  })

  it("POST rejects appends to a concluded run with 409", async () => {
    const { request, project, daemon } = await makeApi()
    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    await request("POST", `/v1/runs/${run.id}/report`, { outcome: "succeeded" })
    expect(daemon.store.getRunById(run.id)?.status).toBe("succeeded")

    const late = await request("POST", `/v1/runs/${run.id}/logs`, { lines: [{ text: "late flush" }] })
    expect(late.status).toBe(409)
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe("run_already_concluded")
  })

  it("log routes sit behind the auth boundary", async () => {
    const { api } = await makeApi({ auth: { mode: "bearer", token: "secret-token" } })
    const denied = await api.handle(new Request("http://conductor.test/v1/runs/x/logs"))
    expect(denied.status).toBe(401)
  })

  it("appending log lines emits a run_log SSE invalidation event", async () => {
    const { api, request, project, daemon } = await makeApi()
    const events = await api.handle(new Request("http://conductor.test/v1/events"))
    const reader = events.body!.getReader()
    const readFrames = async (until: (text: string) => boolean): Promise<string> => {
      const decoder = new TextDecoder()
      let buffered = ""
      while (!until(buffered)) {
        const { done, value } = await reader.read()
        if (done) break
        buffered += decoder.decode(value)
      }
      return buffered
    }
    await readFrames(text => text.includes("event: hello"))

    const feature = await startFeature(request, project)
    const run = daemon.store.getActiveRun(feature.id)!
    daemon.store.appendRunLog(run.id, [{ source: "step", text: "hi" }])
    const frame = await readFrames(text => text.includes('"kind":"run_log"'))
    expect(frame).toContain('"kind":"run_log"')
    expect(frame).toContain(`"featureId":"${feature.id}"`)
    reader.cancel()
  })
})

describe("API: SSE invalidation events", () => {
  async function readFrames(
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
    until: (buffered: string) => boolean,
  ): Promise<string> {
    const decoder = new TextDecoder()
    let buffered = ""
    while (!until(buffered)) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value)
    }
    return buffered
  }

  it("a subscriber receives an invalidation event after a transition and a finding", async () => {
    const { api, request, project, daemon } = await makeApi()
    const events = await api.handle(new Request("http://conductor.test/v1/events"))
    expect(events.status).toBe(200)
    expect(events.headers.get("content-type")).toBe("text/event-stream")
    const reader = events.body!.getReader()
    await readFrames(reader, text => text.includes("event: hello"))
    expect(api.sseClientCount).toBe(1)

    const feature = await startFeature(request, project)
    const afterStart = await readFrames(reader, text => text.includes('"kind":"transition"'))
    expect(afterStart).toContain(`"featureId":"${feature.id}"`)

    daemon.store.insertFindings(feature.id, "implement", [
      { path: "a.ts", line: 1, severity: "minor", tags: [], body: "b" },
    ])
    const afterFinding = await readFrames(reader, text => text.includes('"kind":"finding"'))
    expect(afterFinding).toContain('"kind":"finding"')
    reader.cancel()
  })

  it("close() ends every SSE stream so shutdown never hangs on a subscriber", async () => {
    const { api } = await makeApi()
    const events = await api.handle(new Request("http://conductor.test/v1/events"))
    const reader = events.body!.getReader()
    await readFrames(reader, text => text.includes("event: hello"))
    expect(api.sseClientCount).toBe(1)

    api.close()
    expect(api.sseClientCount).toBe(0)
    const { done } = await reader.read()
    expect(done).toBe(true)

    const afterClose = await api.handle(new Request("http://conductor.test/v1/events"))
    expect(afterClose.status).toBe(409)
  })

  it("events endpoint honors the auth boundary", async () => {
    const { api } = await makeApi({ auth: { mode: "bearer", token: "secret-token" } })
    const denied = await api.handle(new Request("http://conductor.test/v1/events"))
    expect(denied.status).toBe(401)
  })
})

describe("API: request correlation and logging", () => {
  it("echoes a caller-provided x-request-id and generates one otherwise", async () => {
    const { request } = await makeApi()
    const provided = await request("GET", "/v1/features", undefined, { "x-request-id": "req-123" })
    expect(provided.headers.get("x-request-id")).toBe("req-123")
    const generated = await request("GET", "/v1/features")
    expect(generated.headers.get("x-request-id")).toBeTruthy()
  })

  it("logs each request with method, path and status — never a bearer token", async () => {
    const { request, logger } = await makeApi({ auth: { mode: "bearer", token: "super-secret-token" } })
    await request("GET", "/v1/features", undefined, { authorization: "Bearer super-secret-token" })
    const entry = logger.entries.find(e => e.message === "api request")
    expect(entry).toBeDefined()
    expect(entry!.fields).toMatchObject({ method: "GET", path: "/v1/features", status: 200 })
    for (const logged of logger.entries) {
      expect(JSON.stringify(logged)).not.toContain("super-secret-token")
    }
  })
})

describe("API: real listener on an ephemeral loopback port", () => {
  it("startApiServer binds the explicit host/port, serves requests and stops cleanly with open SSE streams", async () => {
    const { daemon, logger } = await makeApi()
    const server = startApiServer(
      { bind: { host: "127.0.0.1", port: 0 }, auth: { mode: "none" } },
      {
        store: daemon.store,
        engine: daemon.engine,
        health: () => daemon.health(),
        resolveWorkflow: daemon.registry.resolver,
        workflowStatus: (dir) => daemon.registry.getStatus(dir),
        logger,
      },
    )
    try {
      expect(server.port).toBeGreaterThan(0)
      const base = `http://127.0.0.1:${server.port}`

      const livez = await fetch(`${base}/v1/livez`)
      expect(livez.status).toBe(200)

      const events = await fetch(`${base}/v1/events`)
      expect(events.status).toBe(200)
      const reader = events.body!.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)

      await server.stop()
      await server.stop()
    } finally {
      await server.stop()
    }
    expect(logger.entries.some(e => e.message === "api stopped")).toBe(true)
  })
})

describe("API: runtime project registration", () => {
  it("registers a valid project live and makes it startable", async () => {
    const { request } = await makeApi()
    const newProject = writeProject()
    const response = await request("POST", "/v1/projects", { dir: newProject })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { project: string; workflow: string }
    expect(body.project).toBe(newProject)
    expect(typeof body.workflow).toBe("string")

    const started = await request("POST", "/v1/features", { title: "On the new project", project: newProject })
    expect(started.status).toBe(201)
  })

  it("re-registering the same directory is idempotent", async () => {
    const { request, project } = await makeApi()
    const first = await request("POST", "/v1/projects", { dir: project })
    expect(first.status).toBe(200)
    const second = await request("POST", "/v1/projects", { dir: project })
    expect(second.status).toBe(200)
  })

  it("rejects an invalid project with diagnostics and leaves the set unchanged", async () => {
    const { request, daemon } = await makeApi()
    const broken = tempDir("conductor-api-broken-")
    writeFileSync(join(broken, "conductor.yaml"), "name: [")
    const response = await request("POST", "/v1/projects", { dir: broken })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string }; diagnostics: unknown[] }
    expect(body.error.code).toBe("project_not_configured")
    expect(body.diagnostics.length).toBeGreaterThan(0)
    expect(daemon.registry.getStatus(broken).state).toBe("invalid")
  })

  it("requires a dir field", async () => {
    const { request } = await makeApi()
    const response = await request("POST", "/v1/projects", {})
    expect(response.status).toBe(400)
  })

  it("is authenticated like every command route", async () => {
    const { request } = await makeApi({ auth: { mode: "bearer", token: "tok" } })
    const anonymous = await request("POST", "/v1/projects", { dir: "/x" })
    expect(anonymous.status).toBe(401)
  })
})

describe("API: project registration absent", () => {
  it("404s when no registerProject dep is wired", async () => {
    const project = writeProject()
    const sessions = new FakeSessions()
    const daemon = new Daemon(
      { databasePath: join(tempDir("conductor-api-noreg-db-"), "state.db"), projects: [project], heartbeatIntervalMs: 60_000 },
      { sessions, logger: { log: () => {} }, scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
    )
    daemonsToStop.push(daemon)
    await daemon.start()
    const api = createApi(
      { bind: { host: "127.0.0.1", port: 0 }, auth: { mode: "none" } },
      { store: daemon.store, engine: daemon.engine, health: () => daemon.health(), resolveWorkflow: daemon.registry.resolver },
    )
    apisToClose.push(api)
    const response = await api.handle(
      new Request("http://conductor.test/v1/projects", {
        method: "POST",
        body: JSON.stringify({ dir: project }),
        headers: { "content-type": "application/json" },
      }),
    )
    expect(response.status).toBe(404)
  })
})
