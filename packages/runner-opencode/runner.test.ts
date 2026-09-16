/**
 * opencode runner adapter — the full daemon↔runner loop with no real
 * network, GitHub or opencode anywhere:
 *
 *   Engine ── SessionClient ──► createRunnerSessionClient (daemon side)
 *      ▲                             │ runner callback protocol
 *      │                             ▼ (hub.handle — socketless)
 *   report over API ◄── tools ── OpencodeRunnerHub ── FakeOpencodeServer
 *
 * A real `Daemon` runs against a temporary SQLite database; the runner
 * hub registers over the API's socketless handler; the daemon's session
 * transport routes back through the hub's socketless handler into a
 * fake opencode server that emulates the SDK session surface (query-
 * routed directories included). Tools drive reports through the typed
 * `ApiClient` over the same handler.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  Daemon,
  RunnerRegistry,
  createApi,
  createRunnerSessionClient,
  type ConductorApi,
  type DaemonLogEntry,
} from "@conductor/server"
import { ApiClient } from "@conductor/cli"
import { resolveRunnerConfig, RunnerConfigError } from "./src/config.ts"
import { createOpencodeSessions, type RawOpencodeSessionApi } from "./src/sessions.ts"
import { OpencodeRunnerHub, type CallbackListener } from "./src/hub.ts"
import { createConductorTools } from "./src/tools.ts"
import { createAgentLogPusher } from "./src/agent-logs.ts"

// ------------------------------------------------------------ fake opencode

interface FakeSession {
  id: string
  title: string
  directory: string
  parentID?: string
  prompts: Array<{ text: string; agent?: string; model?: { providerID: string; modelID: string }; noReply?: boolean }>
}

/**
 * Emulates the opencode server's session surface with the seed's exact
 * routing semantics: `directory` is honoured ONLY from the request
 * QUERY — a directory placed in the body is silently dropped, exactly
 * like the real `/session` endpoint (the production bug the seed fixed).
 */
class FakeOpencodeServer {
  sessions = new Map<string, FakeSession>()
  statuses = new Map<string, "busy" | "idle" | "retry">()
  /** Message timelines per session for the status fallback probe. */
  timelines = new Map<string, Array<{ info?: { role?: string; time?: { completed?: number } } }>>()
  statusEndpointBroken = false
  aborted: string[] = []
  private counter = 0

  constructor(readonly defaultDirectory: string) {}

  api(): RawOpencodeSessionApi {
    return {
      session: {
        create: async input => {
          const bodyDirectory = (input.body as { directory?: string }).directory
          void bodyDirectory // silently dropped — query wins, like the real endpoint
          const id = `ses-${++this.counter}`
          const session: FakeSession = {
            id,
            title: input.body.title ?? "",
            directory: input.query?.directory ?? this.defaultDirectory,
            ...(input.body.parentID !== undefined ? { parentID: input.body.parentID } : {}),
            prompts: [],
          }
          this.sessions.set(id, session)
          return { data: { id } }
        },
        get: async input => {
          const session = this.sessions.get(input.path.id)
          if (!session) throw new Error("not found")
          return { data: { id: session.id } }
        },
        status: async () => {
          if (this.statusEndpointBroken) throw new Error("status endpoint unavailable")
          const data: Record<string, { type: string }> = {}
          for (const [id, type] of this.statuses) data[id] = { type }
          return { data }
        },
        messages: async input => {
          const session = this.sessions.get(input.path.id)
          if (!session) throw new Error("not found")
          return { data: this.timelines.get(input.path.id) ?? [] }
        },
        promptAsync: async input => {
          const session = this.sessions.get(input.path.id)
          if (!session) throw new Error("not found")
          session.prompts.push({
            text: input.body.parts[0]?.text ?? "",
            ...(input.body.agent !== undefined ? { agent: input.body.agent } : {}),
            ...(input.body.model !== undefined ? { model: input.body.model } : {}),
            ...(input.body.noReply !== undefined ? { noReply: input.body.noReply } : {}),
          })
          return {}
        },
        abort: async input => {
          const session = this.sessions.get(input.path.id)
          if (!session) throw new Error("not found")
          this.aborted.push(input.path.id)
          return {}
        },
      },
    }
  }
}

// ----------------------------------------------------------------- harness

const temporaryDirectories: string[] = []
const daemonsToStop: Daemon[] = []
const apisToClose: ConductorApi[] = []
const hubsToStop: OpencodeRunnerHub[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return realpathSync(dir)
}

afterEach(async () => {
  for (const hub of hubsToStop.splice(0)) await hub.stop()
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
  const project = tempDir("conductor-runner-project-")
  writeFileSync(join(project, "conductor.yaml"), source)
  return project
}

class CollectingLogger {
  entries: DaemonLogEntry[] = []
  log(entry: DaemonLogEntry): void {
    this.entries.push(entry)
  }
}

const RUNNER_TOKEN = "runner-callback-secret"
const RUNNER_ENDPOINT_HOST = "runner.test"

interface Harness {
  daemon: Daemon
  api: ConductorApi
  client: ApiClient
  registry: RunnerRegistry
  logger: CollectingLogger
  makeHub: () => OpencodeRunnerHub
}

/**
 * Wires a real daemon whose SessionClient is the runner callback
 * transport, with hub↔daemon traffic flowing through socketless
 * handlers on both sides. `listen` is faked: the hub's handler is
 * routed by endpoint URL, so several hubs can coexist in one test.
 */
async function makeHarness(input?: { projects?: string[] }): Promise<Harness> {
  const registry = new RunnerRegistry()
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  let portCounter = 0

  const runnerFetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const handler = handlers.get(`${url.hostname}:${url.port}`)
    if (!handler) throw new Error(`no runner listening at ${url.hostname}:${url.port}`)
    return handler(request)
  }

  const sessions = createRunnerSessionClient({ runners: registry, fetchImpl: runnerFetch })
  const logger = new CollectingLogger()
  const daemon = new Daemon(
    {
      databasePath: join(tempDir("conductor-runner-db-"), "state.db"),
      projects: input?.projects ?? [],
      heartbeatIntervalMs: 60_000,
      engine: { nudgeIdleCycles: 1, maxNudges: 1 },
    },
    {
      sessions,
      runnerAvailability: () => registry.hasAny(),
      logger,
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
    },
  )
  daemonsToStop.push(daemon)
  await daemon.start()

  const api = createApi(
    { bind: { host: "127.0.0.1", port: 0 }, auth: { mode: "none" } },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      runners: registry,
    },
  )
  apisToClose.push(api)
  const daemonFetch = async (request: Request): Promise<Response> => api.handle(request)
  const client = new ApiClient({ url: "http://daemon.test" }, daemonFetch)

  const makeHub = (): OpencodeRunnerHub => {
    const config = resolveRunnerConfig({
      CONDUCTOR_URL: "http://daemon.test",
      CONDUCTOR_RUNNER_HOST: RUNNER_ENDPOINT_HOST,
      CONDUCTOR_RUNNER_TOKEN: RUNNER_TOKEN,
    })
    const hub = new OpencodeRunnerHub(config, {
      daemonFetch,
      reannounceMs: 0,
      listen: (host, _port, handler): CallbackListener => {
        const port = ++portCounter
        handlers.set(`${host}:${port}`, handler)
        return {
          hostname: host,
          port,
          async stop() {
            handlers.delete(`${host}:${port}`)
          },
        }
      },
    })
    hubsToStop.push(hub)
    return hub
  }

  return { daemon, api, client, registry, logger, makeHub }
}

// ------------------------------------------------------------------- tests

describe("runner configuration is explicit", () => {
  it("requires CONDUCTOR_URL", () => {
    expect(() => resolveRunnerConfig({ CONDUCTOR_RUNNER_HOST: "127.0.0.1", CONDUCTOR_RUNNER_TOKEN: "t" })).toThrow(
      RunnerConfigError,
    )
  })

  it("requires an explicit callback host — even localhost is written down", () => {
    expect(() => resolveRunnerConfig({ CONDUCTOR_URL: "http://127.0.0.1:4400", CONDUCTOR_RUNNER_TOKEN: "t" })).toThrow(
      /CONDUCTOR_RUNNER_HOST/,
    )
  })

  it("requires an explicit auth decision: token or the written-down none", () => {
    expect(() =>
      resolveRunnerConfig({ CONDUCTOR_URL: "http://127.0.0.1:4400", CONDUCTOR_RUNNER_HOST: "127.0.0.1" }),
    ).toThrow(/callback auth/)
    const none = resolveRunnerConfig({
      CONDUCTOR_URL: "http://127.0.0.1:4400",
      CONDUCTOR_RUNNER_HOST: "127.0.0.1",
      CONDUCTOR_RUNNER_AUTH: "none",
    })
    expect(none.callbackAuth).toEqual({ mode: "none" })
  })

  it("rejects a non-http daemon URL and a malformed port", () => {
    expect(() =>
      resolveRunnerConfig({
        CONDUCTOR_URL: "ftp://daemon",
        CONDUCTOR_RUNNER_HOST: "127.0.0.1",
        CONDUCTOR_RUNNER_TOKEN: "t",
      }),
    ).toThrow(/http or https/)
    expect(() =>
      resolveRunnerConfig({
        CONDUCTOR_URL: "http://127.0.0.1:4400",
        CONDUCTOR_RUNNER_HOST: "127.0.0.1",
        CONDUCTOR_RUNNER_PORT: "eighty",
        CONDUCTOR_RUNNER_TOKEN: "t",
      }),
    ).toThrow(/CONDUCTOR_RUNNER_PORT/)
  })

  it("rejects auth=none combined with a token — one explicit decision, not two", () => {
    expect(() =>
      resolveRunnerConfig({
        CONDUCTOR_URL: "http://127.0.0.1:4400",
        CONDUCTOR_RUNNER_HOST: "127.0.0.1",
        CONDUCTOR_RUNNER_AUTH: "none",
        CONDUCTOR_RUNNER_TOKEN: "t",
      }),
    ).toThrow(/mutually exclusive/)
  })
})

describe("session transport preserves the seed's opencode wire shape", () => {
  it("routes the directory as a QUERY parameter on create — never the body", async () => {
    const server = new FakeOpencodeServer("/fallback")
    const sessions = createOpencodeSessions(server.api())
    const created = await sessions.createSession({ title: "t", directory: "/work/project-a" })
    expect(server.sessions.get(created.id)?.directory).toBe("/work/project-a")
  })

  it("splits provider/model and sends noReply notes without inference", async () => {
    const server = new FakeOpencodeServer("/fallback")
    const sessions = createOpencodeSessions(server.api())
    const { id } = await sessions.createSession({ title: "t", directory: "/p" })
    await sessions.prompt({ sessionID: id, text: "go", agent: "build", model: "anthropic/claude-x" })
    await sessions.note({ sessionID: id, text: "fyi" })
    const stored = server.sessions.get(id)!
    expect(stored.prompts[0]).toEqual({ text: "go", agent: "build", model: { providerID: "anthropic", modelID: "claude-x" } })
    expect(stored.prompts[1]).toEqual({ text: "fyi", noReply: true })
  })

  it("maps status: busy/retry/idle from the map, idle for a live unlisted session, missing for a gone one", async () => {
    const server = new FakeOpencodeServer("/fallback")
    const sessions = createOpencodeSessions(server.api())
    const { id } = await sessions.createSession({ title: "t", directory: "/p" })
    server.statuses.set(id, "busy")
    expect(await sessions.status(id)).toBe("busy")
    server.statuses.set(id, "retry")
    expect(await sessions.status(id)).toBe("retry")
    server.statuses.delete(id)
    expect(await sessions.status(id)).toBe("idle")
    server.sessions.delete(id)
    expect(await sessions.status(id)).toBe("missing")
  })

  it("claims busy when the status endpoint is unavailable — the safe direction", async () => {
    const server = new FakeOpencodeServer("/fallback")
    const sessions = createOpencodeSessions(server.api())
    const { id } = await sessions.createSession({ title: "t", directory: "/p" })
    server.statusEndpointBroken = true
    expect(await sessions.status(id)).toBe("busy")
  })

  it("abort stops a live session and is a no-op success for a missing one", async () => {
    const server = new FakeOpencodeServer("/fallback")
    const sessions = createOpencodeSessions(server.api())
    const { id } = await sessions.createSession({ title: "t", directory: "/p" })
    await sessions.abort(id)
    expect(server.aborted).toEqual([id])
    // Missing session: no throw, no abort call against the SDK.
    await sessions.abort("ses-gone")
    expect(server.aborted).toEqual([id])
  })

  it("an unlisted session with an in-flight assistant turn is busy, not idle", async () => {
    // /session/status is scoped to the daemon-owner's directory: a
    // session working in another project is absent from the map even
    // mid-turn. The timeline fallback must catch that.
    const server = new FakeOpencodeServer("/fallback")
    const sessions = createOpencodeSessions(server.api())
    const { id } = await sessions.createSession({ title: "t", directory: "/other-project" })
    server.timelines.set(id, [
      { info: { role: "user", time: {} } },
      { info: { role: "assistant", time: {} } },
    ])
    expect(await sessions.status(id)).toBe("busy")
    server.timelines.set(id, [
      { info: { role: "user", time: {} } },
      { info: { role: "assistant", time: { completed: Date.now() } } },
    ])
    expect(await sessions.status(id)).toBe("idle")
  })
})

describe("runner registration and daemon health", () => {
  it("daemon reports runner unavailable before registration, available after, unavailable after stop", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    expect(h.daemon.health().runner).toBe("unavailable")

    const hub = h.makeHub()
    const opencode = new FakeOpencodeServer(project)
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))
    expect(h.daemon.health().runner).toBe("available")
    expect(h.registry.list()).toHaveLength(1)
    expect(h.registry.list()[0]!.projects).toEqual([project])

    await hub.stop()
    expect(h.daemon.health().runner).toBe("unavailable")
    expect(h.registry.list()).toHaveLength(0)
  })

  it("re-registration from multiple project instances upserts one endpoint and unions projects", async () => {
    const projectA = writeProject()
    const projectB = writeProject()
    const h = await makeHarness({ projects: [projectA, projectB] })

    const hub = h.makeHub()
    const opencode = new FakeOpencodeServer(projectA)
    await hub.registerProject(projectA, createOpencodeSessions(opencode.api()))
    await hub.registerProject(projectB, createOpencodeSessions(opencode.api()))

    const runners = h.registry.list()
    expect(runners).toHaveLength(1)
    expect([...runners[0]!.projects].sort()).toEqual([projectA, projectB].sort())
  })

  it("the runner listing never exposes the callback token", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(new FakeOpencodeServer(project).api()))

    const response = await h.api.handle(new Request("http://daemon.test/v1/runners"))
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain(RUNNER_TOKEN)
  })

  it("a failed listener bind leaves no half-registered project behind", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const config = resolveRunnerConfig({
      CONDUCTOR_URL: "http://daemon.test",
      CONDUCTOR_RUNNER_HOST: RUNNER_ENDPOINT_HOST,
      CONDUCTOR_RUNNER_TOKEN: RUNNER_TOKEN,
    })
    const hub = new OpencodeRunnerHub(config, {
      daemonFetch: async request => h.api.handle(request),
      listen: () => {
        throw new Error("address already in use")
      },
    })
    hubsToStop.push(hub)
    const sessions = createOpencodeSessions(new FakeOpencodeServer(project).api())
    await expect(hub.registerProject(project, sessions)).rejects.toThrow("address already in use")
    expect(hub.registeredProjects).toEqual([])
    expect(h.registry.hasAny()).toBe(false)
  })

  it("callback requests without the bearer token are rejected", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(new FakeOpencodeServer(project).api()))

    const response = await hub.handle(
      new Request(`http://${RUNNER_ENDPOINT_HOST}:1/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t", directory: project }),
      }),
    )
    expect(response.status).toBe(401)
  })

  it("the re-announce loop heals a daemon-restart registry wipe", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    let tick: (() => void) | null = null
    const config = resolveRunnerConfig({
      CONDUCTOR_URL: "http://daemon.test",
      CONDUCTOR_RUNNER_HOST: RUNNER_ENDPOINT_HOST,
      CONDUCTOR_RUNNER_TOKEN: RUNNER_TOKEN,
    })
    const hub = new OpencodeRunnerHub(config, {
      daemonFetch: async request => h.api.handle(request),
      reannounceMs: 1,
      setInterval: ((fn: () => void) => {
        tick = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: (() => {
        tick = null
      }) as typeof clearInterval,
      listen: (host): CallbackListener => ({ hostname: host, port: 1, stop: async () => {} }),
    })
    hubsToStop.push(hub)
    await hub.registerProject(project, createOpencodeSessions(new FakeOpencodeServer(project).api()))
    expect(h.registry.hasAny()).toBe(true)

    // Simulate the daemon restart: its in-memory registry starts empty.
    for (const runner of h.registry.list()) h.registry.deregister(runner.id)
    expect(h.registry.hasAny()).toBe(false)

    tick!()
    await Bun.sleep(0)
    expect(h.registry.hasAny()).toBe(true)
    expect(h.registry.list()[0]!.projects).toEqual([project])

    await hub.stop()
    expect(tick).toBeNull()
  })
})

describe("multi-project directory routing", () => {
  it("sessions land in the correct project regardless of registration order", async () => {
    const projectA = writeProject()
    const projectB = writeProject()
    const h = await makeHarness({ projects: [projectA, projectB] })

    const hub = h.makeHub()
    const opencode = new FakeOpencodeServer(projectA)
    const sessions = createOpencodeSessions(opencode.api())
    // register B FIRST, then A — routing must not care.
    await hub.registerProject(projectB, sessions)
    await hub.registerProject(projectA, sessions)

    const started = await h.client.startFeature({ title: "Feature in A", project: projectA })
    await h.daemon.beat()
    const dirs = [...opencode.sessions.values()].map(s => s.directory)
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) expect(dir).toBe(projectA)

    const startedB = await h.client.startFeature({ title: "Feature in B", project: projectB })
    await h.daemon.beat()
    const bSessions = [...opencode.sessions.values()].filter(s => s.directory === projectB)
    expect(bSessions.length).toBeGreaterThan(0)
    expect(started.feature.projectDir).toBe(projectA)
    expect(startedB.feature.projectDir).toBe(projectB)
  })

  it("a session created inside a feature worktree routes to the owning project's runner", async () => {
    const projectA = writeProject()
    const h = await makeHarness({ projects: [projectA] })
    const hub = h.makeHub()
    const opencode = new FakeOpencodeServer(projectA)
    await hub.registerProject(projectA, createOpencodeSessions(opencode.api()))

    const worktree = join(projectA, ".worktrees", "feature-x")
    const response = await hub.handle(
      new Request(`http://${RUNNER_ENDPOINT_HOST}:1/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${RUNNER_TOKEN}` },
        body: JSON.stringify({ title: "step", directory: worktree }),
      }),
    )
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    expect(opencode.sessions.get(id)?.directory).toBe(worktree)
  })

  it("a worktree OUTSIDE every project (worktreeDir '..') still routes deterministically", async () => {
    const projectA = writeProject()
    const projectB = writeProject()
    const h = await makeHarness({ projects: [projectA, projectB] })
    const hub = h.makeHub()
    const opencode = new FakeOpencodeServer(projectA)
    const sessions = createOpencodeSessions(opencode.api())
    await hub.registerProject(projectB, sessions)
    await hub.registerProject(projectA, sessions)

    const outside = join(tempDir("conductor-runner-outside-"), "some-feature")
    const response = await hub.handle(
      new Request(`http://${RUNNER_ENDPOINT_HOST}:1/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${RUNNER_TOKEN}` },
        body: JSON.stringify({ title: "step", directory: outside }),
      }),
    )
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    // Query-routed directory reaches opencode verbatim: the worktree is
    // the session's working directory even when no project path-prefixes it.
    expect(opencode.sessions.get(id)?.directory).toBe(outside)
  })
})

describe("session states drive the engine's idle/retry/missing policy", () => {
  async function startedRun(h: Harness, project: string, opencode: FakeOpencodeServer) {
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))
    const payload = await h.client.startFeature({ title: "Run states", project })
    expect(payload.activeRun).not.toBeNull()
    return { hub, featureId: payload.feature.id, runId: payload.activeRun!.id, sessionId: payload.activeRun!.sessionId! }
  }

  it("missing session is reaped immediately and the step retried", async () => {
    const retryWorkflow = `
name: retryable
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
        retry:
          maxAttempts: 2
          backoff: { strategy: constant, delay: 10 }
`
    const project = writeProject(retryWorkflow)
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const { featureId, runId, sessionId } = await startedRun(h, project, opencode)

    opencode.sessions.delete(sessionId)
    // also delete the parent so the retry creates a fresh chain
    opencode.sessions.clear()
    await h.daemon.beat()

    const run = await h.client.getRun(runId)
    expect(run.run.status).toBe("reaped")
    const feature = await h.client.getFeature(featureId)
    expect(feature.feature.status).toBe("running")
    // The retry is durable now: a 10ms backoff schedules an episode
    // instead of instantly re-arming; the next due pass dispatches it.
    await Bun.sleep(15)
    await h.daemon.beat()
    const after = await h.client.getFeature(featureId)
    expect(after.activeRun).not.toBeNull()
    expect(after.activeRun!.id).not.toBe(runId)
  })

  it("busy and retry sessions are never nudged", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const { runId, sessionId } = await startedRun(h, project, opencode)
    const promptsBefore = opencode.sessions.get(sessionId)!.prompts.length

    opencode.statuses.set(sessionId, "busy")
    await h.daemon.beat()
    await h.daemon.beat()
    opencode.statuses.set(sessionId, "retry")
    await h.daemon.beat()
    await h.daemon.beat()

    expect(opencode.sessions.get(sessionId)!.prompts.length).toBe(promptsBefore)
    expect((await h.client.getRun(runId)).run.status).toBe("running")
  })

  it("idle session is debounced, nudged, then reaped — idle NEVER concludes the step", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const { featureId, runId, sessionId } = await startedRun(h, project, opencode)
    const initialPrompts = opencode.sessions.get(sessionId)!.prompts.length

    // no status entry → idle. nudgeIdleCycles=1: first beat nudges.
    await h.daemon.beat()
    const afterNudge = opencode.sessions.get(sessionId)!.prompts
    expect(afterNudge.length).toBe(initialPrompts + 1)
    expect(afterNudge[afterNudge.length - 1]!.text).toContain("report")
    expect((await h.client.getRun(runId)).run.status).toBe("running")

    // maxNudges=1 exhausted → next idle cycle reaps; the step FAILS, it
    // never silently succeeds off an idle session.
    await h.daemon.beat()
    expect((await h.client.getRun(runId)).run.status).toBe("reaped")
    const feature = await h.client.getFeature(featureId)
    expect(feature.feature.status).not.toBe("done")
  })

  it("an explicit report between idle cycles wins — the run concludes reported, not reaped", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const { featureId, runId } = await startedRun(h, project, opencode)

    await h.daemon.beat() // idle → nudge
    const report = await h.client.report(runId, { outcome: "succeeded", notes: "done" })
    expect(report.result).toContain("succeeded")
    await h.daemon.beat()
    expect((await h.client.getRun(runId)).run.status).toBe("succeeded")
    expect((await h.client.getFeature(featureId)).feature.status).toBe("done")
  })

  it("a reap aborts the opencode session end to end — daemon transport → runner hub → opencode", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const { runId, sessionId } = await startedRun(h, project, opencode)

    // Idle through the nudge budget (nudgeIdleCycles=1, maxNudges=1):
    // the second beat reaps — and the reap must reach opencode's abort.
    await h.daemon.beat() // nudge
    await h.daemon.beat() // reap + abort
    expect((await h.client.getRun(runId)).run.status).toBe("reaped")
    expect(opencode.aborted).toContain(sessionId)
  })
})

describe("agent log capture via runner push", () => {
  function partEvent(sessionID: string, part: { id: string; text: string }): unknown {
    return { type: "message.part.updated", properties: { sessionID, part: { id: part.id, type: "text", text: part.text } } }
  }

  class FakeLogClient {
    pushes: Array<{ runId: string; lines: Array<{ text: string; source?: string }> }> = []
    failNext = 0
    rejectWith: number | null = null
    async appendRunLogs(runId: string, lines: Array<{ text: string; source?: string }>): Promise<{ appended: number }> {
      if (this.rejectWith !== null) {
        const status = this.rejectWith
        this.rejectWith = null
        throw Object.assign(new Error(`rejected ${status}`), { status })
      }
      if (this.failNext > 0) {
        this.failNext -= 1
        throw new Error("daemon unreachable")
      }
      this.pushes.push({ runId, lines })
      return { appended: lines.length }
    }
  }

  function pusher(overrides: { client: FakeLogClient; log?: (m: string) => void }) {
    return createAgentLogPusher({
      client: overrides.client as unknown as ApiClient,
      runIdForSession: sessionID => (sessionID === "ses-mapped" ? "run-1" : undefined),
      sleep: async () => {},
      log: overrides.log ?? (() => {}),
    })
  }

  it("accumulates text parts per run, dedupes snapshots and flushes batched agent lines", async () => {
    const client = new FakeLogClient()
    const logs = pusher({ client })
    logs.push(partEvent("ses-mapped", { id: "p1", text: "hello " }))
    logs.push(partEvent("ses-mapped", { id: "p1", text: "hello world" }))
    logs.push(partEvent("ses-mapped", { id: "p1", text: "hello world" })) // re-sent snapshot: deduped
    logs.push(partEvent("ses-mapped", { id: "p2", text: " second" }))
    await logs.flush()

    expect(client.pushes).toEqual([{ runId: "run-1", lines: [{ text: "hello world second", source: "agent" }] }])
  })

  it("pushes nothing for unmapped sessions", async () => {
    const client = new FakeLogClient()
    const logs = pusher({ client })
    logs.push(partEvent("ses-foreign", { id: "p1", text: "x" }))
    await logs.flush()
    expect(client.pushes).toEqual([])
  })

  it("ignores non-part events and tool parts without input", async () => {
    const client = new FakeLogClient()
    const logs = pusher({ client })
    logs.push({ type: "session.idle", properties: {} })
    // A tool part with no input yet (pending, input unknown) is not a line.
    logs.push({ type: "message.part.updated", properties: { sessionID: "ses-mapped", part: { id: "p1", type: "tool", tool: "bash" } } })
    await logs.flush()
    expect(client.pushes).toEqual([])
  })

  it("emits one compact tool line per invocation, deduped across state re-sends", async () => {
    const client = new FakeLogClient()
    const logs = pusher({ client })
    const tool = (id: string, status: string) => ({
      type: "message.part.updated",
      properties: {
        sessionID: "ses-mapped",
        part: { id, type: "tool", tool: "bash", state: { status, input: { command: "git  diff   main...HEAD" } } },
      },
    })
    logs.push(tool("t1", "running"))
    logs.push(tool("t1", "completed")) // re-sent on state transition: deduped
    logs.push({
      type: "message.part.updated",
      properties: {
        sessionID: "ses-mapped",
        part: { id: "t2", type: "tool", tool: "grep", state: { status: "running", input: { pattern: "findBundle" } } },
      },
    })
    await logs.flush()
    expect(client.pushes).toEqual([
      {
        runId: "run-1",
        lines: [
          { text: "running command", source: "tool" },
          { text: "searching content", source: "tool" },
        ],
      },
    ])
  })

  it("preserves narrative/tool ordering without exposing tool input", async () => {
    const client = new FakeLogClient()
    const logs = pusher({ client })
    logs.push(partEvent("ses-mapped", { id: "p1", text: "Reviewing the aggregate. " }))
    logs.push({
      type: "message.part.updated",
      properties: {
        sessionID: "ses-mapped",
        part: { id: "t1", type: "tool", tool: "read", state: { status: "running", input: { filePath: `/x/${"a".repeat(300)}.kt` } } },
      },
    })
    logs.push(partEvent("ses-mapped", { id: "p1", text: "Reviewing the aggregate. Looks sound." }))
    await logs.flush()
    const lines = client.pushes[0]!.lines
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({ text: "Reviewing the aggregate. ", source: "agent" })
    expect(lines[1]).toEqual({ text: "reading file", source: "tool" })
    expect(lines[2]).toEqual({ text: "Looks sound.", source: "agent" })
  })

  it("omits credential-bearing arguments and unrecognized tool names from log payloads", async () => {
    const client = new FakeLogClient()
    const logs = pusher({ client })
    const inputs = [
      { command: 'curl -H "Authorization: Bearer synthetic-token" https://example.test' },
      { command: "curl -H 'Authorization: Basic synthetic-base64' https://example.test" },
      { command: 'export SOME_API_KEY="synthetic secret"\nexport PASSWORD=\'another secret\'' },
      { command: 'API_TOKEN="first\nsecond" command', env: { AWS_SECRET_ACCESS_KEY: "synthetic-key" } },
      { url: "https://user:synthetic-password@example.test/repo?token=synthetic-query" },
      { filePath: "/private/synthetic-secret/file", path: "/private/synthetic-secret" },
      { pattern: "synthetic-secret", description: "synthetic-secret", name: "synthetic-secret" },
      { input: { headers: { Authorization: "synthetic-secret" } }, content: "synthetic-secret" },
    ]
    const tools = ["bash", "read", "webfetch", "custom_synthetic-secret", "Bearer synthetic-secret", "constructor", "__proto__", ""]
    for (const [index, input] of inputs.entries()) {
      for (const tool of tools) {
        logs.push({
          type: "message.part.updated",
          properties: {
            sessionID: "ses-mapped",
            part: { id: `${index}-${tool}`, type: "tool", tool, state: { status: "running", input } },
          },
        })
      }
    }
    await logs.flush()
    expect(client.pushes).toEqual([{
      runId: "run-1",
      lines: inputs.flatMap(() => tools.map(tool => ({
        source: "tool",
        text: tool === "bash" ? "running command" : tool === "read" ? "reading file" : tool === "webfetch" ? "fetching URL" : "using tool",
      }))),
    }])
  })

  it("is best-effort: a failed push is logged and the buffer dropped, the run stays tracked", async () => {
    const client = new FakeLogClient()
    const logMessages: string[] = []
    const logs = pusher({ client, log: m => logMessages.push(m) })
    client.failNext = 1
    logs.push(partEvent("ses-mapped", { id: "p1", text: "line one" }))
    await logs.flush()
    expect(logMessages.some(m => m.includes("failed"))).toBe(true)
    expect(client.pushes).toEqual([])

    // Next flush succeeds and starts clean.
    logs.push(partEvent("ses-mapped", { id: "p2", text: "line two" }))
    await logs.flush()
    expect(client.pushes).toEqual([{ runId: "run-1", lines: [{ text: "line two", source: "agent" }] }])
  })

  it("drops the run entirely on a 409 — a late flush after conclusion is never retried", async () => {
    const client = new FakeLogClient()
    const logs = pusher({ client })
    client.rejectWith = 409
    logs.push(partEvent("ses-mapped", { id: "p1", text: "late" }))
    await logs.flush()
    expect(client.pushes).toEqual([])
    // The run is no longer tracked: further flushes attempt nothing.
    await logs.flush()
    expect(client.pushes).toEqual([])
  })

  it("the session→run map is bounded: oldest attributions are evicted beyond the cap", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))

    const create = (runId: string) =>
      hub.handle(
        new Request(`http://${RUNNER_ENDPOINT_HOST}:1/v1/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${RUNNER_TOKEN}` },
          body: JSON.stringify({ title: "step", directory: project, runId }),
        }),
      )

    const first = (await (await create("run-first")).json()) as { id: string }
    for (let i = 0; i < 1024; i += 1) await create(`run-${i}`)
    expect(hub.runIdForSession(first.id)).toBeUndefined()

    const last = (await (await create("run-last")).json()) as { id: string }
    expect(hub.runIdForSession(last.id)).toBe("run-last")
  })

  it("records the run attribution on session create and streams part events into the daemon route", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))

    const payload = await h.client.startFeature({ title: "Agent log flow", project })
    const runId = payload.activeRun!.id
    const sessionID = payload.activeRun!.sessionId!
    expect(sessionID).toBeTruthy()
    expect(hub.runIdForSession(sessionID)).toBe(runId)

    const logs = createAgentLogPusher({
      client: h.client,
      runIdForSession: id => hub.runIdForSession(id),
      sleep: async () => {},
    })
    logs.push(partEvent(sessionID, { id: "p1", text: "thinking… " }))
    logs.push(partEvent(sessionID, { id: "p1", text: "thinking… done" }))
    await logs.flush()

    const page = await h.client.getRunLogs(runId)
    expect(page.lines.map(line => ({ source: line.source, text: line.text }))).toEqual([
      { source: "agent", text: "thinking… done" },
    ])
  })
})

describe("daemon-backed tools inside sessions", () => {
  it("conductor_start adopts the calling session as the feature's parent and hands work to the daemon", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))

    const callerSession = await createOpencodeSessions(opencode.api()).createSession({ title: "user chat", directory: project })
    const tools = createConductorTools(h.client, project)
    const text = await tools.start({ title: "Tool started feature" }, { sessionID: callerSession.id })
    expect(text).toContain("started")
    expect(text).toContain("do NOT monitor")

    const { features } = await h.client.listFeatures({ project })
    expect(features).toHaveLength(1)
    expect(features[0]!.sessionId).toBe(callerSession.id)

    // The dispatched step session is a CHILD of the calling session.
    const payload = await h.client.getFeature(features[0]!.id)
    const stepSession = opencode.sessions.get(payload.activeRun!.sessionId!)
    expect(stepSession?.parentID).toBe(callerSession.id)
  })

  it("tools are available to child sessions inside worktrees: a report from the worktree concludes the run", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))

    const payload = await h.client.startFeature({ title: "Worktree tools", project })
    const runId = payload.activeRun!.id

    // The child session runs in the worktree directory; its plugin
    // instance builds the SAME daemon-backed tools from the shared
    // environment — no project-scoped state is needed to report.
    const worktree = join(project, ".worktrees", "worktree-tools")
    const worktreeTools = createConductorTools(h.client, worktree)
    const text = await worktreeTools.report({ run_id: runId, outcome: "succeeded", notes: "from the worktree" })
    expect(text).toBe('Step "implement" marked succeeded.')
    expect((await h.client.getRun(runId)).run.status).toBe("succeeded")
  })

  it("a duplicate report through the tool is rejected idempotently with the already-concluded text", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))

    const payload = await h.client.startFeature({ title: "Duplicate report", project })
    const runId = payload.activeRun!.id
    const tools = createConductorTools(h.client, project)

    expect(await tools.report({ run_id: runId, outcome: "succeeded" })).toBe('Step "implement" marked succeeded.')
    const duplicate = await tools.report({ run_id: runId, outcome: "failed", notes: "retry after timeout" })
    expect(duplicate).toContain(`run ${runId} already concluded`)
    expect((await h.client.getRun(runId)).run.status).toBe("succeeded")

    const unknown = await tools.report({ run_id: "nope", outcome: "succeeded" })
    expect(unknown).toBe('Unknown run_id "nope".')
  })

  it("status and gates stay scoped to their project directory", async () => {
    const projectA = writeProject(gatedWorkflow)
    const projectB = writeProject()
    const h = await makeHarness({ projects: [projectA, projectB] })
    const opencode = new FakeOpencodeServer(projectA)
    const hub = h.makeHub()
    const sessions = createOpencodeSessions(opencode.api())
    await hub.registerProject(projectA, sessions)
    await hub.registerProject(projectB, sessions)

    const payload = await h.client.startFeature({ title: "Gated in A", project: projectA })
    const featureId = payload.feature.id
    await h.client.report(payload.activeRun!.id, { outcome: "succeeded" })

    const toolsB = createConductorTools(h.client, projectB)
    expect(await toolsB.status()).toBe("No active conductor features.")
    const denied = await toolsB.approve({ feature_id: featureId })
    expect(denied).toContain(`belongs to ${projectA}`)
    expect((await h.client.getFeature(featureId)).feature.status).toBe("waiting_human")

    const toolsA = createConductorTools(h.client, projectA)
    expect(await toolsA.status()).toContain("Gated in A")
    const approved = await toolsA.approve({ feature_id: featureId, notes: "ship it" })
    expect(approved).toContain("Approved")
    // merge_gate is the workflow's last step: approving finishes the job.
    expect((await h.client.getFeature(featureId)).feature.status).toBe("done")
  })

  it("request-changes routes the feature back and hands notes to the fixer", async () => {
    const project = writeProject(gatedWorkflow)
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))

    const payload = await h.client.startFeature({ title: "Reject me", project })
    await h.client.report(payload.activeRun!.id, { outcome: "succeeded" })

    const tools = createConductorTools(h.client, project)
    const rejected = await tools.requestChanges({ feature_id: payload.feature.id, notes: "tighten the tests" })
    expect(rejected).toContain("Changes requested")
    const feature = await h.client.getFeature(payload.feature.id)
    expect(feature.feature.status).toBe("running")
    expect(feature.feature.currentStep).toBe("implement")
  })

  it("gate tools surface the daemon's conflict text instead of throwing", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))
    const payload = await h.client.startFeature({ title: "Not waiting", project })

    const tools = createConductorTools(h.client, project)
    const conflicted = await tools.approve({ feature_id: payload.feature.id })
    expect(conflicted).toContain("not waiting for approval")
  })
})

describe("runner disappearance is survivable", () => {
  it("with the runner deregistered mid-run the daemon claims busy and never reaps; a late report still lands", async () => {
    const project = writeProject()
    const h = await makeHarness({ projects: [project] })
    const opencode = new FakeOpencodeServer(project)
    const hub = h.makeHub()
    await hub.registerProject(project, createOpencodeSessions(opencode.api()))

    const payload = await h.client.startFeature({ title: "Runner restart", project })
    const runId = payload.activeRun!.id

    await hub.stop()
    expect(h.daemon.health().runner).toBe("unavailable")
    await h.daemon.beat()
    await h.daemon.beat()
    expect((await h.client.getRun(runId)).run.status).toBe("running")

    const report = await h.client.report(runId, { outcome: "succeeded" })
    expect(report.result).toContain("succeeded")
  })
})
