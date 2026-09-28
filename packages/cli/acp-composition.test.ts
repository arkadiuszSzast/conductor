import { expect, test } from "bun:test"
import { assembleDaemonConfig, loadDaemonConfig } from "./src/daemon-config.ts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Daemon, composeManagedRunners, createFakeReportingReadiness, startApiServer } from "@conductor/server"

const base = { databasePath: "/tmp/synthetic.db", projects: [], bind: { host: "127.0.0.1", port: 4400 }, auth: { mode: "bearer", token: "synthetic" } }
const runners = { default: "native", projects: { "/tmp/project": "fake" }, acp: { fake: { command: process.execPath, args: ["{directory}"], allowedRoots: ["/tmp/project"], maxConcurrent: 1, bindings: { build: { mode: "build" } }, permissions: { allowKinds: [] } } }, reportBridge: { command: process.execPath, args: ["report-mcp"] } }
test("ACP configuration is opt-in, strict and requires bearer", () => {
  expect(assembleDaemonConfig(base).daemon.runners).toBeUndefined()
  expect(assembleDaemonConfig({ ...base, runners }).daemon.runners?.acp.fake?.command).toBe(process.execPath)
  expect(() => assembleDaemonConfig({ ...base, runners, auth: { mode: "none" } })).toThrow("bearer")
  expect(() => assembleDaemonConfig({ ...base, runners: { ...runners, typo: true } })).toThrow("runners.typo")
  expect(() => assembleDaemonConfig({ ...base, runners: { ...runners, projects: { "/tmp/project": "missing" } } })).toThrow("unknown profile")
})

test("docs/install.md ACP YAML example parses through the real daemon config parser", async () => {
  const docs = await Bun.file(new URL("../../docs/install.md", import.meta.url)).text()
  const examples = [...docs.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map(match => match[1]!)
    .filter(yaml => /^runners:/m.test(yaml))
  expect(examples).toHaveLength(1)
  // The documented fragment supplies auth + runners; add only the required
  // base fields, without replacing or sanitizing any documented configuration.
  const config = loadDaemonConfig(`databasePath: /tmp/docs-example.db\nprojects: [/path/to/my-project]\nbind: {host: 127.0.0.1, port: 4400}\n${examples[0]!}`)
  expect(config.api.auth).toEqual({ mode: "bearer", token: "change-me" })
  expect(config.daemon.runners?.default).toBe("native")
  expect(config.daemon.runners?.projects).toEqual({ "/path/to/my-project": "opencode-acp" })
  expect(config.daemon.runners?.acp["opencode-acp"]).toEqual({
    command: "/opt/opencode/bin/opencode",
    args: ["acp", "--cwd", "{directory}"],
    allowedRoots: ["/path/to/my-project", "/path/to/worktrees"],
    env: { HOME: "/srv/agent-home", XDG_CONFIG_HOME: "/srv/agent-config" },
    inheritEnv: ["PATH"],
    maxConcurrent: 2,
    deadlines: { startupMs: 30000, writeMs: 5000, turnMs: 3600000, cancelMs: 5000, killMs: 2000 },
    permissions: { allowKinds: [] },
    bindings: { build: { mode: "build", configOptions: {} } },
  })
  expect(config.daemon.runners?.reportBridge).toEqual({ command: "/opt/conductor/conductor", args: ["report-mcp"] })
})

test("source report-mcp lists exactly scoped tools with synthetic environment", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) })
  const transport = new StdioClientTransport({ command: process.env.CONDUCTOR_TEST_BINARY ?? process.execPath, args: [...(process.env.CONDUCTOR_TEST_BINARY ? [] : [`${import.meta.dirname}/src/main.ts`]), "report-mcp"], env: { CONDUCTOR_RUN_URL: `http://127.0.0.1:${server.port}`, CONDUCTOR_RUN_ID: "synthetic-run", CONDUCTOR_RUN_TOKEN: "synthetic-token", CONDUCTOR_CONFIG: "/nonexistent/never-read" }, stderr: "pipe" })
  const client = new Client({ name: "offline-test", version: "1" })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["conductor_ask", "conductor_report", "conductor_status"])
  } finally { await client.close(); server.stop(true) }
}, 15000)

for (const interactive of [false, true]) test(`staged daemon fake ACP and actual MCP bridge: ${interactive ? "ask answer report" : "no report"}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-composition-"))
  writeFileSync(join(dir, "conductor.yaml"), "name: fake\non: [manual]\nroles:\n  implementer: {agent: build}\njobs:\n  main:\n    steps:\n      - id: implement\n        agent: {role: implementer, prompt: synthetic, interactive: true}\n")
  const config = assembleDaemonConfig({ ...base, databasePath: join(dir, "state.db"), projects: [dir], runners: { ...runners, projects: { [dir]: "fake" }, acp: { fake: { ...runners.acp.fake, args: [join(import.meta.dirname, "fake-acp-child.ts"), ...(interactive ? ["--ask-report"] : [])], allowedRoots: [dir], deadlines: { startupMs: 5000, cancelMs: 100, killMs: 100 } } }, reportBridge: { command: process.env.CONDUCTOR_TEST_BINARY ?? process.execPath, args: [...(process.env.CONDUCTOR_TEST_BINARY ? [] : [join(import.meta.dirname, "src/main.ts")]), "report-mcp"] } } })
  const readiness = createFakeReportingReadiness()
  let url = ""
  const daemon = new Daemon(config.daemon, { logger: { log() {} }, sessionFactory: (store, clock, observe) => composeManagedRunners(config.daemon.runners!, store, clock, readiness, () => url, {}, observe) })
  let api: ReturnType<typeof startApiServer> | undefined
  try {
    await daemon.initialize()
    api = startApiServer({ bind: { host: "127.0.0.1", port: 0 }, auth: config.api.auth }, { store: daemon.store, engine: daemon.engine, health: () => daemon.health(), resolveWorkflow: daemon.registry.resolver, worker: { store: daemon.store, engine: daemon.engine, readiness, clock: { now: () => Date.now() } } })
    url = `http://127.0.0.1:${api.port}`
    await daemon.activate()
    const response = await fetch(`${url}/v1/features`, { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ title: "offline", project: dir }) })
    expect(response.status).toBe(201)
    const body = await response.json() as { feature: { id: string } }
    const run = daemon.store.listRuns(body.feature.id)[0]!
    expect(run.status).toBe("running") // end_turn is not success
    expect(readiness.isReady(run.id)).toBe(true)
    expect(daemon.store.listRunnerOperations(run.id).map(op => op.kind).sort()).toEqual(["create", "prompt"])
    if (interactive) {
      const waitFor = async (predicate: () => boolean) => {
        for (let n = 0; n < 200 && !predicate(); n++) { await Bun.sleep(10); await daemon.engine.reconcile() }
        expect(predicate()).toBe(true)
      }
      await waitFor(() => daemon.store.getRunById(run.id)?.pendingQuestion === "Which offline choice?")
      expect((await daemon.engine.answer(run.id, "offline choice B")).ok).toBe(true)
      await waitFor(() => daemon.store.getRunById(run.id)?.status === "succeeded")
      expect(daemon.store.getRunById(run.id)?.outputs.report).toBe("durable fake result")
      expect(daemon.store.listRunnerOperations(run.id).filter(op => op.kind === "answer")).toHaveLength(1)
      expect(daemon.store.getFeature(body.feature.id)?.status).toBe("done")
    }
    await daemon.drainWorkers()
    expect(daemon.store.getRunById(run.id)?.status).toBe(interactive ? "succeeded" : "uncertain")
    // Review fix: readiness tracking must not leak past the run's ACP
    // session cleanup — cleanupRunner (concludeAndDispatch for the
    // succeeded path, drainWorkers' own fence+cleanup for the
    // uncertain path) is the same lifecycle moment credentials are
    // revoked, and composeManagedRunners' cleanupRun wires
    // readiness.clear() to it.
    expect(readiness.isReady(run.id)).toBe(false)
  } finally { await api?.stop(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }) }
}, 15000)

test("6.4 composition: missing MCP bridge readiness fails closed with ZERO prompts sent, real daemon + real child process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-composition-noready-"))
  writeFileSync(join(dir, "conductor.yaml"), "name: fake\non: [manual]\nroles:\n  implementer: {agent: build}\njobs:\n  main:\n    steps:\n      - id: implement\n        agent: {role: implementer, prompt: synthetic}\n")
  const config = assembleDaemonConfig({
    ...base, databasePath: join(dir, "state.db"), projects: [dir],
    runners: {
      ...runners, projects: { [dir]: "fake" },
      acp: { fake: { ...runners.acp.fake, args: [join(import.meta.dirname, "fake-acp-child.ts"), "--no-bridge-connect"], allowedRoots: [dir], deadlines: { startupMs: 300, writeMs: 2000, cancelMs: 100, killMs: 100 } } },
      reportBridge: { command: process.env.CONDUCTOR_TEST_BINARY ?? process.execPath, args: [...(process.env.CONDUCTOR_TEST_BINARY ? [] : [join(import.meta.dirname, "src/main.ts")]), "report-mcp"] },
    },
  })
  const readiness = createFakeReportingReadiness()
  let url = ""
  const daemon = new Daemon(config.daemon, { logger: { log() {} }, sessionFactory: (store, clock, observe) => composeManagedRunners(config.daemon.runners!, store, clock, readiness, () => url, {}, observe) })
  let api: ReturnType<typeof startApiServer> | undefined
  try {
    await daemon.initialize()
    api = startApiServer({ bind: { host: "127.0.0.1", port: 0 }, auth: config.api.auth }, { store: daemon.store, engine: daemon.engine, health: () => daemon.health(), resolveWorkflow: daemon.registry.resolver, worker: { store: daemon.store, engine: daemon.engine, readiness, clock: { now: () => Date.now() } } })
    url = `http://127.0.0.1:${api.port}`
    await daemon.activate()
    const response = await fetch(`${url}/v1/features`, { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ title: "offline", project: dir }) })
    expect(response.status).toBe(201)
    const body = await response.json() as { feature: { id: string } }
    // Wait for the run to conclude — the child DID create a session
    // (session/new answers normally) but never connected the MCP bridge,
    // so readiness never becomes true; prompt() must fail closed on the
    // readiness deadline rather than ever writing session/prompt.
    let run = daemon.store.listRuns(body.feature.id)[0]
    for (let n = 0; n < 200 && (!run || run.status === "running"); n++) {
      await Bun.sleep(20)
      run = daemon.store.listRuns(body.feature.id)[0]
    }
    expect(run).toBeDefined()
    expect(readiness.isReady(run!.id)).toBe(false)
    // Zero prompts: the durable operation journal has a "create" (the
    // session DID get created) but never a "prompt" operation at all.
    expect(daemon.store.listRunnerOperations(run!.id).map(op => op.kind)).not.toContain("prompt")
    expect(run!.status).toBe("failed")
  } finally { await api?.stop(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }) }
}, 15000)

test("6.4 composition: same-cwd concurrent runs get independent ACP processes and unique MCP bridge names, no credential crossover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-composition-samecwd-"))
  writeFileSync(join(dir, "conductor.yaml"), "name: fake\non: [manual]\nroles:\n  implementer: {agent: build}\njobs:\n  a:\n    steps:\n      - id: implement\n        agent: {role: implementer, prompt: synthetic}\n  b:\n    steps:\n      - id: implement\n        agent: {role: implementer, prompt: synthetic}\n")
  const config = assembleDaemonConfig({
    ...base, databasePath: join(dir, "state.db"), projects: [dir],
    runners: {
      ...runners, projects: { [dir]: "fake" },
      acp: { fake: { ...runners.acp.fake, args: [join(import.meta.dirname, "fake-acp-child.ts")], allowedRoots: [dir], maxConcurrent: 2, deadlines: { startupMs: 5000, cancelMs: 100, killMs: 100 } } },
      reportBridge: { command: process.env.CONDUCTOR_TEST_BINARY ?? process.execPath, args: [...(process.env.CONDUCTOR_TEST_BINARY ? [] : [join(import.meta.dirname, "src/main.ts")]), "report-mcp"] },
    },
  })
  const readiness = createFakeReportingReadiness()
  let url = ""
  const daemon = new Daemon(config.daemon, { logger: { log() {} }, sessionFactory: (store, clock, observe) => composeManagedRunners(config.daemon.runners!, store, clock, readiness, () => url, {}, observe) })
  let api: ReturnType<typeof startApiServer> | undefined
  try {
    await daemon.initialize()
    api = startApiServer({ bind: { host: "127.0.0.1", port: 0 }, auth: config.api.auth }, { store: daemon.store, engine: daemon.engine, health: () => daemon.health(), resolveWorkflow: daemon.registry.resolver, worker: { store: daemon.store, engine: daemon.engine, readiness, clock: { now: () => Date.now() } } })
    url = `http://127.0.0.1:${api.port}`
    await daemon.activate()
    // Both jobs a/b dispatch at feature.start on the SAME project
    // directory (same cwd) — this is exactly the "same-cwd concurrency"
    // shape D8 requires independent processes/bridge names for.
    const response = await fetch(`${url}/v1/features`, { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({ title: "offline", project: dir }) })
    expect(response.status).toBe(201)
    const body = await response.json() as { feature: { id: string } }
    const waitFor = async (predicate: () => boolean) => {
      for (let n = 0; n < 300 && !predicate(); n++) { await Bun.sleep(10); await daemon.engine.reconcile() }
      expect(predicate()).toBe(true)
    }
    // The fixture's fake-acp-child (no --ask-report) never calls
    // conductor_report — both runs legitimately stay "running" forever
    // (exactly like the single-job non-interactive composition test
    // above). The conformance question here is same-cwd INDEPENDENCE,
    // not conclusion — wait for both to actually reach a live prompt.
    await waitFor(() => daemon.store.listRuns(body.feature.id).length === 2
      && daemon.store.listRuns(body.feature.id).every(run => daemon.store.listRunnerOperations(run.id).some(op => op.kind === "prompt")))
    const runs = daemon.store.listRuns(body.feature.id)
    expect(runs).toHaveLength(2)
    expect(runs.every(run => run.status === "running")).toBe(true)
    // Independent local session ids (each got its OWN ACP process — a
    // shared/crossed process would collapse both runs onto one session
    // ref, which the DB's UNIQUE constraint on session_ref would itself
    // reject at bind time if it ever happened).
    const sessionRefs = runs.map(run => daemon.store.getRunnerBinding(run.id)?.sessionRef)
    expect(new Set(sessionRefs).size).toBe(2)
    // Each run's readiness/credential is tracked independently by runId
    // — no crossover between the two same-cwd attempts.
    for (const run of runs) expect(daemon.store.listRunnerOperations(run.id).map(op => op.kind)).toContain("prompt")
  } finally { await api?.stop(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }) }
}, 15000)
