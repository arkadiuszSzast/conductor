/**
 * `conductor` CLI — argument parsing, connection configuration,
 * command→endpoint mapping, exit codes and output.
 *
 * The CLI is exercised end to end against a REAL daemon through the
 * API's socketless handler (`createApi().handle` wired in as the
 * client's transport) — the same pattern `api.test.ts` uses — so every
 * command is proven to hit the same engine methods as any other API
 * client, with no network, no GitHub and no opencode anywhere. `init`
 * runs against an in-memory filesystem boundary.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon, createApi, type ConductorApi, type ApiConfig } from "@conductor/server"
import type { SessionClient } from "@conductor/server"
import { validateWorkflow, parseWorkflow } from "@conductor/core"
import { runCli, EXIT, type CliDeps, type DaemonStartInput } from "./src/cli.ts"
import { ApiClient, ApiError } from "./src/client.ts"
import { resolveConnection, UsageError } from "./src/config.ts"
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  addProjectToConfig,
  assembleDaemonConfig,
  defaultDaemonConfig,
  loadDaemonConfig,
  platformPaths,
} from "./src/daemon-config.ts"

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
  const project = tempDir("conductor-cli-project-")
  writeFileSync(join(project, "conductor.yaml"), source)
  return project
}

interface Harness {
  daemon: Daemon
  project: string
  sessions: FakeSessions
  files: Map<string, string>
  dirs: Set<string>
  out: string[]
  err: string[]
  run: (...argv: string[]) => Promise<number>
  deps: CliDeps
}

const CLI_URL = "http://conductor.test"

async function makeHarness(input?: { workflow?: string; auth?: ApiConfig["auth"]; env?: Record<string, string> }): Promise<Harness> {
  const project = writeProject(input?.workflow ?? gatedWorkflow)
  const sessions = new FakeSessions()
  const daemon = new Daemon(
    {
      databasePath: join(tempDir("conductor-cli-db-"), "state.db"),
      projects: [project],
      heartbeatIntervalMs: 60_000,
    },
    { sessions, logger: { log: () => {} }, scheduler: { setInterval: () => ({}), clearInterval: () => {} } },
  )
  daemonsToStop.push(daemon)
  await daemon.start()
  const api = createApi(
    { bind: { host: "127.0.0.1", port: 0 }, auth: input?.auth ?? { mode: "none" } },
    {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      registerProject: dir => daemon.registry.register(dir),
    },
  )
  apisToClose.push(api)
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    env: { CONDUCTOR_URL: CLI_URL, ...(input?.env ?? {}) },
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    readFile: path => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    writeFile: (path, content) => {
      files.set(path, content)
    },
    exists: path => files.has(path),
    mkdir: path => {
      dirs.add(path)
    },
    cwd: () => "/work/project",
    fetchImpl: api.handle,
  }
  return {
    daemon,
    project,
    sessions,
    files,
    dirs,
    out,
    err,
    deps,
    run: (...argv) => runCli(argv, deps),
  }
}

async function startFeature(h: Harness): Promise<{ featureId: string; runId: string }> {
  const code = await h.run("start", "Ship the thing", "--project", h.project, "--json")
  expect(code).toBe(EXIT.ok)
  const payload = JSON.parse(h.out.pop()!) as { feature: { id: string }; activeRun: { id: string } }
  return { featureId: payload.feature.id, runId: payload.activeRun.id }
}

describe("CLI: connection configuration", () => {
  it("requires an explicit daemon address — no default port is guessed", async () => {
    const h = await makeHarness()
    const code = await runCli(["status"], { ...h.deps, env: {} })
    expect(code).toBe(EXIT.usage)
    expect(h.err.join("\n")).toContain("--url")
    expect(h.err.join("\n")).toContain("CONDUCTOR_URL")
  })

  it("resolves url/token with flag over env over config file", () => {
    const readFile = (path: string) => {
      expect(path).toBe("/etc/conductor.json")
      return JSON.stringify({ url: "http://file:1", token: "file-token" })
    }
    const fromFile = resolveConnection({ flags: { config: "/etc/conductor.json" }, env: {}, readFile })
    expect(fromFile).toEqual({ url: "http://file:1", token: "file-token" })

    const fromEnv = resolveConnection({
      flags: { config: "/etc/conductor.json" },
      env: { CONDUCTOR_URL: "http://env:2", CONDUCTOR_TOKEN: "env-token" },
      readFile,
    })
    expect(fromEnv).toEqual({ url: "http://env:2", token: "env-token" })

    const fromFlags = resolveConnection({
      flags: { url: "http://flag:3", token: "flag-token", config: "/etc/conductor.json" },
      env: { CONDUCTOR_URL: "http://env:2" },
      readFile,
    })
    expect(fromFlags).toEqual({ url: "http://flag:3", token: "flag-token" })
  })

  it("reads the config file path from CONDUCTOR_CONFIG", () => {
    const connection = resolveConnection({
      flags: {},
      env: { CONDUCTOR_CONFIG: "/tmp/c.json" },
      readFile: () => JSON.stringify({ url: "http://cfg:4" }),
    })
    expect(connection).toEqual({ url: "http://cfg:4" })
  })

  it("rejects a malformed daemon address as a usage error, not a generic failure", async () => {
    const h = await makeHarness()
    expect(await runCli(["status", "--url", "not a url"], h.deps)).toBe(EXIT.usage)
    expect(h.err.join("\n")).toContain("not a valid URL")

    h.err.length = 0
    expect(await runCli(["status", "--url", "ftp://daemon:1"], h.deps)).toBe(EXIT.usage)
    expect(h.err.join("\n")).toContain("must use http or https")
  })

  it("rejects malformed config files with a usage error", () => {
    expect(() => resolveConnection({ flags: { config: "/tmp/c.json" }, env: {}, readFile: () => "not json" })).toThrow(UsageError)
    expect(() =>
      resolveConnection({ flags: { config: "/tmp/c.json" }, env: {}, readFile: () => JSON.stringify({ url: 42 }) }),
    ).toThrow(UsageError)
    expect(() =>
      resolveConnection({
        flags: { config: "/tmp/missing.json" },
        env: {},
        readFile: () => {
          throw new Error("ENOENT")
        },
      }),
    ).toThrow(UsageError)
  })

  it("sends the bearer token from configuration", async () => {
    const h = await makeHarness({ auth: { mode: "bearer", token: "secret-token" }, env: { CONDUCTOR_TOKEN: "secret-token" } })
    const code = await h.run("status")
    expect(code).toBe(EXIT.ok)
  })

  it("maps a missing/wrong token to the unauthorized exit code", async () => {
    const h = await makeHarness({ auth: { mode: "bearer", token: "secret-token" } })
    expect(await h.run("status")).toBe(EXIT.unauthorized)
    expect(h.err.join("\n")).toContain("unauthorized")

    h.err.length = 0
    expect(await h.run("status", "--token", "wrong")).toBe(EXIT.unauthorized)
  })
})

describe("CLI: usage and argument parsing", () => {
  it("prints usage and exits non-zero when no command is given", async () => {
    const h = await makeHarness()
    expect(await h.run()).toBe(EXIT.usage)
    expect(h.out.join("\n")).toContain("usage: conductor")
  })

  it("prints usage with exit 0 for --help", async () => {
    const h = await makeHarness()
    expect(await h.run("--help")).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain("usage: conductor")
  })

  it("rejects unknown commands and unknown flags", async () => {
    const h = await makeHarness()
    expect(await h.run("frobnicate")).toBe(EXIT.usage)
    expect(await h.run("status", "--bogus", "x")).toBe(EXIT.usage)
    expect(await h.run("logs", "--project", "x")).toBe(EXIT.usage)
  })

  it("rejects missing required arguments per command", async () => {
    const h = await makeHarness()
    expect(await h.run("start", "--project", h.project)).toBe(EXIT.usage)
    expect(await h.run("approve")).toBe(EXIT.usage)
    expect(await h.run("report", "some-run")).toBe(EXIT.usage)
    expect(await h.run("report", "some-run", "--outcome", "maybe")).toBe(EXIT.usage)
    expect(await h.run("report", "some-run", "--outcome", "succeeded", "--verdict", "approved")).toBe(EXIT.usage)
    expect(await h.run("request-changes", "some-feature")).toBe(EXIT.usage)
    expect(await h.run("start", "Title", "--project", h.project, "--pr", "zero")).toBe(EXIT.usage)
  })
})

describe("CLI: start / status", () => {
  it("start creates the feature and begins the pipeline through the same engine", async () => {
    const h = await makeHarness()
    const code = await h.run("start", "Ship the thing", "--project", h.project, "--description", "End to end")
    expect(code).toBe(EXIT.ok)
    expect(h.sessions.prompts.length).toBe(1)
    const text = h.out.join("\n")
    expect(text).toContain("Started feature")
    expect(text).toContain("status   running")
    expect(text).toContain("step     implement")
    const features = h.daemon.store.listFeatures()
    expect(features.length).toBe(1)
    expect(features[0]!.title).toBe("Ship the thing")
    expect(features[0]!.description).toBe("End to end")
  })

  it("start --json emits the API payload verbatim", async () => {
    const h = await makeHarness()
    const code = await h.run("start", "Ship it", "--project", h.project, "--json")
    expect(code).toBe(EXIT.ok)
    const payload = JSON.parse(h.out.at(-1)!) as { feature: { status: string; currentStep: string }; activeRun: { stepId: string } }
    expect(payload.feature.status).toBe("running")
    expect(payload.feature.currentStep).toBe("implement")
    expect(payload.activeRun.stepId).toBe("implement")
  })

  it("start maps an unregistered project to a non-zero exit", async () => {
    const h = await makeHarness()
    const code = await h.run("start", "Nope", "--project", "/not/registered")
    expect(code).toBe(EXIT.failure)
    expect(h.err.join("\n")).toContain("project_not_configured")
  })

  it("status <id> shows one feature; status lists features", async () => {
    const h = await makeHarness()
    const { featureId } = await startFeature(h)

    h.out.length = 0
    expect(await h.run("status", featureId)).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain(`feature  ${featureId}`)
    expect(h.out.join("\n")).toContain("status   running")

    h.out.length = 0
    expect(await h.run("status", "--project", h.project, "--active")).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain(featureId)

    h.out.length = 0
    expect(await h.run("status", "--json")).toBe(EXIT.ok)
    const listed = JSON.parse(h.out.at(-1)!) as { features: Array<{ id: string }> }
    expect(listed.features.map(f => f.id)).toEqual([featureId])
  })

  it("status maps an unknown feature to the not-found exit code", async () => {
    const h = await makeHarness()
    expect(await h.run("status", "nope")).toBe(EXIT.notFound)
    expect(h.err.join("\n")).toContain("not_found")
  })
})

describe("CLI: report", () => {
  it("report --outcome succeeded advances the pipeline to the gate", async () => {
    const h = await makeHarness()
    const { featureId, runId } = await startFeature(h)

    h.out.length = 0
    expect(await h.run("report", runId, "--outcome", "succeeded", "--notes", "implemented")).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain('Step "implement" marked succeeded')
    expect(h.daemon.store.getFeature(featureId)!.status).toBe("waiting_human")
  })

  it("report --verdict records a verdict", async () => {
    const h = await makeHarness({
      workflow: `
name: verdict-only
on: [manual]
roles:
  reviewer: { agent: review }
jobs:
  main:
    steps:
      - id: review
        agent:
          role: reviewer
          prompt: "review"
        outcomes:
          approved: next
`,
    })
    const { runId } = await startFeature(h)
    h.out.length = 0
    expect(await h.run("report", runId, "--verdict", "approved", "--json")).toBe(EXIT.ok)
    const payload = JSON.parse(h.out.at(-1)!) as { result: string; run: { status: string } }
    expect(payload.result).toContain('Verdict "approved"')
    expect(payload.run.status).toBe("succeeded")
  })

  it("report reads notes from a file with --notes @file", async () => {
    const h = await makeHarness()
    const { runId } = await startFeature(h)
    h.files.set("/tmp/notes.md", "notes from a file")
    expect(await h.run("report", runId, "--outcome", "succeeded", "--notes", "@/tmp/notes.md")).toBe(EXIT.ok)
    const run = h.daemon.store.getRunById(runId)!
    expect(run.outputs["report"]).toBe("notes from a file")
  })

  it("maps a duplicate report to the dedicated duplicate exit code", async () => {
    const h = await makeHarness()
    const { runId } = await startFeature(h)
    expect(await h.run("report", runId, "--outcome", "succeeded")).toBe(EXIT.ok)
    expect(await h.run("report", runId, "--outcome", "succeeded")).toBe(EXIT.duplicateReport)
    expect(h.err.join("\n")).toContain("run_already_concluded")
  })

  it("maps an unknown run to the not-found exit code", async () => {
    const h = await makeHarness()
    expect(await h.run("report", "missing-run", "--outcome", "succeeded")).toBe(EXIT.notFound)
  })
})

describe("CLI: approve / request-changes", () => {
  async function driveToGate(h: Harness): Promise<{ featureId: string }> {
    const { featureId, runId } = await startFeature(h)
    expect(await h.run("report", runId, "--outcome", "succeeded")).toBe(EXIT.ok)
    expect(h.daemon.store.getFeature(featureId)!.status).toBe("waiting_human")
    h.out.length = 0
    return { featureId }
  }

  it("approve releases the gate and records the transition once", async () => {
    const h = await makeHarness()
    const { featureId } = await driveToGate(h)
    expect(await h.run("approve", featureId, "--notes", "ship it")).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain("Approved")
    const feature = h.daemon.store.getFeature(featureId)!
    expect(feature.status).toBe("done")
  })

  it("request-changes reruns the gated step with notes", async () => {
    const h = await makeHarness()
    const { featureId } = await driveToGate(h)
    expect(await h.run("request-changes", featureId, "--notes", "needs work")).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain("Changes requested")
    const feature = h.daemon.store.getFeature(featureId)!
    expect(feature.status).toBe("running")
    expect(feature.jobs["main"]?.currentStep).toBe("implement")
  })

  it("maps a gate command on a non-waiting feature to the conflict exit code", async () => {
    const h = await makeHarness()
    const { featureId } = await startFeature(h)
    expect(await h.run("approve", featureId)).toBe(EXIT.conflict)
    expect(h.err.join("\n")).toContain("conflict")
  })
})

describe("CLI: pause / resume / abandon / logs", () => {
  it("pause, resume and abandon map to their endpoints", async () => {
    const h = await makeHarness()
    const { featureId } = await startFeature(h)

    h.out.length = 0
    expect(await h.run("pause", featureId)).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain("paused")
    expect(h.daemon.store.getFeature(featureId)!.status).toBe("paused")

    h.out.length = 0
    expect(await h.run("resume", featureId)).toBe(EXIT.ok)
    expect(h.daemon.store.getFeature(featureId)!.status).toBe("running")

    h.out.length = 0
    expect(await h.run("abandon", featureId, "--json")).toBe(EXIT.ok)
    const payload = JSON.parse(h.out.at(-1)!) as { feature: { status: string } }
    expect(payload.feature.status).toBe("abandoned")
  })

  it("pause on a terminal feature maps to the conflict exit code", async () => {
    const h = await makeHarness()
    const { featureId } = await startFeature(h)
    expect(await h.run("abandon", featureId)).toBe(EXIT.ok)
    expect(await h.run("pause", featureId)).toBe(EXIT.conflict)
  })

  it("logs prints the transition timeline chronologically", async () => {
    const h = await makeHarness()
    const { featureId, runId } = await startFeature(h)
    expect(await h.run("report", runId, "--outcome", "succeeded")).toBe(EXIT.ok)

    h.out.length = 0
    expect(await h.run("logs", featureId)).toBe(EXIT.ok)
    expect(h.out.length).toBeGreaterThanOrEqual(2)
    expect(h.out[0]).toContain("feature.start")
    expect(h.out[0]).not.toContain('{"kind"')
    expect(h.out.at(-1)!).toContain("step.completed")

    h.out.length = 0
    expect(await h.run("logs", featureId, "--json")).toBe(EXIT.ok)
    const payload = JSON.parse(h.out.at(-1)!) as { timeline: Array<{ event: { kind: string } }> }
    expect(payload.timeline.some(t => t.event.kind === "feature.start")).toBe(true)
  })
})

describe("CLI: init", () => {
  it("scaffolds conductor.yaml in the target directory", async () => {
    const h = await makeHarness()
    expect(await h.run("init", "--dir", "/work/other")).toBe(EXIT.ok)
    expect(h.dirs.has("/work/other")).toBe(true)
    const written = h.files.get("/work/other/conductor.yaml")!
    const parsed = parseWorkflow(written)
    expect(parsed.ok).toBe(true)
  })

  it("the scaffolded workflow passes core validateWorkflow", async () => {
    const h = await makeHarness()
    expect(await h.run("init", "--dir", "/work/valid")).toBe(EXIT.ok)
    const written = h.files.get("/work/valid/conductor.yaml")!
    const parsed = parseWorkflow(written)
    if (!parsed.ok) throw new Error(parsed.errors.map(e => e.message).join("\n"))
    const result = validateWorkflow(parsed.workflow)
    expect(result.errors).toEqual([])
  })

  it("defaults to the working directory and refuses to overwrite without --force", async () => {
    const h = await makeHarness()
    expect(await h.run("init")).toBe(EXIT.ok)
    expect(h.files.has("/work/project/conductor.yaml")).toBe(true)

    h.err.length = 0
    expect(await h.run("init")).toBe(EXIT.failure)
    expect(h.err.join("\n")).toContain("already exists")

    expect(await h.run("init", "--force")).toBe(EXIT.ok)
  })

  it("writes a config the daemon's own registry accepts", async () => {
    const h = await makeHarness()
    expect(await h.run("init")).toBe(EXIT.ok)
    const written = h.files.get("/work/project/conductor.yaml")!
    const project = tempDir("conductor-cli-init-")
    writeFileSync(join(project, "conductor.yaml"), written)
    const result = h.daemon.registry.register(project)
    expect(result.ok).toBe(true)
  })

  it("init needs no daemon address", async () => {
    const h = await makeHarness()
    const code = await runCli(["init"], { ...h.deps, env: {} })
    expect(code).toBe(EXIT.ok)
  })
})

describe("CLI: API client error handling", () => {
  it("wraps transport failures as an unreachable ApiError", async () => {
    const client = new ApiClient({ url: "http://down.test" }, async () => {
      throw new Error("connect ECONNREFUSED")
    })
    try {
      await client.health()
      throw new Error("expected ApiError")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(0)
      expect((err as ApiError).code).toBe("unreachable")
    }
  })

  it("maps an unreachable daemon to the dedicated exit code", async () => {
    const h = await makeHarness()
    const deps: CliDeps = {
      ...h.deps,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED")
      },
    }
    expect(await runCli(["status"], deps)).toBe(EXIT.unreachable)
  })

  it("surfaces the error envelope fields in --json error output", async () => {
    const h = await makeHarness()
    expect(await h.run("status", "nope", "--json")).toBe(EXIT.notFound)
    const envelope = JSON.parse(h.err.at(-1)!) as { error: { code: string; status: number; requestId: string } }
    expect(envelope.error.code).toBe("not_found")
    expect(envelope.error.status).toBe(404)
    expect(typeof envelope.error.requestId).toBe("string")
  })

  it("carries non-envelope failures with a synthetic http code", async () => {
    const client = new ApiClient({ url: "http://weird.test" }, async () => new Response("oops", { status: 502 }))
    try {
      await client.health()
      throw new Error("expected ApiError")
    } catch (err) {
      expect((err as ApiError).code).toBe("http_502")
      expect((err as ApiError).status).toBe(502)
    }
  })
})

describe("CLI: daemon command", () => {
  const VALID_CONFIG = `
databasePath: /var/lib/conductor/state.db
projects:
  - /work/project
bind:
  host: 127.0.0.1
  port: 4400
auth:
  mode: none
`

  interface DaemonHarness {
    deps: CliDeps
    out: string[]
    err: string[]
    files: Map<string, string>
    starts: DaemonStartInput[]
    startError: Error | null
    exitCode: number
  }

  function makeDaemonHarness(): DaemonHarness {
    const files = new Map<string, string>()
    const out: string[] = []
    const err: string[] = []
    const starts: DaemonStartInput[] = []
    const harness: DaemonHarness = {
      out,
      err,
      files,
      starts,
      startError: null,
      exitCode: 0,
      deps: {
        env: {},
        stdout: line => out.push(line),
        stderr: line => err.push(line),
        readFile: path => {
          const content = files.get(path)
          if (content === undefined) throw new Error(`ENOENT: ${path}`)
          return content
        },
        writeFile: (path, content) => {
          files.set(path, content)
        },
        exists: path => files.has(path),
        mkdir: () => {},
        cwd: () => "/work",
        startDaemon: input => {
          starts.push(input)
          return {
            started: harness.startError ? Promise.reject(harness.startError) : Promise.resolve(),
            exited: Promise.resolve(harness.exitCode),
          }
        },
      },
    }
    return harness
  }

  it("zero-flag start without HOME or XDG is a usage error", async () => {
    const h = makeDaemonHarness()
    expect(await runCli(["daemon"], h.deps)).toBe(EXIT.usage)
    expect(h.err.join("\n")).toContain("--config")
    expect(h.starts.length).toBe(0)
  })

  it("zero-flag start generates the platform default config and starts", async () => {
    const h = makeDaemonHarness()
    const deps = { ...h.deps, env: { HOME: "/home/dev" } }
    expect(await runCli(["daemon"], deps)).toBe(EXIT.ok)
    const generated = h.files.get("/home/dev/.config/conductor/daemon.yaml")
    expect(generated).toBeDefined()
    expect(generated!).toContain("databasePath: /home/dev/.local/share/conductor/conductor.db")
    expect(generated!).toContain("projects: []")
    expect(h.starts.length).toBe(1)
    expect(h.starts[0]!.api.bind).toEqual({ host: "127.0.0.1", port: 4400 })
    expect(h.starts[0]!.daemon.projects).toEqual([])
    const logged = h.out.find(line => line.includes("daemon config generated"))
    expect(logged).toBeDefined()
  })

  it("zero-flag start honours XDG overrides", async () => {
    const h = makeDaemonHarness()
    const deps = { ...h.deps, env: { HOME: "/home/dev", XDG_CONFIG_HOME: "/xdg/cfg", XDG_DATA_HOME: "/xdg/data" } }
    expect(await runCli(["daemon"], deps)).toBe(EXIT.ok)
    expect(h.files.get("/xdg/cfg/conductor/daemon.yaml")).toContain("databasePath: /xdg/data/conductor/conductor.db")
  })

  it("zero-flag start reuses an existing platform config without modifying it", async () => {
    const h = makeDaemonHarness()
    h.files.set("/home/dev/.config/conductor/daemon.yaml", VALID_CONFIG)
    const deps = { ...h.deps, env: { HOME: "/home/dev" } }
    expect(await runCli(["daemon"], deps)).toBe(EXIT.ok)
    expect(h.files.get("/home/dev/.config/conductor/daemon.yaml")).toBe(VALID_CONFIG)
    expect(h.starts[0]!.daemon.databasePath).toBe("/var/lib/conductor/state.db")
  })

  it("an explicit --config path that does not exist is still an error", async () => {
    const h = makeDaemonHarness()
    const deps = { ...h.deps, env: { HOME: "/home/dev" } }
    expect(await runCli(["daemon", "--config", "/missing.yaml"], deps)).toBe(EXIT.usage)
    expect(h.files.has("/missing.yaml")).toBe(false)
    expect(h.starts.length).toBe(0)
  })

  it("rejects --config together with --init-config", async () => {
    const h = makeDaemonHarness()
    expect(await runCli(["daemon", "--config", "/a.yaml", "--init-config", "/b.yaml"], h.deps)).toBe(EXIT.usage)
  })

  it("errors with usage when the config file cannot be read", async () => {
    const h = makeDaemonHarness()
    expect(await runCli(["daemon", "--config", "/missing.yaml"], h.deps)).toBe(EXIT.usage)
    expect(h.err.join("\n")).toContain("/missing.yaml")
  })

  it("writes the example config with --init-config and refuses to overwrite without --force", async () => {
    const h = makeDaemonHarness()
    expect(await runCli(["daemon", "--init-config", "/etc/conductor/daemon.yaml"], h.deps)).toBe(EXIT.ok)
    const written = h.files.get("/etc/conductor/daemon.yaml")!
    expect(written).toContain("databasePath:")
    expect(written).toContain("bind:")
    expect(written).toContain("auth:")

    h.err.length = 0
    expect(await runCli(["daemon", "--init-config", "/etc/conductor/daemon.yaml"], h.deps)).toBe(EXIT.failure)
    expect(h.err.join("\n")).toContain("already exists")
    expect(await runCli(["daemon", "--init-config", "/etc/conductor/daemon.yaml", "--force"], h.deps)).toBe(EXIT.ok)
  })

  it("the --init-config template itself parses and assembles", async () => {
    const h = makeDaemonHarness()
    expect(await runCli(["daemon", "--init-config", "/tmp/example.yaml"], h.deps)).toBe(EXIT.ok)
    const template = h.files.get("/tmp/example.yaml")!
    const config = loadDaemonConfig(template)
    expect(config.daemon.databasePath).toBe("/var/lib/conductor/conductor.db")
    expect(config.api.auth.mode).toBe("none")
  })

  it("assembles DaemonConfig + ApiConfig from the file and starts the daemon", async () => {
    const h = makeDaemonHarness()
    h.files.set("/daemon.yaml", VALID_CONFIG)
    expect(await runCli(["daemon", "--config", "/daemon.yaml"], h.deps)).toBe(EXIT.ok)
    expect(h.starts.length).toBe(1)
    const input = h.starts[0]!
    expect(input.daemon.databasePath).toBe("/var/lib/conductor/state.db")
    expect(input.daemon.projects).toEqual(["/work/project"])
    expect(input.daemon.heartbeatIntervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
    expect(input.api.bind).toEqual({ host: "127.0.0.1", port: 4400 })
    expect(input.api.auth).toEqual({ mode: "none" })
  })

  it("logs an explicit warning for auth.mode none", async () => {
    const h = makeDaemonHarness()
    h.files.set("/daemon.yaml", VALID_CONFIG)
    await runCli(["daemon", "--config", "/daemon.yaml"], h.deps)
    const warning = h.out.map(line => JSON.parse(line) as { level: string; message: string })
      .find(entry => entry.level === "warn" && entry.message.includes("authentication is disabled"))
    expect(warning).toBeDefined()
  })

  it("does not warn for bearer auth and passes the token through", async () => {
    const h = makeDaemonHarness()
    h.files.set("/daemon.yaml", VALID_CONFIG.replace("auth:\n  mode: none", 'auth:\n  mode: bearer\n  token: "s3cret"'))
    await runCli(["daemon", "--config", "/daemon.yaml"], h.deps)
    expect(h.starts[0]!.api.auth).toEqual({ mode: "bearer", token: "s3cret" })
    const warnings = h.out.filter(line => line.includes("authentication is disabled"))
    expect(warnings).toEqual([])
  })

  it("propagates a startup failure as exit 1 with the reason", async () => {
    const h = makeDaemonHarness()
    h.files.set("/daemon.yaml", VALID_CONFIG)
    h.startError = new Error("migration exploded")
    expect(await runCli(["daemon", "--config", "/daemon.yaml"], h.deps)).toBe(EXIT.failure)
    expect(h.err.join("\n")).toContain("migration exploded")
  })

  it("returns the daemon's exit code after shutdown", async () => {
    const h = makeDaemonHarness()
    h.files.set("/daemon.yaml", VALID_CONFIG)
    h.exitCode = 0
    expect(await runCli(["daemon", "--config", "/daemon.yaml"], h.deps)).toBe(0)
  })

  it("passes --no-ui through to the daemon start input", async () => {
    const h = makeDaemonHarness()
    h.files.set("/daemon.yaml", VALID_CONFIG)
    expect(await runCli(["daemon", "--config", "/daemon.yaml", "--no-ui"], h.deps)).toBe(EXIT.ok)
    expect(h.starts[0]!.noUi).toBe(true)
    h.starts.length = 0
    expect(await runCli(["daemon", "--config", "/daemon.yaml"], h.deps)).toBe(EXIT.ok)
    expect(h.starts[0]!.noUi).toBe(false)
  })

  it("fails cleanly when no daemon runtime is wired", async () => {
    const h = makeDaemonHarness()
    h.files.set("/daemon.yaml", VALID_CONFIG)
    const { startDaemon: _omitted, ...rest } = h.deps
    expect(await runCli(["daemon", "--config", "/daemon.yaml"], rest)).toBe(EXIT.failure)
    expect(h.err.join("\n")).toContain("cannot start a daemon")
  })
})

describe("CLI: daemon config parsing", () => {
  const base = {
    databasePath: "/db/state.db",
    projects: ["/p1"],
    bind: { host: "127.0.0.1", port: 4400 },
    auth: { mode: "none" },
  }

  it("accepts a full configuration", () => {
    const config = assembleDaemonConfig({
      ...base,
      auth: { mode: "bearer", token: "t" },
      heartbeatIntervalMs: 250,
      createDatabaseDirectory: false,
      engine: { runTtlMs: 1000, nudgeIdleCycles: 2, maxNudges: 3 },
      actions: { bundledPath: "/actions", localPaths: ["/more"] },
    })
    expect(config.daemon).toEqual({
      databasePath: "/db/state.db",
      projects: ["/p1"],
      heartbeatIntervalMs: 250,
      createDatabaseDirectory: false,
      engine: { runTtlMs: 1000, nudgeIdleCycles: 2, maxNudges: 3 },
      actions: { bundledPath: "/actions", localPaths: ["/more"] },
    })
    expect(config.api).toEqual({
      bind: { host: "127.0.0.1", port: 4400 },
      auth: { mode: "bearer", token: "t" },
    })
  })

  it.each([
    ["not a mapping", "just a string", "must be a YAML mapping"],
    ["missing databasePath", { ...base, databasePath: undefined }, "databasePath"],
    ["non-string projects", { ...base, projects: [42] }, "projects"],
    ["missing bind", { ...base, bind: undefined }, "bind"],
    ["bad port", { ...base, bind: { host: "127.0.0.1", port: "4400" } }, "bind.port"],
    ["port out of range", { ...base, bind: { host: "127.0.0.1", port: 70000 } }, "bind.port"],
    ["missing auth", { ...base, auth: undefined }, "auth"],
    ["unknown auth mode", { ...base, auth: { mode: "open" } }, "auth.mode"],
    ["bearer without token", { ...base, auth: { mode: "bearer" } }, "auth.token"],
    ["token with mode none", { ...base, auth: { mode: "none", token: "x" } }, "auth.token"],
    ["unknown top-level field", { ...base, portt: 1 }, "portt"],
    ["unknown engine field", { ...base, engine: { ttl: 5 } }, "engine.ttl"],
    ["negative heartbeat", { ...base, heartbeatIntervalMs: -5 }, "heartbeatIntervalMs"],
    ["removed ui field", { ...base, ui: { staticDir: "/x" } }, "ui"],
    ["bad localPaths", { ...base, actions: { localPaths: [""] } }, "actions.localPaths"],
    ["fractional nudgeIdleCycles", { ...base, engine: { nudgeIdleCycles: 2.5 } }, "positive integer"],
    ["fractional maxNudges", { ...base, engine: { maxNudges: 1.5 } }, "positive integer"],
  ])("rejects %s", (_name, raw, needle) => {
    expect(() => assembleDaemonConfig(raw)).toThrow(needle as string)
  })

  it("loadDaemonConfig reports YAML syntax errors with line positions", () => {
    expect(() => loadDaemonConfig("databasePath: [")).toThrow("not valid YAML")
  })

  it("loadDaemonConfig rejects YAML aliases (safety posture matches parseWorkflow)", () => {
    expect(() => loadDaemonConfig("a: &x 1\ndatabasePath: *x")).toThrow()
  })
})

describe("CLI: zero-config platform paths", () => {
  it("platformPaths uses XDG variables and falls back to HOME", () => {
    expect(platformPaths({ XDG_CONFIG_HOME: "/x/cfg", XDG_DATA_HOME: "/x/data" })).toEqual({
      configPath: "/x/cfg/conductor/daemon.yaml",
      dataDir: "/x/data/conductor",
    })
    expect(platformPaths({ HOME: "/home/u" })).toEqual({
      configPath: "/home/u/.config/conductor/daemon.yaml",
      dataDir: "/home/u/.local/share/conductor",
    })
    expect(() => platformPaths({})).toThrow(UsageError)
  })

  it("the generated default config assembles with empty projects", () => {
    const source = defaultDaemonConfig(platformPaths({ HOME: "/home/u" }))
    const config = loadDaemonConfig(source)
    expect(config.daemon.projects).toEqual([])
    expect(config.daemon.databasePath).toBe("/home/u/.local/share/conductor/conductor.db")
    expect(config.api.bind).toEqual({ host: "127.0.0.1", port: 4400 })
    expect(config.api.auth).toEqual({ mode: "none" })
  })

  it("addProjectToConfig is idempotent and validates before writing", () => {
    const source = defaultDaemonConfig(platformPaths({ HOME: "/home/u" }))
    const first = addProjectToConfig(source, "/work/app")
    expect(first.changed).toBe(true)
    const updated = (first as { changed: true; source: string }).source
    expect(loadDaemonConfig(updated).daemon.projects).toEqual(["/work/app"])
    expect(addProjectToConfig(updated, "/work/app")).toEqual({ changed: false })
    const second = addProjectToConfig(updated, "/work/other")
    expect(second.changed).toBe(true)
    expect(loadDaemonConfig((second as { changed: true; source: string }).source).daemon.projects).toEqual([
      "/work/app",
      "/work/other",
    ])
    expect(() => addProjectToConfig("databasePath: [", "/work/app")).toThrow(UsageError)
  })
})

describe("CLI: init registers the project", () => {
  it("adds the project to the platform daemon config, generating it when absent, idempotently", async () => {
    const h = await makeHarness({ env: { HOME: "/home/dev" } })
    const deps = { ...h.deps, env: { HOME: "/home/dev" } }
    expect(await runCli(["init", "--dir", "/work/app"], deps)).toBe(EXIT.ok)
    const configPath = "/home/dev/.config/conductor/daemon.yaml"
    expect(h.files.has(configPath)).toBe(true)
    expect(loadDaemonConfig(h.files.get(configPath)!).daemon.projects).toEqual(["/work/app"])

    expect(await runCli(["init", "--dir", "/work/app", "--force"], deps)).toBe(EXIT.ok)
    expect(loadDaemonConfig(h.files.get(configPath)!).daemon.projects).toEqual(["/work/app"])
  })

  it("registers live with a reachable daemon through POST /v1/projects", async () => {
    const h = await makeHarness()
    const project = writeProject()
    const deps = { ...h.deps, env: { HOME: "/home/dev", CONDUCTOR_URL: CLI_URL } }
    expect(await runCli(["init", "--dir", project, "--force"], deps)).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain("registered the project live")
    expect(h.daemon.registry.getStatus(project).state).toBe("valid")
  })

  it("an unreachable daemon is a hint, not a failure", async () => {
    const h = await makeHarness()
    const deps: CliDeps = {
      ...h.deps,
      env: { HOME: "/home/dev", CONDUCTOR_URL: "http://down.test" },
      fetchImpl: async () => {
        throw new Error("connection refused")
      },
    }
    expect(await runCli(["init", "--dir", "/work/app"], deps)).toBe(EXIT.ok)
    expect(h.out.join("\n")).toContain("Daemon not reachable")
  })

  it("--no-register scaffolds only", async () => {
    const h = await makeHarness()
    const deps = { ...h.deps, env: { HOME: "/home/dev" } }
    expect(await runCli(["init", "--dir", "/work/app", "--no-register"], deps)).toBe(EXIT.ok)
    expect(h.files.has("/home/dev/.config/conductor/daemon.yaml")).toBe(false)
    expect(h.files.has("/work/app/conductor.yaml")).toBe(true)
  })
})

describe("CLI: connection fallback to the daemon config", () => {
  const daemonYaml = defaultDaemonConfig(platformPaths({ HOME: "/home/dev" }))

  it("uses the platform daemon config when no explicit source exists", () => {
    const files = new Map([["/home/dev/.config/conductor/daemon.yaml", daemonYaml]])
    const connection = resolveConnection({
      flags: {},
      env: { HOME: "/home/dev" },
      readFile: path => {
        const content = files.get(path)
        if (content === undefined) throw new Error("ENOENT")
        return content
      },
      exists: path => files.has(path),
    })
    expect(connection).toEqual({ url: "http://127.0.0.1:4400" })
  })

  it("carries the bearer token from the daemon config", () => {
    const withBearer = daemonYaml.replace("auth:\n  mode: none", 'auth:\n  mode: bearer\n  token: "s3cret"')
    const files = new Map([["/home/dev/.config/conductor/daemon.yaml", withBearer]])
    const connection = resolveConnection({
      flags: {},
      env: { HOME: "/home/dev" },
      readFile: path => files.get(path)!,
      exists: path => files.has(path),
    })
    expect(connection).toEqual({ url: "http://127.0.0.1:4400", token: "s3cret" })
  })

  it("explicit sources keep precedence over the fallback", () => {
    const files = new Map([["/home/dev/.config/conductor/daemon.yaml", daemonYaml]])
    const connection = resolveConnection({
      flags: { url: "http://explicit:9999" },
      env: { HOME: "/home/dev" },
      readFile: path => files.get(path)!,
      exists: path => files.has(path),
    })
    expect(connection.url).toBe("http://explicit:9999")
  })

  it("no source anywhere stays a usage error", () => {
    expect(() =>
      resolveConnection({
        flags: {},
        env: { HOME: "/home/dev" },
        readFile: () => {
          throw new Error("ENOENT")
        },
        exists: () => false,
      }),
    ).toThrow(UsageError)
  })
})

describe("CLI: init review fixes", () => {
  it("resolves a relative --dir against cwd before persisting", async () => {
    const h = await makeHarness()
    const deps = { ...h.deps, env: { HOME: "/home/dev" } }
    expect(await runCli(["init", "--dir", "sub/app"], deps)).toBe(EXIT.ok)
    expect(h.files.has("/work/project/sub/app/conductor.yaml")).toBe(true)
    const config = h.files.get("/home/dev/.config/conductor/daemon.yaml")!
    expect(loadDaemonConfig(config).daemon.projects).toEqual(["/work/project/sub/app"])
  })

  it("an explicit connection registers live only and leaves the local platform config untouched", async () => {
    const h = await makeHarness()
    const project = writeProject()
    const deps = { ...h.deps, env: { HOME: "/home/dev", CONDUCTOR_URL: CLI_URL } }
    expect(await runCli(["init", "--dir", project, "--force"], deps)).toBe(EXIT.ok)
    expect(h.files.has("/home/dev/.config/conductor/daemon.yaml")).toBe(false)
    expect(h.out.join("\n")).toContain("registering live only")
    expect(h.daemon.registry.getStatus(project).state).toBe("valid")
  })
})

describe("CLI: start project default and unknown commands", () => {
  it("start defaults --project to the working directory", async () => {
    const h = await makeHarness()
    const deps = { ...h.deps, cwd: () => h.project }
    const code = await runCli(["start", "From inside the project", "--json"], deps)
    expect(code).toBe(EXIT.ok)
    const payload = JSON.parse(h.out.pop()!) as { feature: { id: string } }
    expect(payload.feature.id).toBeTruthy()
  })

  it("start resolves a relative --project against cwd", async () => {
    const h = await makeHarness()
    expect(await h.run("start", "Bad relative", "--project", "nope", "--json")).toBe(EXIT.failure)
    expect(h.err.join("\n")).toContain("/work/project/nope")
  })

  it("an unknown command is a usage error, not a connection error", async () => {
    const h = await makeHarness()
    const code = await runCli(["deamon"], { ...h.deps, env: {} })
    expect(code).toBe(EXIT.usage)
    expect(h.err.join("\n")).toContain('unknown command "deamon"')
    expect(h.err.join("\n")).not.toContain("daemon address is required")
  })
})
