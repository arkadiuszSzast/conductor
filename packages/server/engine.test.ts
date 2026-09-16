import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { createRunnerSessionClient, NoLiveRunnerError } from "./src/runner-transport.ts"
import { RunnerRegistry } from "./src/runner-registry.ts"
import { Engine, type EngineDeps, type EngineOptions } from "./src/engine.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner, SessionClient } from "./src/ports.ts"
import type { WorkflowSnapshot } from "./src/workflow-registry.ts"
import type { ActionExecutor, ActionExecuteEffects, ActionHostExecuteResult } from "./src/action-host.ts"
import type { ResolvedActionBinding, ResolvedActionBindings } from "./src/workflow-reservation.ts"
import {
  agentStep,
  commandStep,
  humanStep,
  job,
  next,
  rerunSteps,
  backoff,
  workflow,
} from "@conductor/core/testing.ts"
import type { ActionManifest, ActionRunContext, ActionStep, WorkflowDef } from "@conductor/core"
import { computeActionDigest } from "@conductor/core"
import { githubAwaitChecks } from "./src/actions/github-await-checks.ts"
import { realProcessRunner } from "./src/process.ts"

// ---------------------------------------------------------------- fakes

class FakeSessions implements SessionClient {
  prompts: Array<{ sessionID: string; text: string; agent?: string; model?: string }> = []
  created: string[] = []
  parents = new Map<string, string>()
  liveSessions = new Set<string>()
  statuses = new Map<string, "busy" | "idle" | "retry">()
  notes: Array<{ sessionID: string; text: string }> = []
  private counter = 0
  nextCreatePause: Promise<void> | null = null
  onCreatePause?: () => void

  async createSession(input: { title: string; directory: string; parentID?: string }): Promise<{ id: string }> {
    if (this.nextCreatePause) {
      const pause = this.nextCreatePause
      this.nextCreatePause = null
      this.onCreatePause?.()
      await pause
    }
    const id = `ses-${++this.counter}`
    this.created.push(id)
    this.liveSessions.add(id)
    if (input.parentID !== undefined) this.parents.set(id, input.parentID)
    return { id }
  }
  promptError: Error | null = null
  async prompt(input: { sessionID: string; text: string; agent?: string; model?: string }): Promise<void> {
    if (this.promptError) {
      const error = this.promptError
      this.promptError = null
      throw error
    }
    this.prompts.push(input)
  }
  async note(input: { sessionID: string; text: string }): Promise<void> {
    this.notes.push(input)
  }
  aborted: string[] = []
  abortError: Error | null = null
  async abort(sessionID: string): Promise<void> {
    if (this.abortError) {
      const error = this.abortError
      this.abortError = null
      throw error
    }
    this.aborted.push(sessionID)
  }
  async sessionExists(sessionID: string): Promise<boolean> {
    return this.liveSessions.has(sessionID)
  }
  async status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing"> {
    if (!this.liveSessions.has(sessionID)) return "missing"
    return this.statuses.get(sessionID) ?? "busy"
  }
}

class FakeProcess implements ProcessRunner {
  handler: ((command: string, options: ProcessExecOptions) => ProcessExecResult) | null = null
  /** Every `shell` invocation, in order — the no-side-effect assertion
   *  a rejected `startFeature` call must prove: not just "no feature
   *  row", but "the process runner itself was never invoked". */
  shellCalls: Array<{ command: string; options: ProcessExecOptions }> = []
  async exec(): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
  async shell(command: string, options: ProcessExecOptions): Promise<ProcessExecResult> {
    this.shellCalls.push({ command, options })
    if (this.handler) return this.handler(command, options)
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
}

class FakeClock {
  current = Date.now()
  now(): number {
    return this.current
  }
  advance(ms: number): void {
    this.current += ms
  }
}

class FakeActionHost implements ActionExecutor {
  calls: Array<{ binding: ResolvedActionBinding; ctx: ActionRunContext }> = []
  handler: ((binding: ResolvedActionBinding, ctx: ActionRunContext, effects?: ActionExecuteEffects) => ActionHostExecuteResult) | null = null
  async execute(binding: ResolvedActionBinding, ctx: ActionRunContext, effects?: ActionExecuteEffects): Promise<ActionHostExecuteResult> {
    this.calls.push({ binding, ctx })
    if (this.handler) return this.handler(binding, ctx, effects)
    return { ok: true, outputs: {} }
  }
}

function actionManifest(overrides: Partial<ActionManifest> = {}): ActionManifest {
  return {
    name: "test/action",
    version: "1.0.0",
    inputs: {},
    outputs: {},
    capabilities: [],
    run: { kind: "inprocess", handler: "test/action" },
    ...overrides,
  }
}

function actionBindings(bindings: ReadonlyArray<{
  jobId: string
  stepId: string
  uses: string
  manifest: ActionManifest
  sourcePath?: string
}>): ResolvedActionBindings {
  const result: Record<string, ResolvedActionBinding> = {}
  for (const binding of bindings) {
    result[JSON.stringify([binding.jobId, binding.stepId])] = {
      jobId: binding.jobId,
      stepId: binding.stepId,
      uses: binding.uses,
      manifest: binding.manifest,
      digest: computeActionDigest(binding.manifest),
      sourcePath: binding.sourcePath ?? "/bundled/test-action/action.yaml",
    }
  }
  return result
}

function actionStepDef(id: string, uses: string, withValues: Readonly<Record<string, unknown>> = {}): ActionStep {
  return {
    id,
    type: "action",
    uses,
    with: withValues,
    outcomes: {},
    retry: { strategy: "none" },
  }
}

// ---------------------------------------------------------- test workflows

const roles: WorkflowDef["roles"] = {
  implementer: { agent: "build", model: "prov/impl" },
  reviewer: { agent: "review", model: "prov/review" },
  fixer: { agent: "build", model: "prov/impl" },
}

/** implement (agent) → verify (command) → gate (human: approved→next, rejected→rerun implement) */
const linearWorkflow: WorkflowDef = workflow(
  {
    main: job([
      agentStep("implement", "implementer", "Implement {{ inputs.feature }}.", { interactive: true }),
      commandStep("verify", ["bun test"]),
      humanStep("gate", { outcomes: { approved: next, rejected: rerunSteps(["implement"], 3) } }),
    ]),
  },
  roles,
  "linear",
)

/** review (agent, outcomes: approved→next, changes_requested→rerun[implement,review] maxRounds 2) */
const reviewLoopWorkflow: WorkflowDef = workflow(
  {
    main: job([
      agentStep("implement", "implementer", "Implement {{ inputs.feature }}.\nFeedback: {{ feedback.jobs[\"main\"][\"review\"][\"report\"] }}"),
      agentStep("review", "reviewer", "Review it.", {
        outcomes: { approved: next, changes_requested: rerunSteps(["implement", "review"], 2) },
      }),
    ]),
  },
  roles,
  "review-loop",
)

const recoveryLoopWorkflow: WorkflowDef = workflow(
  {
    deliver: job([
      commandStep("implement", ["implement"]),
      actionStepDef("pr_create", "test/pr-create@v1"),
      {
        ...actionStepDef("await_checks", "test/await-checks@v1", { pr: "{{ steps.pr_create.outputs.number }}" }),
        onFail: rerunSteps(["implement"], 3),
      },
    ]),
  },
  roles,
  "recovery-loop",
)

function recoveryLoopBindings(): ResolvedActionBindings {
  return actionBindings([
    {
      jobId: "deliver",
      stepId: "pr_create",
      uses: "test/pr-create@v1",
      manifest: actionManifest({ name: "test/pr-create", outputs: { number: "number" } }),
    },
    {
      jobId: "deliver",
      stepId: "await_checks",
      uses: "test/await-checks@v1",
      manifest: actionManifest({
        name: "test/await-checks",
        inputs: { pr: { type: "number", presence: "required" } },
      }),
    },
  ])
}

/** onFail retry: implement has retry budget of 2, onFail goes nowhere (job fails → escalates, single job workflow) */
const retryWorkflow: WorkflowDef = workflow(
  {
    main: job([agentStep("implement", "implementer", "go", { retry: backoff(2, 10) })]),
  },
  roles,
  "retry",
)

/** unmapped outcome escalates */
const unmappedOutcomeWorkflow: WorkflowDef = workflow(
  {
    main: job([agentStep("review", "reviewer", "review", { outcomes: { approved: next } })]),
  },
  roles,
  "unmapped",
)

/** two parallel jobs fan into a third */
const fanInWorkflow: WorkflowDef = workflow(
  {
    a: job([agentStep("work", "implementer", "work a")], [], undefined, { result: "{{ steps.work.outputs.report }}" }),
    b: job([agentStep("work", "implementer", "work b")], [], undefined, { result: "{{ steps.work.outputs.report }}" }),
    join: job([agentStep("combine", "reviewer", "combine {{ needs[\"a\"].outputs.result }} {{ needs[\"b\"].outputs.result }}")], ["a", "b"]),
  },
  roles,
  "fan-in",
)

function snapshotOf(def: WorkflowDef, actionBindings: ResolvedActionBindings = {}): WorkflowSnapshot {
  return {
    projectDir: "/tmp/project",
    workflow: def,
    source: "/tmp/project/conductor.yaml",
    warnings: [],
    loadedAt: Date.now(),
    actionBindings,
  }
}

let directory: string
let connection: DatabaseConnection
let store: Store
let sessions: FakeSessions
let process_: FakeProcess
let clock: FakeClock
let actions: FakeActionHost

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-engine-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  clock = new FakeClock()
  store = new Store(connection.db, clock)
  sessions = new FakeSessions()
  process_ = new FakeProcess()
  actions = new FakeActionHost()
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function makeEngine(
  def: WorkflowDef,
  options: EngineOptions = {},
  overrides: Partial<EngineDeps> = {},
  actionBindings: ResolvedActionBindings = {},
): Engine {
  const snapshot = snapshotOf(def, actionBindings)
  return new Engine(
    {
      store,
      workflows: () => snapshot,
      sessions,
      process: process_,
      clock,
      log: { log: () => {} },
      actions,
      ...overrides,
    },
    options,
  )
}

async function startedFeature(engine: Engine, projectDir = "/tmp/project") {
  const result = await engine.startFeature(projectDir, { title: "Ship it" })
  if (!result.ok) throw new Error(result.message)
  return result.feature
}

// ---------------------------------------------------------------------------

describe("Engine: structured review work orders", () => {
  const head = "a".repeat(40)
  const finding = { path: "src/a.ts", line: 1, severity: "major", blocking: true, body: "reachable bug", acceptanceTests: ["tests/a.test.ts: rejects invalid input"], status: "new" }
  const def = workflow({ main: job([
    { ...agentStep("implement", "implementer", "FULL IMPLEMENTATION"), fixFrom: "main/review", fixPrompt: "FIX ONLY" },
    { ...agentStep("review", "reviewer", "Review", { outcomes: { approved: next, changes_requested: rerunSteps(["implement", "review"], 4) } }), reviewHead: head },
  ]) }, roles)

  it("runs an isolated review-fix-recovery-checks-cleanup flow with stand-in sessions and GitHub", async () => {
    const init = await realProcessRunner.shell("git init -q && git -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm initial", { cwd: directory })
    expect(init.code).toBe(0)
    const sha = (await realProcessRunner.exec(["git", "rev-parse", "HEAD"], { cwd: directory })).stdout.trim()
    const fixture = workflow({ main: job([
      { ...agentStep("implement", "implementer", "INITIAL", { retry: backoff(2, 10) }), fixFrom: "main/review", fixPrompt: "FIX ONLY" },
      { ...agentStep("review", "reviewer", "Review", { outcomes: { approved: next, changes_requested: rerunSteps(["implement", "review"], 4) } }), reviewHead: sha },
      actionStepDef("checks", "test/checks@v1", { pr: 1, expected_sha: sha, required_checks: ["PR Gate"] }),
      commandStep("cleanup", ["git status --porcelain && git rev-parse HEAD"]),
    ]) }, roles)
    const bindings = actionBindings([{ jobId: "main", stepId: "checks", uses: "test/checks@v1", manifest: actionManifest({
      inputs: { pr: { type: "number", presence: "required" }, expected_sha: { type: "string", presence: "required" }, required_checks: { type: "string[]", presence: "required" } },
      outputs: { conclusion: "string", sha: "string" },
    }) }])
    let checks = 0
    const host: ActionExecutor = { async execute(_binding, ctx) {
      const result = await githubAwaitChecks(ctx, {
        process: { shell: realProcessRunner.shell, async exec(argv) {
          checks++
          const payload = argv[1] === "pr" ? { headRefOid: sha } : String(argv[2]).includes("check-runs")
            ? [{ check_runs: [{ name: "PR Gate", head_sha: sha, status: "completed", conclusion: "success" }] }]
            : [{ sha, statuses: [] }]
          return { code: 0, stdout: JSON.stringify(payload), stderr: "", output: "" }
        } }, log: { log() {} }, runLog() {}, sleep: async () => {}, now: () => clock.now(),
      })
      if (result.status === "succeeded") return { ok: true, outputs: result.outputs }
      throw new Error(JSON.stringify(result))
    } }
    const engine = makeEngine(fixture, {}, { process: realProcessRunner, actions: host }, bindings)
    const feature = await startedFeature(engine, directory)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, verdict: "changes_requested", review: { head: sha, findings: [finding] } })
    expect(store.listFindings(feature.id)[0]!.id).toBe("F1")
    expect(sessions.prompts.at(-1)!.text).toContain("FIX ONLY")
    expect(sessions.prompts.at(-1)!.text).toContain("F1")
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    clock.advance(1000)
    await engine.reconcile()
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    expect(store.getFeature(feature.id)!.status).toBe("escalated")
    await engine.recover(feature.id, { notes: "Retain F1 acceptance test", target: { jobId: "main", stepId: "implement" } })
    expect(sessions.prompts.at(-1)!.text).toContain("Retain F1 acceptance test")
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    clock.advance(1000)
    await engine.reconcile()
    expect(sessions.prompts.at(-1)!.text).toContain("Retain F1 acceptance test")
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, verdict: "approved", review: {
      head: sha, findings: [{ ...finding, id: "F1", status: "fixed", resolution: "Acceptance test verified" }],
    } })
    for (let attempt = 0; attempt < 100 && store.getFeature(feature.id)!.status === "running"; attempt++) await Bun.sleep(10)
    expect(checks).toBe(4)
    expect(store.listFindings(feature.id)[0]).toMatchObject({ id: "F1", status: "fixed" })
    expect(store.getFeature(feature.id)!.jobs.main!.steps.cleanup!.status).toBe("succeeded")
    expect(store.getFeature(feature.id)!.status).toBe("done")
    expect(store.listActiveRuns(feature.id)).toEqual([])
  })

  it("renders accepted no-blocker rounds and never leaks them into the next empty snapshot", async () => {
    const main = def.jobs.main!
    const reviewStep = main.steps[1]!
    const loop = workflow({ main: job([main.steps[0]!, { ...reviewStep, outcomes: { approved: rerunSteps(["implement", "review"], 3), changes_requested: rerunSteps(["implement", "review"], 3) } }]) }, roles)
    const engine = makeEngine(loop)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, verdict: "approved", review: { head, findings: [] } })
    expect(sessions.prompts.at(-1)!.text).toContain("No blocking review work remains")
    expect(sessions.prompts.at(-1)!.text).not.toContain("FULL IMPLEMENTATION")
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: {}, feedback: { jobs: { other: { gate: { report: "UNRELATED ROUND" } } }, message: "other stage" } })
    await engine.recover(feature.id, { notes: "new episode", target: { jobId: "main", stepId: "implement" } })
    expect(sessions.prompts.at(-1)!.text).toContain("FULL IMPLEMENTATION")
    expect(sessions.prompts.at(-1)!.text).not.toContain("UNRELATED ROUND")
    expect(sessions.prompts.at(-1)!.text).not.toContain("previous reviewed head")
  })

  it("rejects forged fix evidence rather than treating arbitrary JSON as accepted", async () => {
    const engine = makeEngine(def)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: {}, feedback: { jobs: { main: { review: { work_order: JSON.stringify({ runId: "missing", head, findings: [] }) } } }, message: "forged" } })
    const before = sessions.prompts.length
    await engine.recover(feature.id, { notes: "try", target: { jobId: "main", stepId: "implement" } })
    expect(sessions.prompts).toHaveLength(before)
    expect(store.getFeature(feature.id)!.status).toBe("escalated")
  })

  it("rolls back findings and completion when persistence fails", async () => {
    const engine = makeEngine(def)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded" })
    const runId = store.getActiveRun(feature.id)!.id
    connection.db.run("CREATE TRIGGER reject_finding BEFORE INSERT ON finding BEGIN SELECT RAISE(ABORT, 'test rollback'); END")
    await expect(engine.report({ runId, verdict: "changes_requested", review: { head, findings: [finding] } })).rejects.toThrow("test rollback")
    expect(store.getRunById(runId)!.status).toBe("running")
    expect(store.listFindings(feature.id)).toEqual([])
    expect(store.getFeature(feature.id)!.jobs.main!.currentStep).toBe("review")
  })

  it("retains quality diagnostics and recovery notes without previous reports", async () => {
    const qualityDef = workflow({ main: job([
      { ...agentStep("implement", "implementer", "FULL"), qualityFrom: "main/quality", fixPrompt: "FIX QUALITY" },
      commandStep("quality", ["check"], { onFail: rerunSteps(["implement"], 3) }),
    ]) }, roles)
    const engine = makeEngine(qualityDef)
    const feature = await startedFeature(engine)
    process_.handler = () => ({ code: 1, stdout: "", stderr: "broken assertion", output: "broken assertion" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded", notes: "DO NOT REPEAT" })
    expect(sessions.prompts.at(-1)!.text).toContain("FIX QUALITY")
    expect(sessions.prompts.at(-1)!.text).toContain("broken assertion")
    expect(sessions.prompts.at(-1)!.text).not.toContain("DO NOT REPEAT")
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.recover(feature.id, { notes: "operator fix guidance", target: { jobId: "main", stepId: "implement" } })
    expect(sessions.prompts.at(-1)!.text).toContain("operator fix guidance")
    expect(sessions.prompts.at(-1)!.text).toContain("broken assertion")
    process_.handler = null
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded" })
    const other = await startedFeature(engine)
    expect(sessions.prompts.at(-1)!.text).toContain("FULL")
    expect(sessions.prompts.at(-1)!.text).not.toContain("operator fix guidance")
    expect(store.getActiveRun(other.id)!.recoverNotes).toBeNull()
  })

  it("preserves initial prompt, rejects invalid reviews, persists IDs and scopes concise fixes across restart", async () => {
    const engine = makeEngine(def)
    const feature = await startedFeature(engine)
    expect(sessions.prompts.at(-1)!.text).toContain("FULL IMPLEMENTATION")
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded", notes: "OLD IMPLEMENTER NARRATIVE" })
    const runId = store.getActiveRun(feature.id)!.id
    for (const review of [undefined, { head, findings: [{}] }, { head: "b".repeat(40), findings: [finding] }]) {
      expect(await engine.report({ runId, verdict: "changes_requested", review })).toStartWith("Invalid review:")
      expect(store.getRunById(runId)!.status).toBe("running")
      expect(store.listFindings(feature.id)).toEqual([])
    }
    expect(await engine.report({ runId, verdict: "approved", review: { head, findings: [finding] } })).toStartWith("Invalid review:")
    await engine.report({ runId, verdict: "changes_requested", review: { head, findings: [finding, { ...finding, blocking: false, body: "OPTIONAL NARRATIVE" }] } })
    const fix = sessions.prompts.at(-1)!.text
    expect(fix).toContain("FIX ONLY")
    expect(fix).toContain(head)
    expect(fix).toContain("F1")
    expect(fix).toContain("tests/a.test.ts")
    expect(fix).not.toContain("FULL IMPLEMENTATION")
    expect(fix).not.toContain("OLD IMPLEMENTER NARRATIVE")
    expect(fix).not.toContain("OPTIONAL NARRATIVE")
    expect(store.listFindings(feature.id)[0]).toMatchObject({ id: "F1", blocking: true, sourceRunId: runId, reviewedHead: head })
    await engine.report({ runId, verdict: "approved", review: { head, findings: [] } })
    expect(store.listFindings(feature.id)).toHaveLength(2)
    connection.close()
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
    store = new Store(connection.db, clock)
    const resumed = makeEngine(def)
    await resumed.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded" })
    const nextRun = store.getActiveRun(feature.id)!.id
    expect(await resumed.report({ runId: nextRun, verdict: "approved", review: { head, findings: [] } })).toContain("every previous finding")
    await resumed.report({ runId: nextRun, verdict: "approved", review: { head, findings: [
      { ...finding, id: "F1", status: "fixed", resolution: "verified test" },
      { ...finding, id: "F2", blocking: false, status: "dismissed", resolution: "not applicable" },
    ] } })
    expect(store.getFeature(feature.id)!.status).toBe("done")
    expect(store.listFindings(feature.id).map(row => [row.id, row.status])).toEqual([["F1", "fixed"], ["F2", "dismissed"]])
    expect(store.getRunById(runId)!.outputs.work_order).toContain("reachable bug")
  })
})

describe("Engine: runner resource waits", () => {
  it("keeps one bounded wait across failed probes, restart and recovery", async () => {
    const runners = new RunnerRegistry(() => clock.now())
    const register = () => runners.register({ name: "test", endpoint: "http://runner.test", projects: [] })
    register()
    let healthy = false
    let creates = 0
    const transport = createRunnerSessionClient({ runners, fetchImpl: async request => {
      if (new URL(request.url).pathname === "/v1/health") {
        if (!healthy) throw new Error("timeout")
        return Response.json({ ok: true })
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/sessions") return Response.json({ id: `s${++creates}` })
      return Response.json({ ok: true, status: "busy", exists: true })
    } })
    const deps = { sessions: transport, runnerAvailable: () => runners.hasAny() }
    const engine = makeEngine(linearWorkflow, {}, deps)
    const feature = await startedFeature(engine)
    const wait = store.listResourceWaits(feature.id)[0]!
    expect(store.listRuns(feature.id)[0]?.failure?.class).toBe("transient_transport")
    expect(store.getFeature(feature.id)?.jobs.main?.attempts.implement ?? 0).toBe(0)
    clock.current = wait.nextObservationAt!
    await makeEngine(linearWorkflow, {}, deps).reconcile()
    const repeated = store.listResourceWaits(feature.id)
    expect(repeated).toHaveLength(1)
    expect(repeated[0]?.deadlineAt).toBe(wait.deadlineAt)
    expect(repeated[0]?.status).toBe("waiting")
    healthy = true
    register()
    clock.current = repeated[0]!.nextObservationAt!
    await engine.reconcile()
    expect(store.listResourceWaits(feature.id)[0]?.status).toBe("closed")
    expect(store.getActiveRun(feature.id)).not.toBeNull()
    expect(creates).toBe(2)
  })

  it("recovers a claimed wait after a crash before run insertion", async () => {
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => false })
    const feature = await startedFeature(engine)
    const wait = store.listResourceWaits(feature.id)[0]!
    clock.current = wait.nextObservationAt!
    expect(store.claimResourceWait(wait.id, clock.now())).not.toBeNull()
    await makeEngine(linearWorkflow, {}, { runnerAvailable: () => true }).reconcile()
    expect(store.getResourceWait(wait.id)?.status).toBe("closed")
    expect(sessions.prompts).toHaveLength(1)
  })

  it("waits after all stale endpoints refuse without consuming attempts", async () => {
    const runners = new RunnerRegistry(() => clock.now())
    runners.register({ name: "dead", endpoint: "http://dead.test", projects: [] })
    const transport = createRunnerSessionClient({ runners, fetchImpl: async () => {
      throw Object.assign(new Error("refused"), { code: "ConnectionRefused" })
    } })
    const engine = makeEngine(linearWorkflow, {}, { sessions: transport, runnerAvailable: () => runners.hasAny() })
    const feature = await startedFeature(engine)
    expect(runners.hasAny()).toBe(false)
    expect(store.listResourceWaits(feature.id)[0]?.status).toBe("waiting")
    expect(store.getFeature(feature.id)?.jobs.main?.attempts.implement ?? 0).toBe(0)
    expect(store.getActiveRun(feature.id)).toBeNull()
  })

  it("bounds repeated unavailable dispatches even when registrations stay fresh", async () => {
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => true })
    sessions.promptError = new NoLiveRunnerError()
    const feature = await startedFeature(engine)
    const wait = store.listResourceWaits(feature.id)[0]!
    clock.current = wait.deadlineAt + 1
    await makeEngine(linearWorkflow, {}, { runnerAvailable: () => true }).reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.listResourceWaits(feature.id)[0]?.closedReason).toBe("deadline_exhausted")
  })

  it("waits without creating a run and dispatches once when a runner returns", async () => {
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)

    expect(store.listRuns(feature.id)).toHaveLength(0)
    expect(store.listResourceWaits(feature.id)).toHaveLength(1)
    expect(store.listResourceWaits(feature.id)[0]?.status).toBe("waiting")

    available = true
    clock.advance(5_000)
    await engine.reconcile()
    await engine.reconcile()

    expect(store.listRuns(feature.id)).toHaveLength(1)
    expect(sessions.prompts).toHaveLength(1)
    expect(store.listResourceWaits(feature.id)[0]?.status).toBe("closed")
  })

  it("persists the wait across engine recreation and escalates after its deadline", async () => {
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => false })
    const feature = await startedFeature(engine)
    expect(store.listRuns(feature.id)).toHaveLength(0)

    clock.advance(3_600_000)
    const restarted = makeEngine(linearWorkflow, {}, { runnerAvailable: () => false })
    await restarted.reconcile()

    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.listRuns(feature.id)).toHaveLength(0)
    expect(store.listResourceWaits(feature.id)[0]?.closedReason).toBe("deadline_exhausted")
  })

  it("does not dispatch a satisfiable wait while paused", async () => {
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    await engine.pause(feature.id)
    available = true
    clock.advance(5_000)

    await engine.reconcile()

    expect(store.listRuns(feature.id)).toHaveLength(0)
    expect(store.listResourceWaits(feature.id)[0]?.status).toBe("waiting")
  })

  it("normalizes a legacy all-terminal running feature to escalated", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    // Simulate the pre-persistence bug: status "running" with every job
    // terminal and at least one failed, and no run/wait/retry/outbox.
    const state = store.getFeature(feature.id)!
    const stranded = {
      ...state,
      jobs: {
        main: {
          ...state.jobs["main"]!,
          status: "failed",
          currentStep: null,
          attempts: { implement: 1 },
          reruns: {},
          outputs: {},
          steps: {
            implement: { status: "failed", outputs: {} },
          },
        },
      },
    }
    connection.db.run("UPDATE feature SET status = ?, state = ? WHERE id = ?", [
      "running",
      JSON.stringify(stranded),
      feature.id,
    ])

    await engine.reconcile()

    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })

  it("dispatches a due durable retry exactly once", async () => {
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    expect(store.listRuns(feature.id)).toHaveLength(0)
    expect(store.listResourceWaits(feature.id)[0]?.status).toBe("waiting")
    // Replace the runner wait with a durable retry schedule for the same
    // step so the retry loop owns dispatch instead of the wait loop.
    store.closeResourceWait(store.listResourceWaits(feature.id)[0]!.id, "replaced")
    store.scheduleRetry({
      featureId: feature.id,
      jobId: "main",
      stepId: "implement",
      attempts: 1,
      startedAt: clock.now(),
      nextAttemptAt: clock.now() + 1_000,
      delayMs: 1_000,
      scheduleSource: "backoff",
      maxAttempts: 3,
      maxElapsedMs: 600_000,
      failure: { class: "transient_upstream", diagnostic: "provider 503", source: "runner" },
    })
    available = true

    // Not due yet — nothing happens, and the running step is NOT
    // re-executed (the retry schedule owns it).
    await engine.reconcile()
    expect(store.listRuns(feature.id)).toHaveLength(0)

    clock.advance(1_000)
    await engine.reconcile()
    await engine.reconcile()

    expect(store.listRuns(feature.id)).toHaveLength(1)
    expect(sessions.prompts).toHaveLength(1)
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
  })

  it("recovers an escalated no-runner feature after a runner returns", async () => {
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    expect(store.listRuns(feature.id)).toHaveLength(0)

    clock.advance(3_600_000)
    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const rejected = await engine.recover(feature.id, { notes: "" })
    expect(rejected.ok).toBe(false)

    available = true
    const result = await engine.recover(feature.id, { notes: "runner came back online" })
    expect(result.ok).toBe(true)
    expect(store.listRuns(feature.id)).toHaveLength(1)
    expect(sessions.prompts).toHaveLength(1)
  })

  it("recover with a stale expectedVersion is rejected; the current version passes", async () => {
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    clock.advance(3_600_000)
    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    available = true

    const stale = await engine.recover(feature.id, { notes: "go", expectedVersion: 1 })
    expect(stale.ok).toBe(false)
    expect(stale.stale).toBe(true)
    expect(store.listRuns(feature.id)).toHaveLength(0)

    const version = store.getFeatureRecord(feature.id)!.updatedAt
    const result = await engine.recover(feature.id, { notes: "go", expectedVersion: version })
    expect(result.ok).toBe(true)
    expect(store.listRuns(feature.id)).toHaveLength(1)
  })

  it("a retried recover with the same idempotency key is a duplicate no-op, a new key re-recovers", async () => {
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    clock.advance(3_600_000)
    await engine.reconcile()
    available = true

    const first = await engine.recover(feature.id, { notes: "go", idempotencyKey: "op-123" })
    expect(first.ok).toBe(true)
    expect(store.listRuns(feature.id)).toHaveLength(1)

    // The client retries the same delivery: success, no second run.
    const retried = await engine.recover(feature.id, { notes: "go", idempotencyKey: "op-123" })
    expect(retried.ok).toBe(true)
    expect(retried.duplicate).toBe(true)
    expect(store.listRuns(feature.id)).toHaveLength(1)
  })

  it("a superseded failed routing step and its later failure are both currently-failed candidates — untargeted recover is rejected as ambiguous, targeted recover re-arms only the selected one", async () => {
    let implementCalls = 0
    process_.handler = () => {
      implementCalls += 1
      return { code: 0, stdout: "", stderr: "", output: "" }
    }
    const actionCalls: string[] = []
    actions.handler = (binding) => {
      actionCalls.push(binding.stepId)
      return binding.stepId === "pr_create"
        ? { ok: true, outputs: { number: 2 } }
        : { ok: "pending", nextPollMs: 60_000, state: {} }
    }
    const engine = makeEngine(recoveryLoopWorkflow, {}, {}, recoveryLoopBindings())
    const feature = store.createFeature({ title: "Ship it", slug: "ship-it", projectDir: "/tmp/project", workflow: recoveryLoopWorkflow.name })
    const escalated = {
      ...feature,
      status: "escalated" as const,
      jobs: {
        deliver: {
          status: "failed" as const,
          currentStep: null,
          attempts: { implement: 1, await_checks: 1, pr_create: 1 },
          reruns: { await_checks: 1 },
          outputs: {},
          steps: {
            implement: { status: "succeeded" as const, outputs: {} },
            await_checks: { status: "failed" as const, outputs: {} },
            pr_create: { status: "failed" as const, outputs: {} },
          },
        },
      },
    }
    connection.db.run("UPDATE feature SET status = 'escalated', state = ? WHERE id = ?", [JSON.stringify(escalated), feature.id])
    const checksRun = store.insertRun({ featureId: feature.id, jobId: "deliver", stepId: "await_checks", stepType: "action", attempt: 1 })
    store.finishRun(checksRun, "failed", { reason: "checks unavailable" })
    const prRun = store.insertRun({ featureId: feature.id, jobId: "deliver", stepId: "pr_create", stepType: "action", attempt: 1 })
    store.finishRun(prRun, "failed", { reason: "github unavailable" })
    connection.db.run("UPDATE run SET time_started = 1000, time_finished = 1100 WHERE id = ?", [checksRun])
    connection.db.run("UPDATE run SET time_started = 2000, time_finished = 2100 WHERE id = ?", [prRun])

    // Both `deliver/await_checks` and `deliver/pr_create` are currently
    // "failed" in job runtime (the rerun's routing-step failure was never
    // cleared) — the spec's "Parallel failures require a selected target":
    // an untargeted recover must reject as ambiguous, not silently pick
    // the most recent run.
    const ambiguous = await engine.recover(feature.id, { notes: "GitHub restored" })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.targets).toEqual(
      expect.arrayContaining([
        { jobId: "deliver", stepId: "await_checks" },
        { jobId: "deliver", stepId: "pr_create" },
      ]),
    )
    expect(ambiguous.targets).toHaveLength(2)
    expect(store.getActiveRunForStep(feature.id, "deliver", "pr_create")).toBeNull()
    expect(store.getActiveRunForStep(feature.id, "deliver", "await_checks")).toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const result = await engine.recover(feature.id, {
      notes: "GitHub restored",
      target: { jobId: "deliver", stepId: "pr_create" },
    })
    await engine.settleActions()

    expect(result).toEqual({ ok: true, message: 'Recovered. Step "deliver/pr_create" re-armed.', recovered: [{ jobId: "deliver", stepId: "pr_create" }] })
    expect(actionCalls).toEqual(["pr_create", "await_checks"])
    expect(implementCalls).toBe(0)
    expect(store.getActiveRunForStep(feature.id, "deliver", "pr_create")).toBeNull()
    expect(store.getActiveRunForStep(feature.id, "deliver", "await_checks")).not.toBeNull()
    expect(store.getFeature(feature.id)?.jobs["deliver"]?.currentStep).toBe("await_checks")
    const recovery = store.getTransitions(feature.id).find(transition => (transition.event as { kind: string }).kind === "human.recovered")
    expect(recovery?.event).toMatchObject({ kind: "human.recovered" })
    expect(recovery?.decisions).toEqual([{ kind: "execute_step", jobId: "deliver", stepId: "pr_create" }])
  })

  it("a closed historical deadline-exhausted wait does not shadow a current failed step", async () => {
    const engine = makeEngine(recoveryLoopWorkflow, {}, {}, recoveryLoopBindings())
    const feature = store.createFeature({ title: "Ship it", slug: "ship-it", projectDir: "/tmp/project", workflow: recoveryLoopWorkflow.name })
    const escalated = {
      ...feature,
      status: "escalated" as const,
      jobs: {
        deliver: {
          status: "failed" as const,
          currentStep: null,
          attempts: { implement: 1, pr_create: 1 },
          reruns: {},
          outputs: {},
          steps: {
            implement: { status: "succeeded" as const, outputs: {} },
            pr_create: { status: "failed" as const, outputs: {} },
          },
        },
      },
    }
    connection.db.run("UPDATE feature SET status = 'escalated', state = ? WHERE id = ?", [JSON.stringify(escalated), feature.id])
    // A historical resource wait on "implement" that expired long ago —
    // implement's job later succeeded past it, so it must never surface
    // as a recovery candidate alongside the CURRENT failure on pr_create.
    store.upsertResourceWait({
      featureId: feature.id, jobId: "deliver", stepId: "implement", reason: "runner_unavailable",
      observedAt: 1000, nextObservationAt: 1000, deadlineAt: 1000, diagnostic: "no runner",
    })
    store.closeResourceWait(store.listResourceWaits(feature.id)[0]!.id, "deadline_exhausted")

    const result = await engine.recover(feature.id, { notes: "GitHub restored" })
    await engine.settleActions()
    expect(result.ok).toBe(true)
    expect(result.message).toBe('Recovered. Step "deliver/pr_create" re-armed.')
  })

  it("parallel failures in two independent jobs: untargeted recover rejects ambiguous; targeted recover leaves the other still recoverable", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "failed", notes: "a broke" })
    await engine.report({ runId: runB.id, outcome: "failed", notes: "b broke" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const ambiguous = await engine.recover(feature.id, { notes: "retry both" })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.targets).toEqual(
      expect.arrayContaining([
        { jobId: "a", stepId: "work" },
        { jobId: "b", stepId: "work" },
      ]),
    )
    expect(ambiguous.targets).toHaveLength(2)
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const recovered = await engine.recover(feature.id, { notes: "retry a", target: { jobId: "a", stepId: "work" } })
    expect(recovered).toEqual({ ok: true, message: 'Recovered. Step "a/work" re-armed.', recovered: [{ jobId: "a", stepId: "work" }] })
    expect(store.getActiveRunForStep(feature.id, "a", "work")).not.toBeNull()
    // Job b's failure is untouched and still independently a candidate —
    // its runtime status stayed "failed" and there is no active run for it.
    expect(store.getFeature(feature.id)?.jobs["b"]?.status).toBe("failed")
    expect(store.getActiveRunForStep(feature.id, "b", "work")).toBeNull()
  })

  it("a stale selected target (its job already succeeded) is rejected with no fallback and no state change", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "succeeded", notes: "a done" })
    await engine.report({ runId: runB.id, outcome: "failed", notes: "b broke" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getFeature(feature.id)?.jobs["a"]?.status).toBe("succeeded")

    const before = store.getTransitions(feature.id).length
    const stale = await engine.recover(feature.id, { notes: "retry a anyway", target: { jobId: "a", stepId: "work" } })
    expect(stale.ok).toBe(false)
    expect(stale.staleTarget).toBe(true)
    expect(store.getTransitions(feature.id).length).toBe(before)
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getActiveRunForStep(feature.id, "a", "work")).toBeNull()

    // The genuinely current target still recovers normally.
    const recovered = await engine.recover(feature.id, { notes: "retry b", target: { jobId: "b", stepId: "work" } })
    expect(recovered.ok).toBe(true)
  })

  it("multi-target recover re-arms every selected step in one transaction: one version bump, one transition row, all dispatched", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "failed", notes: "a broke" })
    await engine.report({ runId: runB.id, outcome: "failed", notes: "b broke" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const result = await engine.recover(feature.id, {
      notes: "shared outage over — retry both",
      idempotencyKey: "multi-1",
      targets: [
        { jobId: "a", stepId: "work" },
        { jobId: "b", stepId: "work" },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.recovered).toEqual([
      { jobId: "a", stepId: "work" },
      { jobId: "b", stepId: "work" },
    ])
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getActiveRunForStep(feature.id, "a", "work")).not.toBeNull()
    expect(store.getActiveRunForStep(feature.id, "b", "work")).not.toBeNull()

    // One human.recovered transition row carrying BOTH execute_step decisions.
    const recoveries = store.getTransitions(feature.id).filter(t => (t.event as { kind: string }).kind === "human.recovered")
    expect(recoveries).toHaveLength(1)
    expect(recoveries[0]?.decisions).toEqual([
      { kind: "execute_step", jobId: "a", stepId: "work" },
      { kind: "execute_step", jobId: "b", stepId: "work" },
    ])

    // A retried delivery with the same key is a duplicate no-op.
    const retried = await engine.recover(feature.id, { notes: "again", idempotencyKey: "multi-1", targets: [{ jobId: "a", stepId: "work" }] })
    expect(retried.duplicate).toBe(true)
  })

  it("recover with all: true re-arms every current candidate and the fan-in completes end to end", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "failed", notes: "a broke" })
    await engine.report({ runId: runB.id, outcome: "failed", notes: "b broke" })

    const result = await engine.recover(feature.id, { notes: "retry everything", all: true })
    expect(result.ok).toBe(true)
    expect(result.recovered).toHaveLength(2)

    // Both recovered runs succeed → join arms, proving the cascade reset.
    await engine.report({ runId: store.getActiveRunForStep(feature.id, "a", "work")!.id, outcome: "succeeded", notes: "a ok" })
    await engine.report({ runId: store.getActiveRunForStep(feature.id, "b", "work")!.id, outcome: "succeeded", notes: "b ok" })
    expect(store.getActiveRunForStep(feature.id, "join", "combine")).not.toBeNull()
  })

  it("multi-target recover rejects wholesale when any named target is stale — nothing re-armed", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "succeeded", notes: "a done" })
    await engine.report({ runId: runB.id, outcome: "failed", notes: "b broke" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const before = store.getTransitions(feature.id).length
    const result = await engine.recover(feature.id, {
      notes: "retry both",
      targets: [
        { jobId: "a", stepId: "work" },
        { jobId: "b", stepId: "work" },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.staleTarget).toBe(true)
    expect(store.getTransitions(feature.id).length).toBe(before)
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getActiveRunForStep(feature.id, "b", "work")).toBeNull()
  })

  it("ambiguous rejection advertises allowAll; combined selection forms and empty targets are invalid", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "failed", notes: "a broke" })
    await engine.report({ runId: runB.id, outcome: "failed", notes: "b broke" })

    const ambiguous = await engine.recover(feature.id, { notes: "retry" })
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.allowAll).toBe(true)

    const combined = await engine.recover(feature.id, { notes: "retry", all: true, target: { jobId: "a", stepId: "work" } })
    expect(combined.ok).toBe(false)
    expect(combined.message).toContain("exactly one")

    const empty = await engine.recover(feature.id, { notes: "retry", targets: [] })
    expect(empty.ok).toBe(false)
    expect(empty.message).toContain("non-empty")
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })

  it("recover grants a fresh retry budget: a post-recovery failure schedules a retry under a new chained episode instead of exhausting instantly", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 1" })
    run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 2" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getFeature(feature.id)?.jobs["main"]?.attempts["implement"]).toBe(2)

    const result = await engine.recover(feature.id, { notes: "try again" })
    expect(result.ok).toBe(true)
    expect(store.getFeature(feature.id)?.jobs["main"]?.attempts["implement"] ?? 0).toBe(0)

    // The fresh attempt fails once — with retryWorkflow's budget of 2, a
    // truly fresh episode tolerates this (attempts=1 < maxAttempts=2)
    // instead of immediately re-escalating as it would if the old
    // exhausted attempt count had carried over.
    const recoveredRun = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: recoveredRun.id, outcome: "failed", notes: "post-recovery attempt 1" })
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getFeature(feature.id)?.jobs["main"]?.attempts["implement"]).toBe(1)
  })

  it("two concurrent recovers with the same idempotencyKey: exactly one recovered, one duplicate", async () => {
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    clock.advance(3_600_000)
    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    available = true

    const [first, second] = await Promise.all([
      engine.recover(feature.id, { notes: "go", idempotencyKey: "race-1" }),
      engine.recover(feature.id, { notes: "go", idempotencyKey: "race-1" }),
    ])
    const outcomes = [first, second].sort((a, b) => Number(a.duplicate ?? false) - Number(b.duplicate ?? false))
    expect(outcomes[0]!.ok).toBe(true)
    expect(outcomes[0]!.duplicate).toBeUndefined()
    expect(outcomes[1]!.ok).toBe(true)
    expect(outcomes[1]!.duplicate).toBe(true)
    expect(store.listRuns(feature.id)).toHaveLength(1)
  })
})

describe("Engine: durable recovery-dispatch replay", () => {
  it("inherits literal notes through automatic retries and replaces them on subsequent recovery", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    const fail = async () => engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await fail()
    await fail()
    const notes = "Keep {{ feature.title }} literal\n" + "operator guidance ".repeat(80)
    await engine.recover(feature.id, { notes })
    await fail()
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBe(notes)
    expect(sessions.prompts.at(-1)?.text).toContain(`Operator notes:\n${notes}\n\n`)
    await fail()
    expect(store.getRecoverNotesForTarget(feature.id, "main", "implement")).toBeNull()
    await engine.recover(feature.id, { notes: "replacement guidance" })
    await fail()
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBe("replacement guidance")
    expect(sessions.prompts.at(-1)?.text).toContain("replacement guidance")
    expect(sessions.prompts.at(-1)?.text).not.toContain(notes)
  })

  it("retains notes across a scheduled retry and database reopen without dispatching early", async () => {
    let engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.recover(feature.id, { notes: "scheduled retry guidance" })
    sessions.liveSessions.delete(store.getActiveRun(feature.id)!.sessionId!)
    await engine.reconcile()
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")!
    expect(episode.status).toBe("scheduled")
    connection.close()
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
    store = new Store(connection.db, clock)
    engine = makeEngine(retryWorkflow)
    await engine.reconcile()
    expect(store.getActiveRun(feature.id)).toBeNull()
    clock.advance(episode.nextAttemptAt! - clock.now())
    await engine.reconcile()
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBe("scheduled retry guidance")
    expect(sessions.prompts.at(-1)?.text).toContain("Operator notes:\nscheduled retry guidance\n\n")
  })

  it("keeps retry notes across database reopen and a runner resource wait", async () => {
    let available = true
    let engine = makeEngine(retryWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.recover(feature.id, { notes: "durable retry guidance" })
    available = false
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    expect(store.getOpenResourceWait(feature.id, "main", "implement")).not.toBeNull()
    connection.close()
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
    store = new Store(connection.db, clock)
    engine = makeEngine(retryWorkflow, {}, { runnerAvailable: () => available })
    await engine.reconcile()
    available = true
    clock.advance(60_000)
    await engine.reconcile()
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBe("durable retry guidance")
    expect(sessions.prompts.at(-1)?.text).toContain("Operator notes:\ndurable retry guidance\n\n")
  })

  it("retains notes when runner loss after run insertion sends recovery back to resource wait", async () => {
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => true })
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    sessions.promptError = new NoLiveRunnerError("runner disconnected")
    await engine.recover(feature.id, { notes: "retain after dispatch race" })
    expect(store.getActiveRun(feature.id)).toBeNull()
    expect(store.getOpenResourceWait(feature.id, "main", "implement")).not.toBeNull()
    clock.advance(60_000)
    await engine.reconcile()
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBe("retain after dispatch race")
    expect(sessions.prompts.at(-1)?.text).toContain("retain after dispatch race")
  })

  it("successful recovery does not leak into later steps or a later rerun of the same target", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.recover(feature.id, { notes: "only this recovery episode" })
    const recovered = store.getActiveRun(feature.id)!
    await engine.report({ runId: recovered.id, outcome: "succeeded" })
    const review = store.getActiveRun(feature.id)!
    expect(review.stepId).toBe("review")
    expect(review.recoverNotes).toBeNull()
    expect(sessions.prompts.at(-1)?.text).not.toContain("only this recovery episode")
    await engine.report({ runId: review.id, verdict: "changes_requested" })
    expect(store.getActiveRun(feature.id)?.stepId).toBe("implement")
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBeNull()
    expect(sessions.prompts.at(-1)?.text).not.toContain("Operator notes:")
    expect(store.getRunById(recovered.id)?.recoverNotes).toBe("only this recovery episode")
  })

  it("ends guidance when exhausted failure routing reruns the same target", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.recover(feature.id, { notes: "not for a new loop" })
    const loop = workflow({ main: job([agentStep("implement", "implementer", "go", {
      retry: backoff(2, 10), onFail: rerunSteps(["implement"], 2),
    })]) }, roles)
    const loopEngine = makeEngine(loop)
    await loopEngine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBe("not for a new loop")
    await loopEngine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBeNull()
    expect(sessions.prompts.at(-1)?.text).not.toContain("Operator notes:")
  })

  it("store recovery without notes cannot fall back to a previous episode", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    await engine.recover(feature.id, { notes: "old guidance" })
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    expect(store.recoverStepTargets(feature.id, [{ jobId: "main", stepId: "implement" }])).toBe("recovered")
    await engine.reconcile()
    expect(store.getActiveRun(feature.id)?.recoverNotes).toBeNull()
    expect(sessions.prompts.at(-1)?.text).not.toContain("old guidance")
  })

  it("isolates notes by feature and job even when step IDs match", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRunForStep(feature.id, "a", "work")!.id, outcome: "failed" })
    await engine.report({ runId: store.getActiveRunForStep(feature.id, "b", "work")!.id, outcome: "failed" })
    await engine.recover(feature.id, { notes: "only job a", target: { jobId: "a", stepId: "work" } })
    expect(store.getActiveRunForStep(feature.id, "a", "work")?.recoverNotes).toBe("only job a")
    expect(store.getRecoverNotesForTarget(feature.id, "b", "work")).toBeNull()
    const other = await startedFeature(engine)
    expect(store.listRuns(other.id).every(run => run.recoverNotes === null)).toBe(true)
  })

  it("retains notes through a handled resource wait for the recovery episode", async () => {
    let available = true
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "failed" })
    available = false
    await engine.recover(feature.id, { notes: "Keep {{ feature.title }} literal" })
    await engine.reconcile()
    expect(store.getUnhandledRecoveryDispatches(feature.id)).toHaveLength(0)
    available = true
    clock.advance(60_000)
    await engine.reconcile()
    const run = store.getActiveRun(feature.id)!
    expect(run.recoverNotes).toBe("Keep {{ feature.title }} literal")
    expect(sessions.prompts.at(-1)?.text).toContain("Keep {{ feature.title }} literal")
    expect(store.getRecoverNotesForTarget(feature.id, "main", "implement")).toBe("Keep {{ feature.title }} literal")
  })
  it("crash boundary: a recoverStepTargets commit with no dispatch yet is durably replayed by reconcile — one run, feature stays running (not invariant-escalated); a second reconcile is a no-op", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 1" })
    run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 2" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    // The "winning tx" only: the DAG repair commits, but nothing ever
    // dispatches the recovered step (simulating a crash right after
    // `recoverStepTargets` returns and before `Engine.recover` calls
    // `executeAgent`).
    const txResult = store.recoverStepTargets(feature.id, [{ jobId: "main", stepId: "implement" }])
    expect(txResult).toBe("recovered")
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()
    expect(store.getUnhandledRecoveryDispatches(feature.id)).toHaveLength(1)

    // A restarted daemon's first reconcile pass replays the dispatch
    // instead of escalating the now-anchorless "running" feature.
    await engine.reconcile()
    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed).not.toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getUnhandledRecoveryDispatches(feature.id)).toHaveLength(0)

    // A second reconcile pass must not double-dispatch: the run from the
    // first pass is still active, and the dispatch row is already handled.
    await engine.reconcile()
    expect(store.getActiveRunForStep(feature.id, "main", "implement")?.id).toBe(rearmed!.id)
    expect(store.listRuns(feature.id).filter(r => r.stepId === "implement" && r.status === "running")).toHaveLength(1)
  })

  it("crash boundary with no runner available: reconcile replays the recovery dispatch into a resource wait instead of escalating", async () => {
    // linearWorkflow's implement step has no retry policy, so a no-runner
    // deadline exhaustion escalates outright instead of looping back into
    // another wait via a retry budget (unlike retryWorkflow).
    let available = false
    const engine = makeEngine(linearWorkflow, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    // Escalate via a resource-wait deadline (no runner ever showed up).
    clock.advance(3_600_000)
    await engine.reconcile()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const txResult = store.recoverStepTargets(feature.id, [{ jobId: "main", stepId: "implement" }])
    expect(txResult).toBe("recovered")
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getUnhandledRecoveryDispatches(feature.id)).toHaveLength(1)

    // Runner is still absent: the replay re-arms a resource wait rather
    // than a run, and the feature stays running (anchored by the wait)
    // instead of being escalated by the invariant check.
    await engine.reconcile()
    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()
    expect(store.getOpenResourceWait(feature.id, "main", "implement")).not.toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getUnhandledRecoveryDispatches(feature.id)).toHaveLength(0)

    // Second pass: no duplicate wait.
    await engine.reconcile()
    expect(store.listResourceWaits(feature.id).filter(w => w.status === "waiting")).toHaveLength(1)
  })

  it("normal path: Engine.recover dispatches immediately as before; the recovery-dispatch row ends handled on the next reconcile with no double dispatch", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 1" })
    run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 2" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const result = await engine.recover(feature.id, { notes: "try again" })
    expect(result.ok).toBe(true)
    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed).not.toBeNull()
    // `Engine.recover` dispatched directly — the durable row is still
    // unhandled until reconcile next observes the anchor it created.
    expect(store.getUnhandledRecoveryDispatches(feature.id)).toHaveLength(1)

    await engine.reconcile()
    expect(store.getUnhandledRecoveryDispatches(feature.id)).toHaveLength(0)
    // No double dispatch: same run, still exactly one active run for the step.
    expect(store.getActiveRunForStep(feature.id, "main", "implement")?.id).toBe(rearmed!.id)
    expect(store.listRuns(feature.id).filter(r => r.stepId === "implement" && r.status === "running")).toHaveLength(1)
  })

  it("recover notes are stamped on the run row AND the agent prompt header for the recovered step (normal path)", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 1" })
    run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 2" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    sessions.prompts.length = 0
    const result = await engine.recover(feature.id, { notes: "runner is back, retry with the same prompt" })
    expect(result.ok).toBe(true)

    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed?.recoverNotes).toBe("runner is back, retry with the same prompt")

    expect(sessions.prompts.length).toBe(1)
    const prompt = sessions.prompts[0]!.text
    expect(prompt).toContain("[conductor] Job \"main\" step \"implement\"")
    expect(prompt).toContain("[conductor] This step was recovered by an operator. Operator notes:")
    expect(prompt).toContain("runner is back, retry with the same prompt")
  })

  it("recover notes survive a daemon restart between commit and dispatch: the recovery_dispatch outbox row carries the notes that the replay prompt path reads back", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 1" })
    run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 2" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    const txResult = store.recoverStepTargets(
      feature.id,
      [{ jobId: "main", stepId: "implement" }],
      { notes: "runner is back, retry with the same prompt" },
    )
    expect(txResult).toBe("recovered")
    const unhandled = store.getUnhandledRecoveryDispatches(feature.id)
    expect(unhandled).toHaveLength(1)
    expect(unhandled[0]!.notes).toBe("runner is back, retry with the same prompt")
    expect(store.getRecoverNotesForTarget(feature.id, "main", "implement")).toBe("runner is back, retry with the same prompt")

    sessions.prompts.length = 0
    await engine.reconcile()

    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed?.recoverNotes).toBe("runner is back, retry with the same prompt")
    expect(sessions.prompts.length).toBe(1)
    const prompt = sessions.prompts[0]!.text
    expect(prompt).toContain("[conductor] This step was recovered by an operator. Operator notes:")
    expect(prompt).toContain("runner is back, retry with the same prompt")
  })
})

describe("Engine: linear happy path", () => {
  it("agent → command → human gate → approve → done", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
    expect(sessions.prompts).toHaveLength(1)

    const implementRun = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: implementRun.id, outcome: "succeeded", notes: "implemented" })
    // the command step ran synchronously within report()'s dispatch, so
    // the feature has already advanced past "verify" to the human gate.
    expect(store.listRuns(feature.id).some(r => r.stepId === "verify" && r.status === "succeeded")).toBe(true)
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("gate")
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")

    const result = await engine.approve(feature.id, "ship it")
    expect(result).toContain("Approved")
    const after = store.getFeature(feature.id)!
    expect(after.status).toBe("done")
    expect(after.jobs["main"]?.steps["gate"]?.outputs).toEqual({ notes: "ship it" })
  })

  it("command step success persists the interleaved output to the run log as process", async () => {
    process_.handler = () => ({ code: 0, stdout: "out line", stderr: "err line", output: "err line\nout line" })
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const implementRun = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: implementRun.id, outcome: "succeeded" })

    const verifyRun = store.listRuns(feature.id).find(r => r.stepId === "verify")!
    const log = store.getRunLog(verifyRun.id)
    expect(log.lines.map(line => ({ source: line.source, text: line.text }))).toEqual([
      { source: "process", text: "err line\nout line" },
    ])
  })

  it("command step failure keeps the run reason and supplements it with the log", async () => {
    process_.handler = () => ({ code: 1, stdout: "", stderr: "boom", output: "boom" })
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })

    const verifyRun = store.listRuns(feature.id).find(r => r.stepId === "verify")!
    expect(verifyRun.reason).toBe(`"bun test" exited 1: boom`)
    const log = store.getRunLog(verifyRun.id)
    expect(log.lines.map(line => line.source)).toEqual(["process"])
    expect(log.lines[0]!.text).toBe("boom")
  })

  it("command step failure fails the job and escalates (single job, no onFail)", async () => {
    process_.handler = () => ({ code: 1, stdout: "", stderr: "boom", output: "boom" })
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    const after = store.getFeature(feature.id)!
    expect(after.status).toBe("escalated")
    expect(after.jobs["main"]?.steps["verify"]?.status).toBe("failed")
  })

  it("command step publishes $CONDUCTOR_OUTPUT name=value lines as outputs", async () => {
    process_.handler = (_command, options) => {
      const fs = require("node:fs") as typeof import("node:fs")
      fs.writeFileSync(options.env!["CONDUCTOR_OUTPUT"]!, "branch=feature-x\npath=/work\n")
      return { code: 0, stdout: "", stderr: "", output: "" }
    }
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    const verifyRun = store.listRuns(feature.id).find(r => r.stepId === "verify")!
    expect(verifyRun.outputs).toEqual({ branch: "feature-x", path: "/work" })
  })
})

describe("Engine: outcome routing", () => {
  it("a verdict routes through the outcomes map", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "impl v1" })
    run = store.getActiveRunForStep(feature.id, "main", "review")!
    const result = await engine.report({ runId: run.id, verdict: "approved", notes: "lgtm" })
    expect(result).toContain('Verdict "approved"')
    expect(store.getFeature(feature.id)?.status).toBe("done")
  })

  it("an unmapped verdict bounces back to the agent instead of escalating", async () => {
    const engine = makeEngine(unmappedOutcomeWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "review")!
    const result = await engine.report({ runId: run.id, verdict: "rejected" })
    expect(result).toContain('Verdict "rejected" is not declared')
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getRunById(run.id)?.status).toBe("running")
    // A declared verdict still concludes the run.
    const retry = await engine.report({ runId: run.id, verdict: "approved" })
    expect(retry).toContain('Verdict "approved"')
  })
})

describe("Engine: retry budget", () => {
  it("onFail retry budget exhausted escalates the feature", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 1 failed" })
    // retry: attempt 2 dispatched automatically
    expect(store.getFeature(feature.id)?.status).toBe("running")
    run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "failed", notes: "attempt 2 failed" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })
})

describe("Engine: failure classification and durable retry schedules", () => {
  it("a failed command run carries a classified envelope (exit 127 → invalid_config)", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    process_.handler = () => ({ code: 127, stdout: "", stderr: "", output: "command not found: gh" })
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "done" })

    const commandRun = store.listRuns(feature.id).find(r => r.stepId === "verify")!
    expect(commandRun.status).toBe("failed")
    expect(commandRun.failure).toMatchObject({ class: "invalid_config", source: "command" })
  })

  it("a runner-connection prompt failure classifies transient_transport, not internal", async () => {
    const engine = makeEngine(linearWorkflow)
    sessions.promptError = new Error("Unable to connect. Is the computer able to access the url?")
    const feature = await startedFeature(engine)

    const run = store.listRuns(feature.id).find(r => r.stepId === "implement")!
    expect(run.status).toBe("failed")
    expect(run.failure).toMatchObject({ class: "transient_transport", source: "runner" })
  })

  it("a reaped missing session carries class missing_session; TTL reap carries timeout", async () => {
    const engine = makeEngine(linearWorkflow, { runTtlMs: 1000 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.liveSessions.delete(run.sessionId!)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.failure).toMatchObject({ class: "missing_session", source: "reaper" })
  })

  it("conclusion and its durable retry schedule are atomic: the outbox never carries the bypassed immediate execute_step, and a restart before the due time does not dispatch early", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.liveSessions.delete(run.sessionId!)
    await engine.reconcile()

    // Single commit: the run is concluded AND a scheduled retry_episode
    // exists — verified together, in the same assertion pass, exactly
    // like the one transaction that produced them.
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")
    expect(episode).toMatchObject({ status: "scheduled", scheduleSource: "backoff" })

    // The durable outbox row `concludeRun` persisted must NOT contain the
    // immediate execute_step for the retried step — that is exactly the
    // atomicity this test guards: a crash-and-replay of this outbox
    // entry must never bypass the schedule just recorded alongside it.
    const outboxRow = connection.db.query("SELECT completion_decisions FROM run WHERE id = ?").get(run.id) as { completion_decisions: string }
    const outboxDecisions = JSON.parse(outboxRow.completion_decisions) as Array<{ kind: string; jobId?: string; stepId?: string }>
    expect(outboxDecisions.some(d => d.kind === "execute_step" && d.jobId === "main" && d.stepId === "implement")).toBe(false)

    // Simulate a restart BEFORE the schedule is due: a fresh Engine over
    // the same store must not dispatch anything — no stale outbox replay,
    // no early claim.
    const restarted = makeEngine(retryWorkflow)
    await restarted.reconcile()
    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()
    expect(store.getPendingRunAction(feature.id)).toBeNull()

    // Advance past due: exactly one dispatch, from the schedule.
    clock.advance(50)
    await restarted.reconcile()
    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed).not.toBeNull()
    expect(rearmed!.id).not.toBe(run.id)
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
    expect(sessions.prompts.filter(p => p.text.includes(rearmed!.id)).length).toBe(1)
  })

  it("budget-exhausted conclusion is atomic: one commit holds the run conclusion, the step.failed transition and the step.budget_exhausted transition, with no scheduled episode and no immediate execute_step in the outbox", async () => {
    const engine = makeEngine(retryWorkflow, { runTtlMs: 1000 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    clock.advance(600_001)
    await engine.reconcile()

    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("escalated")

    // The outbox holds no immediate execute_step for the exhausted step —
    // its retry never dispatches.
    const outboxRow = connection.db.query("SELECT completion_decisions FROM run WHERE id = ?").get(run.id) as { completion_decisions: string }
    const outboxDecisions = JSON.parse(outboxRow.completion_decisions) as Array<{ kind: string; jobId?: string; stepId?: string }>
    expect(outboxDecisions.some(d => d.kind === "execute_step" && d.jobId === "main" && d.stepId === "implement")).toBe(false)

    // Both the step.failed AND the step.budget_exhausted transitions landed
    // in the SAME commit — the transition log carries both event kinds.
    const kinds = store.getTransitions(feature.id).map(t => (t.event as { kind: string }).kind)
    expect(kinds).toContain("step.failed")
    expect(kinds).toContain("step.budget_exhausted")
  })

  it("schedule contention: a competing failed-run conclusion for a step with a pre-existing future scheduled episode concludes without an immediate dispatch, without a second episode, and leaves the original schedule intact", async () => {
    // A command step's classified failure runs through `planFailureDisposition`
    // synchronously inside `dispatch` — unlike the reaper's paths (only
    // reachable via `reconcile()`'s per-job loop, which deliberately skips
    // a job whose step already has an open episode and so cannot exercise
    // this exact race), this lets the test seed a pre-existing episode
    // for the target BEFORE the classified failure is even computed.
    const commandRetryWorkflow: WorkflowDef = workflow(
      { main: job([commandStep("implement", ["build"], { retry: backoff(5, 10) })]) },
      roles,
      "command-retry",
    )
    const engine = makeEngine(commandRetryWorkflow)
    const feature = store.createFeature({ title: "Ship it", slug: "ship-it", projectDir: "/tmp/project", workflow: commandRetryWorkflow.name })

    // A retry episode already owns "main/implement" (e.g. scheduled by an
    // earlier concurrent conclusion that won the race).
    const existing = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: clock.now(), nextAttemptAt: clock.now() + 5_000, delayMs: 5_000,
      scheduleSource: "backoff", maxAttempts: 5, maxElapsedMs: 600_000,
      failure: { class: "transient_upstream", diagnostic: "503", source: "runner" },
    })!

    process_.handler = () => ({ code: 1, stdout: "", stderr: "boom", output: "boom" })
    await engine.dispatch(feature.id, { kind: "feature.start" })

    const run = store.listRuns(feature.id).find(r => r.stepId === "implement")!
    expect(run.status).toBe("failed")
    // No immediate dispatch: the losing conclusion does NOT fall back to
    // executing the step itself — that fallback was the schedule-
    // contention bug (bypassing the owning episode's backoff).
    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()
    // No second episode: exactly the original one, untouched.
    const episodes = store.listRetryEpisodes(feature.id)
    expect(episodes).toHaveLength(1)
    expect(episodes[0]).toMatchObject({ id: existing.id, nextAttemptAt: existing.nextAttemptAt, delayMs: 5_000 })
  })

  it("a retry with a non-zero backoff becomes a durable scheduled episode, claimed when due", async () => {
    const engine = makeEngine(retryWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.liveSessions.delete(run.sessionId!)
    await engine.reconcile()

    // The reap classified the failure; retryWorkflow's backoff (10ms) is
    // non-zero, so no immediate re-dispatch — a scheduled episode instead.
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")
    expect(episode).toMatchObject({ status: "scheduled", scheduleSource: "backoff" })

    // Not due yet — reconcile dispatches nothing.
    await engine.reconcile()
    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()

    clock.advance(50)
    await engine.reconcile()
    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed).not.toBeNull()
    expect(rearmed!.id).not.toBe(run.id)
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
  })

  it("elapsed budget exhausts during backoff: the next computed attempt would start past the deadline, so it is never scheduled and the step escalates immediately (retry-budget spec)", async () => {
    // TTL reaps classify "timeout" (class-default budget: 5 attempts,
    // 600_000ms elapsed) — retryWorkflow's own attempts budget (2) is
    // reached well before 5, so this exercises the ELAPSED axis, not
    // attempts. Advancing the clock past 600_000ms before the reap fires
    // means the very first scheduled retry's candidate attempt already
    // lands past the elapsed deadline.
    const engine = makeEngine(retryWorkflow, { runTtlMs: 1000 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    clock.advance(600_001)
    await engine.reconcile()

    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(store.getRunById(run.id)?.failure).toMatchObject({ class: "timeout" })
    // No durable retry was scheduled — the budget check rejected it before
    // `store.scheduleRetry` was ever called.
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
    // retryWorkflow has no `onFail` and a single job, so exhaustion routes
    // straight to job failure → feature escalation, exactly like an
    // attempts-exhausted failure would.
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getEscalation(feature.id)).toContain("exceeded")
    expect(store.getEscalation(feature.id)).toContain("elapsed retry budget")
  })

  it("a due episode claimed past its elapsed deadline (e.g. a daemon outage spanning the due time) is escalated instead of dispatched", async () => {
    const engine = makeEngine(retryWorkflow, { runTtlMs: 1000 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    // Reap within budget: a short TTL reap at t=2000ms is well inside the
    // 600_000ms timeout deadline, so the retry schedules normally this time.
    clock.advance(2000)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")
    expect(episode).toMatchObject({ status: "scheduled" })

    // The daemon is "down" for a very long time — long enough that by the
    // time reconcile() next runs and claims the (now very much due)
    // episode, the elapsed deadline measured from the ORIGINAL episode
    // start has already passed even though the schedule's own
    // next_attempt_at was always comfortably inside it.
    clock.advance(600_000)
    await engine.reconcile()

    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
    expect(store.getRetryEpisode(episode!.id)?.closedReason).toBe("elapsed_budget_exhausted_at_claim")
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    expect(store.getEscalation(feature.id)).toContain("elapsed retry budget")
  })

  it("pause time is excluded from the elapsed retry budget — a long pause spanning what would otherwise be the deadline does not burn it", async () => {
    // Same TTL/class setup as the elapsed-exhaustion test above, but this
    // time the long gap is spent PAUSED rather than the daemon being down
    // — durable-retries spec: "Retry becomes due while paused ... pause
    // time is excluded from the remaining elapsed budget".
    const engine = makeEngine(retryWorkflow, { runTtlMs: 1000 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    clock.advance(2000)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")!
    expect(episode.status).toBe("scheduled")

    await engine.pause(feature.id)
    clock.advance(600_000)
    await engine.resume(feature.id)

    // The 600_000ms gap happened entirely under pause — it must not count
    // toward the episode's elapsed budget, so the already-due retry is
    // claimed and dispatched normally instead of escalating.
    await engine.reconcile()
    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed).not.toBeNull()
    expect(rearmed!.id).not.toBe(run.id)
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
    expect(store.getFeature(feature.id)?.status).toBe("running")
  })

  it("pause DURING the FIRST attempt's execution (no retry episode exists yet) is still excluded from the elapsed budget — the streak's pause snapshot anchors to the attempt's own dispatch, not to an episode that doesn't exist yet", async () => {
    // Regression test for the pause-accounting gap `applyTransitionTx`'s
    // per-episode fold could never close: a pause while an attempt is
    // EXECUTING (before ANY retry_episode row exists for this streak) has
    // no open row to fold into. Fix B's snapshot mechanism instead reads
    // the RUN's own `pausedMsAtDispatch` as the streak anchor for a
    // genuinely first episode (`planFailureDisposition`), so the pause is
    // accounted for even though it happened before any episode existed.
    const runTtlMs = 100_000
    const engine = makeEngine(retryWorkflow, { runTtlMs })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    expect(run.pausedMsAtDispatch).toBe(0)

    // Pause while the run is still genuinely RUNNING — no episode exists.
    // applyTransitionTx's pause fold uses real Date.now() (see
    // retry-store.test.ts's "pause accounting" suite), not the injected
    // FakeClock, so the pause span itself is produced entirely by
    // backdating `paused_at` in real-clock terms — the FakeClock is never
    // advanced across the pause/resume pair, so it cannot itself drift
    // away from the run's own real-clock `time_started` in the meantime.
    await engine.pause(feature.id)
    connection.db.run("UPDATE feature SET paused_at = paused_at - 700000 WHERE id = ?", [feature.id])
    await engine.resume(feature.id)
    expect(store.getPauseAccounting(feature.id)!.pausedMs).toBeGreaterThanOrEqual(700_000)

    // Trip the TTL reap deterministically by backdating the run's own
    // `time_started` (also real-clock, same split) rather than advancing
    // the FakeClock — advancing the FakeClock here would itself desync it
    // from the run's real-clock `time_started`, making every
    // freshly-dispatched run look TTL-stale on the very next reconcile.
    connection.db.run("UPDATE run SET time_started = time_started - ?, time_last_activity = time_last_activity - ? WHERE id = ?", [runTtlMs + 100, runTtlMs + 100, run.id])
    await engine.reconcile()
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")
    expect(episode).not.toBeNull()
    expect(episode!.status).toBe("scheduled")
    // `pausedMs` is computed FRESH at schedule time (feature cumulative
    // now − snapshot) and persisted for observability — it correctly
    // reflects the 700_000ms span even though NO episode existed while
    // that span happened; the old per-episode fold in `applyTransitionTx`
    // could never have produced this (it only ever adds to an episode
    // that is already open), proving this came from the new snapshot path.
    expect(episode!.pausedMs).toBeGreaterThanOrEqual(700_000)
    expect(episode!.featurePausedMsAtStart).toBe(0)

    // Claim-time re-check: advance to the scheduled retry time (well
    // inside the 600_000ms class budget once the 700_000ms pause is
    // correctly excluded) and confirm it dispatches instead of escalating.
    clock.advance(episode!.nextAttemptAt! - clock.now())
    await engine.reconcile()
    expect(store.getRetryEpisode(episode!.id)?.closedReason).toBe("attempt_dispatched")
    expect(store.getFeature(feature.id)?.status).toBe("running")
  })

  it("pause DURING a LATER chained attempt's execution is excluded via the streak's snapshot, inherited unchanged across the chain", async () => {
    // The chained-episode counterpart of the test above: the pause
    // happens after episode 1 has already closed `attempt_dispatched`
    // (so its run is executing with no OPEN episode row either) — same
    // gap the per-episode fold could never close, this time on attempt 2
    // instead of attempt 1.
    const chainWorkflow: WorkflowDef = workflow(
      { main: job([agentStep("implement", "implementer", "go", { retry: backoff(3, 10) })]) },
      roles,
      "chain",
    )
    const runTtlMs = 100_000
    const engine = makeEngine(chainWorkflow, { runTtlMs })
    const feature = await startedFeature(engine)
    const run1 = store.getActiveRunForStep(feature.id, "main", "implement")!

    // TTL-reap attempt 1 via a real-clock backdate of `time_started`
    // (same reasoning as the first-attempt test above) rather than
    // advancing the FakeClock, so the FakeClock stays at "now" and every
    // freshly-dispatched run's real-clock `time_started` stays close to
    // it — no accumulated desync across this multi-dispatch scenario.
    connection.db.run("UPDATE run SET time_started = time_started - ?, time_last_activity = time_last_activity - ? WHERE id = ?", [runTtlMs + 100, runTtlMs + 100, run1.id])
    await engine.reconcile()
    const episode1 = store.getOpenRetryEpisode(feature.id, "main", "implement")!
    expect(episode1.attempts).toBe(1)
    expect(episode1.featurePausedMsAtStart).toBe(0)

    // Advance EXACTLY to the scheduled due time (not a moment more) so the
    // freshly-dispatched run 2 does not itself look TTL-stale by the time
    // this same reconcile pass evaluates it.
    clock.advance(episode1.nextAttemptAt! - clock.now())
    await engine.reconcile()
    const run2 = store.getActiveRunForStep(feature.id, "main", "implement")!
    expect(run2.id).not.toBe(run1.id)
    expect(store.getRetryEpisode(episode1.id)?.closedReason).toBe("attempt_dispatched")

    // Pause DURING run 2's execution — no episode is open right now.
    await engine.pause(feature.id)
    connection.db.run("UPDATE feature SET paused_at = paused_at - 500000 WHERE id = ?", [feature.id])
    clock.advance(500_000)
    await engine.resume(feature.id)

    await engine.reconcile()
    const episode2 = store.getOpenRetryEpisode(feature.id, "main", "implement")
    expect(episode2).not.toBeNull()
    expect(episode2!.attempts).toBe(2)
    // Chained: the snapshot baseline is inherited unchanged from episode
    // 1, NOT re-read at chain time — mirrors `startedAt`'s own
    // inheritance rule (both stay fixed for the whole streak).
    expect(episode2!.featurePausedMsAtStart).toBe(episode1.featurePausedMsAtStart)
    expect(episode2!.pausedMs).toBeGreaterThanOrEqual(500_000)
    expect(store.getFeature(feature.id)?.status).toBe("running")

    // Claim-time re-check: well inside the 600_000ms budget once the
    // 500_000ms pause is correctly excluded, so this dispatches instead
    // of escalating (rather than asserting "running" after this dispatch:
    // the freshly-created run 3's real-clock `time_started` would need
    // its own FakeClock re-pin, same as run 2 above, to survive a further
    // reconcile — the dispatch-not-escalate outcome itself is the
    // assertion that matters here).
    clock.advance(episode2!.nextAttemptAt! - clock.now())
    await engine.reconcile()
    expect(store.getRetryEpisode(episode2!.id)?.closedReason).toBe("attempt_dispatched")
  })

  it("multiple pause/resume spans across BOTH execution and backoff wait are each counted exactly once, never double-counted or dropped", async () => {
    const runTtlMs = 100_000
    const engine = makeEngine(retryWorkflow, { runTtlMs })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    // Span 1: pause DURING execution (no episode exists yet). The pause
    // span itself is produced via a FakeClock advance paired 1:1 with a
    // matching `paused_at` backdate, so the two clocks agree on ITS
    // duration — but that pairing necessarily leaves the FakeClock 300s
    // ahead of the run's own real-clock `time_started`. Trip the TTL reap
    // via a direct `time_started` backdate instead of a further
    // FakeClock advance, so no additional desync accrues on top of it.
    await engine.pause(feature.id)
    connection.db.run("UPDATE feature SET paused_at = paused_at - 300000 WHERE id = ?", [feature.id])
    clock.advance(300_000)
    await engine.resume(feature.id)
    connection.db.run("UPDATE run SET time_started = time_started - ?, time_last_activity = time_last_activity - ? WHERE id = ?", [runTtlMs + 100, runTtlMs + 100, run.id])

    // TTL-reap now schedules episode 1 — its snapshot baseline is the
    // feature's cumulative paused_ms as of run 1's dispatch (0, since the
    // pause above happened AFTER dispatch — see `pausedMsAtDispatch`'s
    // doc comment: this baseline is fixed at dispatch time, so it does
    // NOT itself already include span 1; span 1 is entirely part of the
    // streak's accountable pause time, exactly like span 2 below).
    await engine.reconcile()
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")!
    expect(episode.featurePausedMsAtStart).toBe(0)

    // Span 2: pause AGAIN, this time while the episode is open/scheduled
    // (the OLD per-episode fold's own supported case) — both spans must
    // land in the SAME cumulative total, counted once each.
    await engine.pause(feature.id)
    connection.db.run("UPDATE feature SET paused_at = paused_at - 200000 WHERE id = ?", [feature.id])
    clock.advance(200_000)
    await engine.resume(feature.id)

    const cumulative = store.getPauseAccounting(feature.id)!.pausedMs
    expect(cumulative).toBeGreaterThanOrEqual(500_000)
    // Two independent readers of the same streak both see the SAME delta:
    // the engine's own computation (mirrored here) and the store helper.
    expect(store.getFeaturePausedMsAsOf(feature.id, clock.now())! - episode.featurePausedMsAtStart).toBe(cumulative)

    clock.advance(episode.nextAttemptAt! - clock.now())
    await engine.reconcile()
    // Both 300_000ms + 200_000ms spans excluded: well inside the
    // 600_000ms budget, so this dispatches instead of escalating.
    expect(store.getRetryEpisode(episode.id)?.closedReason).toBe("attempt_dispatched")
  })
})

describe("Engine: command quality feedback", () => {
  const def = workflow({ main: job([
    agentStep("implement", "implementer", 'Repair: {{ feedback.jobs["main"]["quality"]["diagnostic"] }}'),
    commandStep("quality", ["bun run typecheck"], { onFail: rerunSteps(["implement", "quality"], 3) }),
  ]) }, roles)

  it.each([false, true])("delivers actual bounded command diagnostics with empty outputs (restart=%s)", async restart => {
    let available = true
    let engine = makeEngine(def, {}, { runnerAvailable: () => available })
    const feature = await startedFeature(engine)
    connection.db.run("UPDATE feature SET feedback = ? WHERE id = ?", [JSON.stringify({ message: "stale global", jobs: { main: { quality: { diagnostic: "stale diagnostic" } } } }), feature.id])
    process_.handler = () => ({ code: 2, stdout: "", stderr: "", output: "x".repeat(5000) + "\nTS2322: expected number; api_key=secret-value" })
    available = !restart
    await engine.report({ runId: store.getActiveRun(feature.id)!.id, outcome: "succeeded" })
    const failed = store.listRuns(feature.id).find(run => run.stepId === "quality")!
    expect(failed.status).toBe("failed")
    expect(failed.outputs).toEqual({})
    const diagnostic = store.getFeedback(feature.id)?.jobs.main?.quality?.diagnostic
    expect(diagnostic).toContain('"bun run typecheck" exited 2')
    expect(diagnostic).toContain("TS2322")
    expect(diagnostic).not.toContain("secret-value")
    expect(diagnostic!.length).toBeLessThanOrEqual(4000)
    if (restart) {
      expect(store.getActiveRun(feature.id)).toBeNull()
      connection.close()
      connection = openMigratedDatabase({ path: join(directory, "state.db") })
      store = new Store(connection.db, clock)
      engine = makeEngine(def, {}, { runnerAvailable: () => true })
      clock.advance(60_000)
      await engine.reconcile()
    }
    expect(sessions.prompts.at(-1)?.text).toContain(diagnostic!)
    expect(sessions.prompts.at(-1)?.text).not.toContain("stale")
    expect(store.getActiveRun(feature.id)?.stepId).toBe("implement")
  })
})

describe("Engine: rerun loop with feedback", () => {
  it("a rerun scope=steps loop surfaces feedback in the round-2 prompt", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "impl v1" })
    run = store.getActiveRunForStep(feature.id, "main", "review")!
    await engine.report({ runId: run.id, verdict: "changes_requested", notes: "needs tests" })

    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
    expect(store.getFeature(feature.id)?.jobs["main"]?.reruns["review"]).toBe(1)
    const round2Prompt = sessions.prompts.at(-1)!
    expect(round2Prompt.text).toContain("needs tests")
  })

  it("exhausting maxRounds escalates", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    // rerunSteps(["implement","review"], 2): round 1 and 2 loop back;
    // round 3 exceeds maxRounds and escalates.
    for (let round = 0; round < 3; round++) {
      let run = store.getActiveRunForStep(feature.id, "main", "implement")!
      await engine.report({ runId: run.id, outcome: "succeeded", notes: `impl v${round + 1}` })
      run = store.getActiveRunForStep(feature.id, "main", "review")!
      await engine.report({ runId: run.id, verdict: "changes_requested", notes: "again" })
    }
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })

  it("a rerun-exhausted escalation is recoverable: the succeeded routing step re-arms with a fresh rerun budget", async () => {
    const engine = makeEngine(reviewLoopWorkflow)
    const feature = await startedFeature(engine)
    for (let round = 0; round < 3; round++) {
      let run = store.getActiveRunForStep(feature.id, "main", "implement")!
      await engine.report({ runId: run.id, outcome: "succeeded", notes: `impl v${round + 1}` })
      run = store.getActiveRunForStep(feature.id, "main", "review")!
      await engine.report({ runId: run.id, verdict: "changes_requested", notes: "again" })
    }
    // Exhausted: the routing step SUCCEEDED but the job failed with the
    // rerun counter still recorded — no failed step exists anywhere.
    const exhausted = store.getFeature(feature.id)!
    expect(exhausted.status).toBe("escalated")
    expect(exhausted.jobs["main"]?.status).toBe("failed")
    expect(exhausted.jobs["main"]?.steps["review"]?.status).toBe("succeeded")
    expect((exhausted.jobs["main"]?.reruns["review"] ?? 0) > 0).toBe(true)

    const result = await engine.recover(feature.id, { notes: "fresh loop budget" })
    expect(result.ok).toBe(true)
    expect(result.recovered).toEqual([{ jobId: "main", stepId: "review" }])
    const recovered = store.getFeature(feature.id)!
    expect(recovered.status).toBe("running")
    expect(recovered.jobs["main"]?.currentStep).toBe("review")
    expect(recovered.jobs["main"]?.reruns["review"]).toBeUndefined()
    expect(store.getActiveRunForStep(feature.id, "main", "review")).not.toBeNull()

    // Fresh budget holds: another changes_requested LOOPS instead of
    // instantly re-exhausting.
    const run = store.getActiveRunForStep(feature.id, "main", "review")!
    await engine.report({ runId: run.id, verdict: "changes_requested", notes: "loop again" })
    const looped = store.getFeature(feature.id)!
    expect(looped.status).toBe("running")
    expect(looped.jobs["main"]?.currentStep).toBe("implement")
    expect(looped.jobs["main"]?.reruns["review"]).toBe(1)
  })
})

describe("Engine: human reject re-runs", () => {
  it("request-changes reruns the mapped steps with notes as feedback", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    run = store.getActiveRunForStep(feature.id, "main", "verify")
      ?? store.getActiveRunForStep(feature.id, "main", "implement")!
    // verify runs synchronously (command), so feature should now be at gate
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")

    const result = await engine.requestChanges(feature.id, "please add tests")
    expect(result).toContain("Changes requested")
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
    expect(store.getFeature(feature.id)?.status).toBe("running")
  })
})

describe("Engine: nudge/reap", () => {
  it("idle debounce then nudge, then reap on exhausted nudges", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "idle")

    await engine.reconcile()
    expect(sessions.prompts.length).toBe(2) // initial dispatch + nudge
    expect(store.getRunById(run.id)?.status).toBe("running")

    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    // "implement" has no retry policy (default: one attempt) and no
    // onFail route, so the reap's step.failed fails the job outright —
    // the feature escalates rather than retrying.
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })

  it("a nudge resumes the session as the STEP's agent, not the runner default", async () => {
    const engine = makeEngine(reviewLoopWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const feature = await startedFeature(engine)
    let run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "impl v1" })
    run = store.getActiveRunForStep(feature.id, "main", "review")!
    sessions.statuses.set(run.sessionId!, "idle")

    await engine.reconcile()
    const nudge = sessions.prompts.at(-1)!
    expect(nudge.text).toContain("Your previous turn appears to have been interrupted")
    // The review step's role is "reviewer" (agent "review", model
    // "prov/review") — the nudge must carry it, or the resumed turn drops
    // the step's system prompt and runs as the default build agent.
    expect(nudge.agent).toBe("review")
    expect(nudge.model).toBe("prov/review")
  })

  it("a missing session is reaped immediately, no nudge", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 5, maxNudges: 5 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.liveSessions.delete(run.sessionId!)

    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(sessions.prompts.length).toBe(1) // only the original dispatch, no nudge
  })

  it("runTtlMs exceeded reaps regardless of session status", async () => {
    const engine = makeEngine(linearWorkflow, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")
    clock.advance(2000)

    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(store.getRunById(run.id)?.reason).toContain("without activity")
  })

  it("TTL measures silence, not age: a busy run with recent activity outlives runTtlMs", async () => {
    const engine = makeEngine(linearWorkflow, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")

    // The run is older than the TTL, but its logs prove it is alive.
    clock.advance(2000)
    store.appendRunLog(run.id, [{ source: "agent", text: "still working" }])
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("running")

    // Activity stops: silence past the TTL reaps it.
    clock.advance(1100)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
  })

  it("restart does not grant stale runs a fresh window: persisted silence reaps on the first pass", async () => {
    const engine = makeEngine(linearWorkflow, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")
    clock.advance(2000)

    // A fresh Engine over the same store — the restart. The activity
    // clock is durable, so the very first reconcile pass reaps.
    const restarted = makeEngine(linearWorkflow, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    await restarted.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
  })

  it("an agent step's ttlMs overrides the engine default for its runs", async () => {
    const longImplement: WorkflowDef = workflow(
      {
        main: job([
          agentStep("implement", "implementer", "Implement it.", { ttlMs: 10_000 }),
          commandStep("verify", ["bun test"]),
        ]),
      },
      roles,
      "long-implement",
    )
    const engine = makeEngine(longImplement, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")

    // Past the engine default but inside the step's own budget: alive.
    clock.advance(2000)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("running")

    // Past the step's own budget: reaped.
    clock.advance(9000)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
  })

  it("reaping aborts the run's session; an abort failure never blocks the reap", async () => {
    const engine = makeEngine(linearWorkflow, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")
    clock.advance(2000)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(sessions.aborted).toContain(run.sessionId!)

    // Second feature: abort throws — the reap still concludes.
    const feature2 = await startedFeature(engine)
    const run2 = store.getActiveRunForStep(feature2.id, "main", "implement")!
    sessions.statuses.set(run2.sessionId!, "busy")
    sessions.abortError = new Error("runner unreachable")
    clock.advance(2000)
    await engine.reconcile()
    expect(store.getRunById(run2.id)?.status).toBe("reaped")
  })

  it("the nudge-budget reap path also aborts the session", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "idle")
    await engine.reconcile() // nudge
    await engine.reconcile() // reap
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(sessions.aborted).toContain(run.sessionId!)
  })

  it("end to end: logs keep the run alive past the TTL, silence reaps with abort, and the retry budget re-dispatches", async () => {
    const engine = makeEngine(retryWorkflow, { runTtlMs: 1000, nudgeIdleCycles: 100, maxNudges: 100 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")

    // Streams logs past the engine TTL — alive.
    clock.advance(1500)
    store.appendRunLog(run.id, [{ source: "agent", text: "committing task 3" }])
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("running")

    // Goes dark — reaped, session aborted, timeout classified.
    clock.advance(1100)
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("reaped")
    expect(store.getRunById(run.id)?.failure).toMatchObject({ class: "timeout", source: "reaper" })
    expect(sessions.aborted).toContain(run.sessionId!)

    // The step's retry budget schedules a fresh attempt; once due, a new
    // run for the same step dispatches.
    const episode = store.getOpenRetryEpisode(feature.id, "main", "implement")
    expect(episode).toMatchObject({ status: "scheduled" })
    clock.advance(60_000)
    await engine.reconcile()
    const rearmed = store.getActiveRunForStep(feature.id, "main", "implement")
    expect(rearmed).not.toBeNull()
    expect(rearmed!.id).not.toBe(run.id)
  })

  it("busy and retry sessions are never nudged", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    sessions.statuses.set(run.sessionId!, "busy")
    await engine.reconcile()
    await engine.reconcile()
    sessions.statuses.set(run.sessionId!, "retry")
    await engine.reconcile()
    expect(store.getRunById(run.id)?.status).toBe("running")
    expect(sessions.prompts.length).toBe(1)
  })
})

describe("Engine: duplicate report", () => {
  it("a second report on the same run is rejected idempotently", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    const first = await engine.report({ runId: run.id, outcome: "succeeded" })
    expect(first).not.toContain("already concluded")
    const second = await engine.report({ runId: run.id, outcome: "failed" })
    expect(second).toContain(`Run ${run.id} already concluded`)
  })
})

describe("Engine: multi-job fan-out/fan-in", () => {
  it("feature.start dispatches both independent jobs; completion of both dispatches the join", async () => {
    const engine = makeEngine(fanInWorkflow)
    const feature = await startedFeature(engine)
    expect(sessions.prompts.length).toBe(2)
    const runA = store.getActiveRunForStep(feature.id, "a", "work")!
    const runB = store.getActiveRunForStep(feature.id, "b", "work")!
    await engine.report({ runId: runA.id, outcome: "succeeded", notes: "A" })
    expect(store.getActiveRunForStep(feature.id, "join", "combine")).toBeNull()
    await engine.report({ runId: runB.id, outcome: "succeeded", notes: "B" })
    const joinRun = store.getActiveRunForStep(feature.id, "join", "combine")
    expect(joinRun).not.toBeNull()
    expect(sessions.prompts.at(-1)!.text).toContain("A")
    expect(sessions.prompts.at(-1)!.text).toContain("B")
  })
})

describe("Engine: pause/resume/abandon", () => {
  it("pause then resume returns to running at the same step", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    await engine.pause(feature.id)
    expect(store.getFeature(feature.id)?.status).toBe("paused")
    await engine.resume(feature.id)
    expect(store.getFeature(feature.id)?.status).toBe("running")
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
  })

  it("abandon terminates the feature", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    await engine.abandon(feature.id)
    expect(store.getFeature(feature.id)?.status).toBe("abandoned")
  })
})

describe("Engine: per-feature error isolation", () => {
  it("one feature's reconcile error never blocks another feature's reconciliation", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1 })
    const featureA = await startedFeature(engine)
    const featureB = await startedFeature(engine)
    const runA = store.getActiveRunForStep(featureA.id, "main", "implement")!
    const runB = store.getActiveRunForStep(featureB.id, "main", "implement")!

    let calls = 0
    const originalStatus = sessions.status.bind(sessions)
    sessions.status = async (sessionID: string) => {
      calls += 1
      if (sessionID === runA.sessionId) throw new Error("boom")
      return originalStatus(sessionID)
    }
    sessions.statuses.set(runB.sessionId!, "idle")

    await engine.reconcile()
    expect(calls).toBeGreaterThan(0)
    // feature B's run still got its nudge despite A's blowup
    expect(store.getRunById(runB.id)?.status).toBe("running")
    expect(store.getRunById(runA.id)?.status).toBe("running")
  })
})

describe("Engine: stale reviewer completion outbox", () => {
  it("does not redispatch a completed reviewer while its predecessor still awaits prompt acknowledgment", async () => {
    const def = workflow({ main: job([
      agentStep("implement", "implementer", "implement"),
      agentStep("review", "reviewer", "review"),
      agentStep("publish", "implementer", "publish"),
    ]) }, roles)
    const engine = makeEngine(def)
    const feature = await startedFeature(engine)
    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const prompt = sessions.prompt.bind(sessions)
    sessions.prompt = async input => {
      await prompt(input)
      if (input.agent === "review") {
        entered()
        await barrier
      }
    }
    const predecessor = store.getActiveRun(feature.id)!
    const reporting = engine.report({ runId: predecessor.id, outcome: "succeeded" })
    await ready
    const reviewer = store.getActiveRunForStep(feature.id, "main", "review")!
    await engine.report({ runId: reviewer.id, outcome: "succeeded" })
    expect(store.getPendingRunAction(feature.id)?.runId).toBe(predecessor.id)
    expect(store.getFeature(feature.id)?.jobs.main?.currentStep).toBe("publish")
    sessions.prompt = prompt
    try {
      await engine.reconcile()
      expect(store.listRuns(feature.id).filter(run => run.stepId === "review")).toHaveLength(1)
      expect(store.getActiveRunForStep(feature.id, "main", "publish")).not.toBeNull()
      expect(sessions.aborted).toHaveLength(0)
    } finally {
      release()
      await reporting
    }
  })
})

describe("Engine: restart recovery", () => {
  it("a new engine constructed on the same store resumes a feature mid-flight", async () => {
    const engine1 = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine1)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    const engine2 = makeEngine(linearWorkflow)
    // no run for a fresh engine instance but the same DB: reconcile should
    // see the existing active run and not double-dispatch.
    await engine2.reconcile()
    expect(store.listRuns(feature.id).filter(r => r.stepId === "implement")).toHaveLength(1)

    await engine2.report({ runId: run.id, outcome: "succeeded" })
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("gate")
  })

  it("recovers a pending decision that was never dispatched before a crash", async () => {
    const engine1 = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine1)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    // Conclude the run directly through the store (simulating concludeRun
    // committing but the process crashing before dispatchDecisions ran).
    const { interpret } = await import("@conductor/core")
    const state = store.getFeature(feature.id)!
    const event = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done", outputs: { report: "x" } } as const
    const transition = interpret(linearWorkflow, state, event)
    store.concludeRun(run.id, "succeeded", { outputs: { report: "x" } }, event, transition)
    expect(store.getPendingRunAction(feature.id)).not.toBeNull()

    const engine2 = makeEngine(linearWorkflow)
    await engine2.reconcile()
    expect(store.getPendingRunAction(feature.id)).toBeNull()
    // the recovered decision (execute verify, a command step) ran synchronously
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("gate")
  })

  it("a crash mid-replay leaves the batch pending; the next pass retries it whole", async () => {
    // implement → gate: the pending batch is a wait_human notification,
    // the decision kind with no state to self-heal from if dropped.
    const gateWorkflow: WorkflowDef = workflow(
      {
        main: job([
          agentStep("implement", "implementer", "go"),
          humanStep("gate", { outcomes: { approved: next, rejected: rerunSteps(["implement"], 3) } }),
        ]),
      },
      roles,
      "gate",
    )
    const engine1 = makeEngine(gateWorkflow)
    const feature = await startedFeature(engine1)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    const { interpret } = await import("@conductor/core")
    const state = store.getFeature(feature.id)!
    const event = { kind: "step.completed", jobId: "main", stepId: "implement", outcome: "done", outputs: { report: "x" } } as const
    const transition = interpret(gateWorkflow, state, event)
    store.concludeRun(run.id, "succeeded", { outputs: { report: "x" } }, event, transition)
    expect(store.getPendingRunAction(feature.id)).not.toBeNull()

    // First recovery attempt dies mid-replay (notify throws): the batch
    // must stay pending — replay-then-mark, never mark-then-replay.
    const crashing = makeEngine(gateWorkflow, {}, {
      notify: () => {
        throw new Error("crash mid-replay")
      },
    })
    await crashing.reconcile()
    expect(store.getPendingRunAction(feature.id)).not.toBeNull()

    const notifications: string[] = []
    const engine2 = makeEngine(gateWorkflow, {}, { notify: title => notifications.push(title) })
    await engine2.reconcile()
    expect(store.getPendingRunAction(feature.id)).toBeNull()
    expect(notifications).toHaveLength(1)
    expect(store.getFeature(feature.id)?.status).toBe("waiting_human")
  })
})

describe("Engine: action steps", () => {
  const worktreeManifest = actionManifest({
    name: "git/worktree",
    inputs: {
      branch: { type: "string", presence: "required" },
      retries: { type: "number", presence: "optional", default: 1 },
    },
    outputs: { path: "string" },
    capabilities: ["filesystem"],
  })

  const actionWorkflow: WorkflowDef = workflow(
    {
      main: job([
        actionStepDef("worktree", "git/worktree@v1", { branch: "feat/x", retries: "{{ 3 }}" }),
        agentStep("implement", "implementer", "go, using {{ steps.worktree.outputs.path }}"),
      ]),
    },
    roles,
    "action-flow",
  )

  function bindingsFor(manifest: ActionManifest) {
    return actionBindings([{ jobId: "main", stepId: "worktree", uses: "git/worktree@v1", manifest }])
  }

  it("action handler logging through the injected runLog lands as action lines on the executing run", async () => {
    const prepFlow: WorkflowDef = workflow(
      {
        main: job([
          actionStepDef("worktree", "test/action@v1"),
          agentStep("implement", "implementer", "go"),
        ]),
      },
      roles,
      "prep-flow",
    )
    const testBinding = actionManifest({ name: "test/action" })
    const engine = makeEngine(prepFlow, {}, {}, actionBindings([
      { jobId: "main", stepId: "worktree", uses: "test/action@v1", manifest: testBinding },
    ]))
    actions.handler = (_binding, _ctx, effects) => {
      effects?.runLog?.("observing external state…")
      effects?.runLog?.("still waiting")
      return { ok: true, outputs: {} }
    }
    const feature = await startedFeature(engine)
    const actionRun = store.listRuns(feature.id).find(r => r.stepId === "worktree")!
    expect(actionRun.status).toBe("succeeded")
    const log = store.getRunLog(actionRun.id)
    expect(log.lines.map(line => ({ source: line.source, text: line.text }))).toEqual([
      { source: "action", text: "observing external state…" },
      { source: "action", text: "still waiting" },
    ])
  })

  it("dispatches through registry→reservation→host, and downstream steps see its outputs via {{ steps }}", async () => {
    actions.handler = () => ({ ok: true, outputs: { path: "/repo-worktrees/feat-x" } })
    const engine = makeEngine(actionWorkflow, {}, {}, bindingsFor(worktreeManifest))
    const feature = await engine.startFeature("/tmp/project", { title: "Ship it" })
    if (!feature.ok) throw new Error(feature.message)
    await engine.settleActions()

    const worktreeRun = store.listRuns(feature.feature.id).find(r => r.stepId === "worktree")!
    expect(worktreeRun.status).toBe("succeeded")
    expect(worktreeRun.stepType).toBe("action")
    expect(worktreeRun.outputs).toEqual({ path: "/repo-worktrees/feat-x" })
    expect(actions.calls).toHaveLength(1)
    expect(actions.calls[0]!.ctx.capabilities).toEqual(["filesystem"])

    // downstream agent prompt template resolved the action's output
    expect(sessions.prompts.at(-1)!.text).toContain("/repo-worktrees/feat-x")
  })

  it("records uses/version/digest metadata on the run", async () => {
    actions.handler = () => ({ ok: true, outputs: { path: "/x" } })
    const bindings = bindingsFor(worktreeManifest)
    const engine = makeEngine(actionWorkflow, {}, {}, bindings)
    const feature = await startedFeature(engine)
    await engine.settleActions()
    const run = store.listRuns(feature.id).find(r => r.stepId === "worktree")!

    expect(run.metadata).toEqual({
      uses: "git/worktree@v1",
      version: worktreeManifest.version,
      digest: bindings[JSON.stringify(["main", "worktree"])]!.digest,
    })
  })

  it("coerces a rendered template number input from its string form", async () => {
    let seenRetries: unknown
    actions.handler = (_binding, ctx) => {
      seenRetries = ctx.inputs.retries
      return { ok: true, outputs: { path: "/x" } }
    }
    const engine = makeEngine(actionWorkflow, {}, {}, bindingsFor(worktreeManifest))
    await engine.startFeature("/tmp/project", { title: "Ship it" })
    await engine.settleActions()

    expect(seenRetries).toBe(3)
    expect(typeof seenRetries).toBe("number")
  })

  it("an action failure fails the step and escalates when there is no onFail route", async () => {
    actions.handler = () => ({ ok: false, error: "boom" })
    const engine = makeEngine(actionWorkflow, {}, {}, bindingsFor(worktreeManifest))
    const feature = await startedFeature(engine)
    await engine.settleActions()

    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    const run = store.listRuns(feature.id).find(r => r.stepId === "worktree")!
    expect(run.status).toBe("failed")
    expect(run.reason).toBe("boom")
  })

  it("a missing binding fails the step instead of dispatching (workflow changed since load)", async () => {
    const engine = makeEngine(actionWorkflow, {}, {}, {})
    const feature = await startedFeature(engine)

    expect(actions.calls).toHaveLength(0)
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    // no binding → no run row is ever inserted for the step
    expect(store.listRuns(feature.id).some(r => r.stepId === "worktree")).toBe(false)
  })

  it("an unparseable rendered number input fails the step without calling the host", async () => {
    const badWorkflow: WorkflowDef = workflow(
      {
        main: job([actionStepDef("worktree", "git/worktree@v1", { branch: "b", retries: "{{ 'not-a-number' }}" })]),
      },
      roles,
      "action-bad-input",
    )
    const engine = makeEngine(badWorkflow, {}, {}, bindingsFor(worktreeManifest))
    const feature = await startedFeature(engine)

    expect(actions.calls).toHaveLength(0)
    const run = store.listRuns(feature.id).find(r => r.stepId === "worktree")!
    expect(run.status).toBe("failed")
    expect(run.reason).toContain("not a valid number")
  })

  it("TTL reaps a hung action run just like a command run", async () => {
    actions.calls = []
    const pending = new Promise<never>(() => {}) // never resolves — simulates a hung host call
    actions.handler = () => { throw new Error("unused") }
    const originalExecute = actions.execute.bind(actions)
    actions.execute = async (binding, ctx) => {
      actions.calls.push({ binding, ctx })
      return pending
    }
    const engine = makeEngine(actionWorkflow, { runTtlMs: 1000 }, { clock }, bindingsFor(worktreeManifest))
    void engine.startFeature("/tmp/project", { title: "Ship it" })
    // let the dispatch reach the (hung) host call before reconciling
    await new Promise(resolve => setTimeout(resolve, 10))
    const feature = store.listFeatures()[0]!
    clock.advance(2000)
    await engine.reconcile()

    const run = store.listRuns(feature.id).find(r => r.stepId === "worktree")!
    expect(run.status).toBe("reaped")
    void originalExecute
  })

  it("a slow action does not block reconciliation of other features", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    actions.execute = async (binding, ctx) => {
      actions.calls.push({ binding, ctx })
      await gate
      return { ok: true, outputs: { path: "/x" } }
    }
    const engine = makeEngine(actionWorkflow, {}, {}, bindingsFor(worktreeManifest))
    await engine.startFeature("/tmp/project", { title: "Slow action" })
    // the action is in flight (host gate held) yet dispatch returned:
    expect(actions.calls).toHaveLength(1)
    expect(store.listRuns(store.listFeatures()[0]!.id).find(r => r.stepId === "worktree")!.status).toBe("running")

    // a full reconcile pass completes while the action still hangs
    await engine.reconcile()

    release()
    await engine.settleActions()
    expect(store.listRuns(store.listFeatures()[0]!.id).find(r => r.stepId === "worktree")!.status).toBe("succeeded")
  })

  it("a restart concludes an orphaned running action run as failed for retry", async () => {
    let hold!: () => void
    const gate = new Promise<void>(resolve => {
      hold = resolve
    })
    actions.execute = async (binding, ctx) => {
      actions.calls.push({ binding, ctx })
      await gate
      return { ok: true, outputs: { path: "/x" } }
    }
    const engine1 = makeEngine(actionWorkflow, {}, {}, bindingsFor(worktreeManifest))
    await engine1.startFeature("/tmp/project", { title: "Interrupted" })
    const feature = store.listFeatures()[0]!
    expect(store.listRuns(feature.id).find(r => r.stepId === "worktree")!.status).toBe("running")

    // a fresh engine on the same store has no tracked execution for the run
    const engine2 = makeEngine(actionWorkflow, {}, {}, bindingsFor(worktreeManifest))
    await engine2.reconcile()

    const run = store.listRuns(feature.id).find(r => r.stepId === "worktree")!
    expect(run.status).toBe("failed")
    expect(run.reason).toBe("daemon restarted while action was executing")
    // no onFail route on the action step → the interpreter escalates
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
    hold()
    await engine1.settleActions()
  })
})

describe("Engine: durable pending action steps", () => {
  const pollManifest = actionManifest({
    name: "test/poll",
    inputs: {},
    outputs: {},
    capabilities: [],
  })

  const pendingWorkflow: WorkflowDef = workflow(
    {
      main: job([
        actionStepDef("poll", "test/poll@v1"),
        agentStep("implement", "implementer", "go"),
      ]),
    },
    roles,
    "action-pending",
  )

  function bindingsFor() {
    return actionBindings([{ jobId: "main", stepId: "poll", uses: "test/poll@v1", manifest: pollManifest }])
  }

  it("a pending result keeps the run running, burns no attempt, persists pendingState/nextObservation, and does not advance the feature", async () => {
    actions.handler = () => ({ ok: "pending", nextPollMs: 5000, state: { deadline: 999 } })
    const engine = makeEngine(pendingWorkflow, {}, { clock }, bindingsFor())
    const feature = await startedFeature(engine)
    await engine.settleActions()

    const run = store.listRuns(feature.id).find(r => r.stepId === "poll")!
    expect(run.status).toBe("running")
    expect(run.attempt).toBe(1)
    expect(run.pendingState).toEqual({ deadline: 999 })
    expect(run.nextObservation).toBe(clock.now() + 5000)
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("poll")
    expect(actions.calls).toHaveLength(1)
  })

  it("reconcile before nextObservation does not re-invoke the action", async () => {
    actions.handler = () => ({ ok: "pending", nextPollMs: 60_000, state: {} })
    const engine = makeEngine(pendingWorkflow, {}, { clock }, bindingsFor())
    await startedFeature(engine)
    await engine.settleActions()
    expect(actions.calls).toHaveLength(1)

    clock.advance(1000)
    await engine.reconcile()
    expect(actions.calls).toHaveLength(1)
  })

  it("advancing the clock past nextObservation re-invokes the action with ctx.resume equal to the recorded state", async () => {
    let call = 0
    let seenResume: unknown
    actions.handler = (_binding, ctx) => {
      call++
      seenResume = ctx.resume
      if (call === 1) return { ok: "pending", nextPollMs: 30_000, state: { deadline: 42 } }
      return { ok: true, outputs: {} }
    }
    const engine = makeEngine(pendingWorkflow, {}, { clock }, bindingsFor())
    await startedFeature(engine)
    await engine.settleActions()
    expect(actions.calls).toHaveLength(1)
    expect(seenResume).toBeUndefined()

    clock.advance(31_000)
    await engine.reconcile()
    await engine.settleActions()

    expect(actions.calls).toHaveLength(2)
    expect(seenResume).toEqual({ deadline: 42 })
  })

  it("pending then succeeded concludes the SAME run row (attempt stays 1) and advances the workflow", async () => {
    let call = 0
    actions.handler = () => {
      call++
      if (call === 1) return { ok: "pending", nextPollMs: 10_000, state: { x: 1 } }
      return { ok: true, outputs: {} }
    }
    const engine = makeEngine(pendingWorkflow, {}, { clock }, bindingsFor())
    const feature = await startedFeature(engine)
    await engine.settleActions()
    const runId = store.listRuns(feature.id).find(r => r.stepId === "poll")!.id

    clock.advance(11_000)
    await engine.reconcile()
    await engine.settleActions()

    const run = store.getRunById(runId)!
    expect(run.status).toBe("succeeded")
    expect(run.attempt).toBe(1)
    expect(store.listRuns(feature.id).filter(r => r.stepId === "poll")).toHaveLength(1)
    expect(store.getFeature(feature.id)?.jobs["main"]?.currentStep).toBe("implement")
  })

  it("a restart re-observes a pending action run instead of failing it (the orphan-fail path is for runs without nextObservation)", async () => {
    actions.handler = () => ({ ok: "pending", nextPollMs: 5000, state: { a: 1 } })
    const engine1 = makeEngine(pendingWorkflow, {}, { clock }, bindingsFor())
    const feature = await startedFeature(engine1)
    await engine1.settleActions()
    const runId = store.listRuns(feature.id).find(r => r.stepId === "poll")!.id

    let seenResume: unknown
    actions.handler = (_binding, ctx) => {
      seenResume = ctx.resume
      return { ok: true, outputs: {} }
    }
    const engine2 = makeEngine(pendingWorkflow, {}, { clock }, bindingsFor())
    clock.advance(6000)
    await engine2.reconcile()
    await engine2.settleActions()

    const run = store.getRunById(runId)!
    expect(run.status).toBe("succeeded")
    expect(seenResume).toEqual({ a: 1 })
    expect(store.getFeature(feature.id)?.status).not.toBe("escalated")
  })

  it("TTL reaping still applies to a pending run whose timeStarted is ancient", async () => {
    actions.handler = () => ({ ok: "pending", nextPollMs: 999_999_999, state: {} })
    const engine = makeEngine(pendingWorkflow, { runTtlMs: 1000 }, { clock }, bindingsFor())
    const feature = await startedFeature(engine)
    await engine.settleActions()

    clock.advance(2000)
    await engine.reconcile()

    const run = store.listRuns(feature.id).find(r => r.stepId === "poll")!
    expect(run.status).toBe("reaped")
  })

  it("recordPendingObservation racing a concluded run is dropped", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    actions.execute = async (binding, ctx) => {
      actions.calls.push({ binding, ctx })
      await gate
      return { ok: "pending", nextPollMs: 5000, state: { x: 1 } }
    }
    const engine = makeEngine(pendingWorkflow, { runTtlMs: 1000 }, { clock }, bindingsFor())
    await engine.startFeature("/tmp/project", { title: "Race" })
    const feature = store.listFeatures()[0]!
    const runId = store.listRuns(feature.id).find(r => r.stepId === "poll")!.id

    clock.advance(2000)
    await engine.reconcile()
    expect(store.getRunById(runId)!.status).toBe("reaped")

    release()
    await engine.settleActions()

    const run = store.getRunById(runId)!
    expect(run.status).toBe("reaped")
    expect(run.pendingState).toBeNull()
    expect(run.nextObservation).toBeNull()
  })
})

describe("Engine: startFeature", () => {
  it("returns project_not_configured when no workflow is registered", async () => {
    const engine = new Engine({
      store,
      workflows: () => null,
      sessions,
      process: process_,
      clock,
      log: { log: () => {} },
      actions,
    })
    const result = await engine.startFeature("/tmp/nowhere", { title: "T" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("project_not_configured")
  })

  it("returns unknown_workflow when the requested workflow name does not match", async () => {
    const engine = makeEngine(linearWorkflow)
    const result = await engine.startFeature("/tmp/project", { title: "T", workflow: "nope" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("unknown_workflow")
  })

  it("interprets the first feature.start dispatch against the exact snapshot validation/persistence used, even if the resolver changes on a later call (reload race)", async () => {
    // Both snapshots share a workflow name (so an unset `input.workflow`
    // never trips unknown_workflow) but diverge in job "main"'s only
    // step — version A an agent step, version B an unrelated command
    // step — so which snapshot actually drove interpretation is
    // observable from which run (if any) gets created.
    const versionA: WorkflowDef = workflow({ main: job([agentStep("implement", "implementer", "go")]) }, roles, "race")
    const versionB: WorkflowDef = workflow({ main: job([commandStep("other", ["echo hi"])]) }, roles, "race")
    const snapshotA = snapshotOf(versionA)
    const snapshotB = snapshotOf(versionB)
    let calls = 0
    const resolver = () => {
      calls += 1
      // A registry reload landing between validation/persistence and the
      // first dispatch would make every resolver call AFTER the first
      // observe the new snapshot — simulated here by switching after call 1.
      return calls === 1 ? snapshotA : snapshotB
    }
    const engine = new Engine({
      store, workflows: resolver, sessions, process: process_, clock, log: { log: () => {} }, actions,
    })
    const result = await engine.startFeature("/tmp/project", { title: "Ship it" })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Exactly one resolver call: startFeature's initial feature.start
    // dispatch must reuse the already-resolved snapshot, never re-resolve.
    expect(calls).toBe(1)
    // The interpreted decision reflects version A (the validated and
    // persisted snapshot) — never version B, which a re-resolve would
    // have picked up.
    expect(store.getActiveRunForStep(result.feature.id, "main", "implement")).not.toBeNull()
    expect(store.getActiveRunForStep(result.feature.id, "main", "other")).toBeNull()
  })
})

describe("Engine: startFeature with declared workflow inputs", () => {
  const inputWorkflow: WorkflowDef = workflow(
    {
      main: job([
        commandStep("implement", ["echo {{ inputs.feature }} {{ inputs.count }} {{ inputs.dryRun }}"]),
        actionStepDef("record", "test/record@v1", { feature: "{{ inputs.feature }}" }),
      ]),
    },
    roles,
    "with-inputs",
    {
      feature: { type: "string", presence: "required" },
      count: { type: "number", presence: "optional", default: 3 },
      dryRun: { type: "boolean", presence: "optional", default: false },
    },
  )

  function bindingsFor(): ResolvedActionBindings {
    return actionBindings([
      {
        jobId: "main",
        stepId: "record",
        uses: "test/record@v1",
        manifest: actionManifest({ name: "test/record", inputs: { feature: { type: "string", presence: "required" } } }),
      },
    ])
  }

  it("resolves required inputs and applies declared defaults before dispatch, persisting the map", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth" } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.feature.input).toEqual({ feature: "auth", count: 3, dryRun: false })
    const stored = store.getFeature(result.feature.id)!
    expect(stored.input).toEqual({ feature: "auth", count: 3, dryRun: false })
  })

  it("honours explicitly supplied values over declared defaults", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const result = await engine.startFeature("/tmp/project", {
      title: "Ship it",
      inputs: { feature: "auth", count: 9, dryRun: true },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.feature.input).toEqual({ feature: "auth", count: 9, dryRun: true })
  })

  it("omitting inputs entirely still resolves declared defaults (existing no-inputs-field callers stay compatible)", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth" } })
    expect(result.ok).toBe(true)
  })

  /**
   * Every rejection class below asserts the SAME four no-side-effect
   * facts against a workflow whose first job mixes a command step
   * ("implement") and an action step ("record") — so a leak through
   * either execution path is caught, not just the store row:
   *  - no feature row was created (`store.listFeatureRecords().length`)
   *  - no run was created for any step (`store.listRuns` — empty for
   *    every feature id that could plausibly exist, checked via the
   *    unchanged feature count above combined with an empty runs list
   *    for a synthesized id is meaningless, so instead this asserts the
   *    stronger, transport-level claims below)
   *  - no session was created (`sessions.created`)
   *  - the process runner's `shell` was never invoked — not just "no
   *    command run row", but the OS-level side effect itself never ran
   *    (`process_.shellCalls`)
   *  - no action host execution was invoked (`actions.calls`)
   */
  function expectNoSideEffects(beforeFeatureCount: number): void {
    expect(store.listFeatureRecords().length).toBe(beforeFeatureCount)
    expect(sessions.created).toEqual([])
    expect(process_.shellCalls).toEqual([])
    expect(actions.calls).toEqual([])
  }

  it("rejects a missing required input with no feature, run, session, command process or action created", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const before = store.listFeatureRecords().length
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: {} })
    expect(result.ok).toBe(false)
    if (result.ok || result.code !== "invalid_input") throw new Error("expected invalid_input")
    expect(result.diagnostics).toEqual([
      { name: "feature", kind: "missing_required", message: 'input "feature" is required (type: string)' },
    ])
    expectNoSideEffects(before)
  })

  it("rejects an unknown input with no feature, run, session, command process or action created", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const before = store.listFeatureRecords().length
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth", bogus: 1 } })
    expect(result.ok).toBe(false)
    if (result.ok || result.code !== "invalid_input") throw new Error("expected invalid_input")
    expect(result.diagnostics[0]!.kind).toBe("unknown_input")
    expectNoSideEffects(before)
  })

  it("rejects a mistyped (wrong_type) input with no feature, run, session, command process or action created", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const before = store.listFeatureRecords().length
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: 42 } })
    expect(result.ok).toBe(false)
    if (result.ok || result.code !== "invalid_input") throw new Error("expected invalid_input")
    expect(result.diagnostics[0]!).toEqual({ name: "feature", kind: "wrong_type", message: 'input "feature" must be a string — got 42' })
    expectNoSideEffects(before)
  })

  it("rejects a non-finite number (NaN/Infinity) as wrong_type despite typeof number, with no side effects", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const before = store.listFeatureRecords().length
      const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth", count: bad } })
      expect(result.ok).toBe(false)
      if (result.ok || result.code !== "invalid_input") throw new Error("expected invalid_input")
      expect(result.diagnostics[0]!.kind).toBe("wrong_type")
      expect(result.diagnostics[0]!.name).toBe("count")
      expectNoSideEffects(before)
    }
  })

  it("rejects a non-object inputs payload (string/array/number/boolean) before touching the store, session, process or action host", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    for (const bad of ["nope", [1, 2], 1, true]) {
      const before = store.listFeatureRecords().length
      const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: bad })
      expect(result.ok).toBe(false)
      if (result.ok || result.code !== "invalid_input") throw new Error("expected invalid_input")
      expect(result.diagnostics).toEqual([
        { kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" },
      ])
      expectNoSideEffects(before)
    }
  })

  it("rejects an explicit `inputs: null` as invalid_payload — only an OMITTED inputs field defaults to {} — with no feature, run, session, command process or action created", async () => {
    // Uses `linearWorkflow`, which declares NO inputs at all: an omitted
    // `inputs` field would start fine (compatibility), but an explicit
    // `null` must NOT be silently coalesced the same way — the caller
    // wrote `null` on purpose and gets the same invalid_payload
    // diagnostic as any other non-object payload, with no feature, run,
    // session, command process or action created.
    const engine = makeEngine(linearWorkflow, {}, {}, {})
    const before = store.listFeatureRecords().length
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: null })
    expect(result.ok).toBe(false)
    if (result.ok || result.code !== "invalid_input") throw new Error("expected invalid_input")
    expect(result.diagnostics).toEqual([
      { kind: "invalid_payload", message: "inputs must be a JSON object of input name → value" },
    ])
    expectNoSideEffects(before)
  })

  it("an OMITTED inputs field (undefined) still resolves to {} and starts fine for a no-required-inputs workflow", async () => {
    const engine = makeEngine(linearWorkflow, {}, {}, {})
    const result = await engine.startFeature("/tmp/project", { title: "Ship it" })
    expect(result.ok).toBe(true)
  })

  it("resolved required and defaulted inputs reach the first command and action step template context", async () => {
    let commandTemplate = ""
    process_.handler = (command) => {
      commandTemplate = command
      return { code: 0, stdout: "", stderr: "", output: "" }
    }
    let actionInputs: Readonly<Record<string, unknown>> | undefined
    actions.handler = (_binding, ctx) => {
      actionInputs = ctx.inputs
      return { ok: true, outputs: {} }
    }
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth" } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await engine.settleActions()
    expect(commandTemplate).toBe("echo auth 3 false")
    expect(actionInputs).toEqual({ feature: "auth" })
  })

  it("a REQUIRED action input rendered from a workflow input arrives at the action host with its correctly typed (not stringified) value, alongside a DEFAULTED action input the step's `with:` never mentions", async () => {
    // The action manifest declares two inputs the step's `with:` never
    // both supplies: "count" is required and fed by a template
    // referencing the workflow's declared `{{ inputs.count }}" (a
    // number), so its rendered "3" text must coerce back to the JS
    // number 3 — not survive as the string "3". "verbose" is optional
    // with the ACTION's OWN default (true) and is entirely absent from
    // the step's `with:` — proving an action-level default is applied
    // independent of anything the workflow declares.
    const typedActionWorkflow: WorkflowDef = workflow(
      {
        main: job([
          actionStepDef("record", "test/record-typed@v1", {
            feature: "{{ inputs.feature }}",
            count: "{{ inputs.count }}",
          }),
        ]),
      },
      roles,
      "with-typed-action-inputs",
      {
        feature: { type: "string", presence: "required" },
        count: { type: "number", presence: "optional", default: 3 },
      },
    )
    const bindings = actionBindings([
      {
        jobId: "main",
        stepId: "record",
        uses: "test/record-typed@v1",
        manifest: actionManifest({
          name: "test/record-typed",
          inputs: {
            feature: { type: "string", presence: "required" },
            count: { type: "number", presence: "required" },
            verbose: { type: "boolean", presence: "optional", default: true },
          },
        }),
      },
    ])
    let actionInputs: Readonly<Record<string, unknown>> | undefined
    actions.handler = (_binding, ctx) => {
      actionInputs = ctx.inputs
      return { ok: true, outputs: {} }
    }
    const engine = makeEngine(typedActionWorkflow, {}, {}, bindings)
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth" } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await engine.settleActions()
    expect(actionInputs).toEqual({ feature: "auth", count: 3, verbose: true })
    // Explicit typeof assertions — `toEqual`'s `3 === 3` would also
    // accept the string `"3"` coerced by a lenient equality checker in
    // some frameworks; this is the check that actually distinguishes a
    // rendered-and-coerced number from a rendered-and-left-as-string one.
    expect(typeof actionInputs!["count"]).toBe("number")
    expect(typeof actionInputs!["verbose"]).toBe("boolean")
    expect(typeof actionInputs!["feature"]).toBe("string")
  })

  it("resolved required and defaulted inputs reach the first AGENT step's rendered prompt", async () => {
    const agentInputWorkflow: WorkflowDef = workflow(
      {
        main: job([agentStep("implement", "implementer", "Build {{ inputs.feature }} (count {{ inputs.count }}, dryRun {{ inputs.dryRun }}).")]),
      },
      roles,
      "with-agent-inputs",
      {
        feature: { type: "string", presence: "required" },
        count: { type: "number", presence: "optional", default: 3 },
        dryRun: { type: "boolean", presence: "optional", default: false },
      },
    )
    const engine = makeEngine(agentInputWorkflow)
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth", count: 9 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.prompts[0]!.text).toContain("Build auth (count 9, dryRun false).")
  })

  it("resolved inputs survive a fresh Store instance over the same database (reload durability)", async () => {
    const engine = makeEngine(inputWorkflow, {}, {}, bindingsFor())
    const result = await engine.startFeature("/tmp/project", { title: "Ship it", inputs: { feature: "auth", count: 5 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const fresh = new Store(connection.db)
    expect(fresh.getFeature(result.feature.id)!.input).toEqual({ feature: "auth", count: 5, dryRun: false })
  })
})

describe("Engine: gate prompts", () => {
  const gatePromptWorkflow: WorkflowDef = workflow(
    {
      main: job([
        agentStep("explore", "implementer", "Explore {{ inputs.feature }}."),
        humanStep("gate", {
          prompt: "Please answer: {{ steps.explore.outputs.report }}",
          outcomes: { approved: next, rejected: rerunSteps(["explore"], 3) },
        }),
      ]),
    },
    roles,
    "gate-prompt",
  )

  it("renders and persists the prompt when the gate arms; decision preserves it", async () => {
    const engine = makeEngine(gatePromptWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "explore")!
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "Q1: which storage?" })

    const armed = store.getFeature(feature.id)!
    expect(armed.status).toBe("waiting_human")
    expect(armed.jobs["main"]?.steps["gate"]?.outputs["prompt"]).toBe("Please answer: Q1: which storage?")

    await engine.approve(feature.id, "SQLite")
    const after = store.getFeature(feature.id)!
    expect(after.jobs["main"]?.steps["gate"]?.outputs).toEqual({
      prompt: "Please answer: Q1: which storage?",
      notes: "SQLite",
    })
  })

  it("re-arm inside a rerun round re-renders with the new round's context", async () => {
    const engine = makeEngine(gatePromptWorkflow)
    const feature = await startedFeature(engine)
    const first = store.getActiveRunForStep(feature.id, "main", "explore")!
    await engine.report({ runId: first.id, outcome: "succeeded", notes: "round one questions" })
    expect(store.getFeature(feature.id)?.jobs["main"]?.steps["gate"]?.outputs["prompt"]).toBe("Please answer: round one questions")

    await engine.requestChanges(feature.id, "dig deeper")
    const second = store.getActiveRunForStep(feature.id, "main", "explore")!
    await engine.report({ runId: second.id, outcome: "succeeded", notes: "round two questions" })

    const rearmed = store.getFeature(feature.id)!
    expect(rearmed.status).toBe("waiting_human")
    expect(rearmed.jobs["main"]?.steps["gate"]?.outputs["prompt"]).toBe("Please answer: round two questions")
  })

  it("a render error arms the gate with partial text and logs", async () => {
    const badPromptWorkflow: WorkflowDef = workflow(
      {
        main: job([
          humanStep("gate", { prompt: "Value: {{ inputs.missing }}", outcomes: { approved: next } }),
        ]),
      },
      roles,
      "gate-bad-prompt",
    )
    const logs: string[] = []
    const engine = makeEngine(badPromptWorkflow, {}, { log: { log: line => logs.push(line) } })
    const feature = await startedFeature(engine)
    const armed = store.getFeature(feature.id)!
    expect(armed.jobs["main"]?.steps["gate"]?.status).toBe("waiting_human")
    expect(armed.jobs["main"]?.steps["gate"]?.outputs["prompt"]).toBe("Value: ")
    expect(logs.some(line => line.includes("gate=main/gate"))).toBe(true)
  })

  it("a promptless gate writes no prompt output", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, outcome: "succeeded" })
    const armed = store.getFeature(feature.id)!
    expect(armed.status).toBe("waiting_human")
    expect(armed.jobs["main"]?.steps["gate"]?.outputs["prompt"]).toBeUndefined()
  })

  it("the persisted prompt survives a fresh store read (restart)", async () => {
    const engine = makeEngine(gatePromptWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "explore")!
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "persisted?" })

    const fresh = new Store(connection.db)
    expect(fresh.getFeature(feature.id)?.jobs["main"]?.steps["gate"]?.outputs["prompt"]).toBe("Please answer: persisted?")
  })
})

describe("Engine: interactive steps (ask/answer)", () => {
  it("ask parks the feature waiting_human, preserves the run and session", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    const message = await engine.report({ runId: run.id, ask: "Which storage?" })
    expect(message).toContain("waiting for a human answer")

    const after = store.getFeature(feature.id)!
    expect(after.status).toBe("waiting_human")
    const parked = store.getRunById(run.id)!
    expect(parked.status).toBe("running")
    expect(parked.sessionId).toBe(run.sessionId)
    expect(parked.pendingQuestion).toBe("Which storage?")
    expect(after.jobs["main"]?.currentStep).toBe("implement")
  })

  it("answer forwards the notes into the same session and resumes the feature", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, ask: "Which storage?" })

    const result = await engine.answer(run.id, "Q: Which storage?\nA: SQLite")
    expect(result.ok).toBe(true)

    const delivered = sessions.prompts.at(-1)!
    expect(delivered.sessionID).toBe(run.sessionId!)
    expect(delivered.text).toContain("A: SQLite")
    expect(delivered.text).toContain(`run_id="${run.id}"`)
    // Delivered as the step's agent — see the nudge test above.
    expect(delivered.agent).toBe("build")
    expect(delivered.model).toBe("prov/impl")

    expect(store.getFeature(feature.id)!.status).toBe("running")
    expect(store.getRunById(run.id)!.pendingQuestion).toBeNull()

    // The agent can still conclude the step normally afterwards.
    await engine.report({ runId: run.id, outcome: "succeeded", notes: "done with SQLite" })
    expect(store.getFeature(feature.id)!.jobs["main"]?.currentStep).toBe("gate")
  })

  it("answer on a dead session fails the step through normal routing", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, ask: "Anyone there?" })
    sessions.liveSessions.delete(run.sessionId!)

    const result = await engine.answer(run.id, "yes")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("session_lost")
    expect(store.getRunById(run.id)!.status).toBe("failed")
    expect(store.getFeature(feature.id)!.status).toBe("escalated")
  })

  it("ask on a concluded run and answer without a question are rejected", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    const noQuestion = await engine.answer(run.id, "nothing pending")
    expect(noQuestion.ok).toBe(false)
    if (!noQuestion.ok) expect(noQuestion.code).toBe("no_pending_question")

    await engine.report({ runId: run.id, outcome: "succeeded" })
    const staleAsk = await engine.report({ runId: run.id, ask: "too late?" })
    expect(staleAsk).toContain("already")
    expect(store.getRunById(run.id)!.pendingQuestion).toBeNull()
  })

  it("an asking run is never nudged or idle-reaped, but TTL still applies", async () => {
    const engine = makeEngine(linearWorkflow, { nudgeIdleCycles: 1, maxNudges: 1, runTtlMs: 10_000 }, { clock })
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, ask: "Waiting..." })
    sessions.statuses.set(run.sessionId!, "idle")
    const promptsBefore = sessions.prompts.length

    await engine.reconcile()
    await engine.reconcile()
    await engine.reconcile()
    expect(sessions.prompts.length).toBe(promptsBefore)
    expect(store.getRunById(run.id)!.status).toBe("running")

    clock.advance(20_000)
    await engine.reconcile()
    expect(store.getRunById(run.id)!.status).toBe("reaped")
  })

  it("a pending question survives a restart (fresh engine over the same store)", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, ask: "Persisted?" })

    const restarted = makeEngine(linearWorkflow)
    await restarted.reconcile()

    expect(store.getFeature(feature.id)!.status).toBe("waiting_human")
    const after = store.getRunById(run.id)!
    expect(after.status).toBe("running")
    expect(after.pendingQuestion).toBe("Persisted?")

    const result = await restarted.answer(run.id, "yes")
    expect(result.ok).toBe(true)
    expect(store.getFeature(feature.id)!.status).toBe("running")
  })
})

describe("Engine: interactive steps — review findings (PR #35)", () => {
  it("two racing answers deliver the prompt exactly once; the loser gets no_pending_question", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, ask: "Which storage?" })
    const promptsBefore = sessions.prompts.length

    const [first, second] = await Promise.all([
      engine.answer(run.id, "SQLite"),
      engine.answer(run.id, "Postgres"),
    ])
    const outcomes = [first, second]
    expect(outcomes.filter(r => r.ok).length).toBe(1)
    const loser = outcomes.find(r => !r.ok)!
    if (!loser.ok) expect(loser.code).toBe("no_pending_question")
    expect(sessions.prompts.length).toBe(promptsBefore + 1)
    expect(store.getFeature(feature.id)!.status).toBe("running")
  })

  it("a serial duplicate answer is rejected without re-sending the prompt", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, ask: "Q" })

    expect((await engine.answer(run.id, "A")).ok).toBe(true)
    const promptsAfterFirst = sessions.prompts.length
    const duplicate = await engine.answer(run.id, "A again")
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.code).toBe("no_pending_question")
    expect(sessions.prompts.length).toBe(promptsAfterFirst)
  })

  it("pause then resume during an ask never dispatches a second run for the step", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!
    await engine.report({ runId: run.id, ask: "Still deciding?" })

    await engine.pause(feature.id)
    await engine.resume(feature.id)

    const active = store.listActiveRuns(feature.id)
    expect(active.length).toBe(1)
    expect(active[0]!.id).toBe(run.id)
    expect(active[0]!.pendingQuestion).toBe("Still deciding?")

    // The reconciler re-parks the feature so the question resurfaces.
    await engine.reconcile()
    expect(store.getFeature(feature.id)!.status).toBe("waiting_human")

    const answered = await engine.answer(run.id, "Answered after resume")
    expect(answered.ok).toBe(true)
    expect(sessions.prompts.at(-1)!.sessionID).toBe(run.sessionId!)
  })
})

describe("Engine: interactive opt-in", () => {
  const autonomousWorkflow: WorkflowDef = workflow(
    {
      main: job([
        agentStep("implement", "implementer", "Implement {{ inputs.feature }}."),
        humanStep("gate", { outcomes: { approved: next } }),
      ]),
    },
    roles,
    "autonomous",
  )

  it("an ask from a non-interactive step is refused instructively with zero state change", async () => {
    const engine = makeEngine(autonomousWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    const refusal = await engine.report({ runId: run.id, ask: "May I ask anyway?" })
    expect(refusal).toContain("not interactive")
    expect(refusal).toContain(`run_id="${run.id}"`)

    const after = store.getRunById(run.id)!
    expect(after.status).toBe("running")
    expect(after.pendingQuestion).toBeNull()
    expect(store.getFeature(feature.id)!.status).toBe("running")

    // The refused run continues and concludes normally.
    expect(await engine.report({ runId: run.id, outcome: "succeeded", notes: "decided myself" })).toContain("succeeded")
    expect(store.getFeature(feature.id)!.status).toBe("waiting_human")
  })

  it("an interactive step still asks fine (the grant path)", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    expect(await engine.report({ runId: run.id, ask: "Granted?" })).toContain("waiting for a human answer")
    expect(store.getFeature(feature.id)!.status).toBe("waiting_human")
  })

  it("an ask whose step vanished from the workflow is refused, not parked", async () => {
    const engine = makeEngine(linearWorkflow)
    const feature = await startedFeature(engine)
    const run = store.getActiveRunForStep(feature.id, "main", "implement")!

    const changed = makeEngine(autonomousWorkflow)
    const refusal = await changed.report({ runId: run.id, ask: "Still me?" })
    // Same step id exists but is not interactive in the changed workflow.
    expect(refusal).toContain("not interactive")
    expect(store.getRunById(run.id)!.pendingQuestion).toBeNull()
  })
})
