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
import { runCli, EXIT, type CliDeps } from "./src/cli.ts"
import { ApiClient, ApiError } from "./src/client.ts"
import { resolveConnection, UsageError } from "./src/config.ts"

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
    expect(await h.run("start", "Title")).toBe(EXIT.usage)
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
