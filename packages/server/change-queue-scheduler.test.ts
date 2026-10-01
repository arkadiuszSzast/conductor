import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import { Engine } from "./src/engine.ts"
import { WorkflowRegistry } from "./src/workflow-registry.ts"
import { ChangeQueueScheduler, type QueueEngine } from "./src/change-queue-scheduler.ts"
import { ChangeQueueSources } from "./src/change-queue-sources.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner, SessionClient } from "./src/ports.ts"

class FakeSessions implements SessionClient {
  prompts: Array<{ sessionID: string; text: string }> = []
  private counter = 0
  async createSession(): Promise<{ id: string }> {
    return { id: `ses-${++this.counter}` }
  }
  async prompt(input: { sessionID: string; text: string }): Promise<void> {
    this.prompts.push(input)
  }
  async note(): Promise<void> {}
  async abort(): Promise<void> {}
  async sessionExists(): Promise<boolean> {
    return true
  }
  async status(): Promise<"busy" | "idle" | "retry" | "missing"> {
    return "busy"
  }
}

/** Fake git: the "remote" is a mutable set of archived names; `failFetch` simulates an unreachable remote. */
class FakeGit implements ProcessRunner {
  archivedOnRemote = new Set<string>()
  failFetch = false
  fetches = 0
  async exec(command: readonly string[], _options: ProcessExecOptions): Promise<ProcessExecResult> {
    const ok = (stdout = ""): ProcessExecResult => ({ code: 0, stdout, stderr: "", output: stdout })
    if (command[0] !== "git") return ok()
    switch (command[1]) {
      case "symbolic-ref":
        return { code: 1, stdout: "", stderr: "", output: "" }
      case "fetch":
        this.fetches++
        return this.failFetch ? { code: 128, stdout: "", stderr: "unreachable", output: "unreachable" } : ok()
      case "ls-tree":
        return ok([...this.archivedOnRemote].map(name => `openspec/changes/archive/2026-03-01-${name}`).join("\n"))
      default:
        return ok()
    }
  }
  async shell(): Promise<ProcessExecResult> {
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
}

class FakeClock {
  current = 1_700_000_000_000
  now(): number {
    return this.current
  }
  advance(ms: number): void {
    this.current += ms
  }
}

const WORKFLOW = `
name: dogfood
on: [manual]
inputs:
  change_slug: { type: string, required: true }
roles:
  implementer: { agent: build }
jobs:
  main:
    steps:
      - id: implement
        agent:
          role: implementer
          prompt: "Implement {{ inputs.change_slug }}."
`

let directory: string
let project: string
let connection: DatabaseConnection
let store: Store
let sessions: FakeSessions
let git: FakeGit
let clock: FakeClock
let registry: WorkflowRegistry
let engine: Engine
let logs: string[]
const engines: Engine[] = []

function writeChange(name: string, dependsOn?: readonly string[], proposal: string | null = `## Why\nReason for ${name}.\n\n## What Changes\n- stuff\n`): void {
  const dir = join(project, "openspec", "changes", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, ".openspec.yaml"),
    `schema: spec-driven\n${dependsOn !== undefined ? `depends_on: [${dependsOn.join(", ")}]\n` : ""}`,
  )
  if (proposal !== null) writeFileSync(join(dir, "proposal.md"), proposal)
}

function makeEngine(): Engine {
  const created = new Engine(
    {
      store,
      workflows: registry.resolver,
      sessions,
      process: git,
      clock,
      log: { log: () => {} },
      actions: { async execute() { return { ok: true, outputs: {} } } },
    },
    {},
  )
  engines.push(created)
  return created
}

function makeScheduler(overrides: { engine?: QueueEngine; tokens?: () => string } = {}): ChangeQueueScheduler {
  const sources = new ChangeQueueSources({ process: git, log: { log: (line: string) => void logs.push(line) } })
  return new ChangeQueueScheduler({
    store,
    engine: overrides.engine ?? engine,
    sources,
    workflows: registry.resolver,
    clock,
    log: { log: (line: string) => void logs.push(line) },
    ...(overrides.tokens !== undefined ? { newToken: overrides.tokens } : {}),
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-queue-sched-"))
  project = join(directory, "project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "conductor.yaml"), WORKFLOW)
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  clock = new FakeClock()
  store = new Store(connection.db, clock)
  sessions = new FakeSessions()
  git = new FakeGit()
  registry = new WorkflowRegistry()
  const result = registry.register(project)
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  engine = makeEngine()
  logs = []
})

afterEach(async () => {
  await Promise.all(engines.splice(0).map(e => e.settleActions()))
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

const entryOf = (change: string) => store.getQueue(project).entries.find(e => e.change === change && e.status !== "removed")!
const featureOf = (change: string) => store.getFeature(entryOf(change).featureId!)!
const features = () => store.listFeatures({})

/** Fails the active run of the change's feature: the single-step job fails and the feature escalates. */
async function escalate(change: string): Promise<void> {
  const feature = featureOf(change)
  const run = store.getActiveRun(feature.id)!
  await engine.report({ runId: run.id, outcome: "failed" })
  expect(store.getFeature(feature.id)!.status).toBe("escalated")
}

describe("ChangeQueueScheduler", () => {
  it("starts the next change without a human once its dependency has merged", async () => {
    writeChange("a")
    writeChange("b", ["a"])
    const scheduler = makeScheduler()
    store.addEntry(project, "a")
    store.addEntry(project, "b")

    const first = await scheduler.tick()
    expect(first.projects[0]!.started.map(s => s.change)).toEqual(["a"])
    expect(entryOf("a").status).toBe("running")
    expect(entryOf("b").status).toBe("waiting")
    expect(entryOf("b").reason).toBe("waiting for `a`")

    // a's feature finishes but is not merged yet: b keeps waiting.
    const featureA = featureOf("a")
    await engine.report({ runId: store.getActiveRun(featureA.id)!.id, outcome: "succeeded" })
    expect(store.getFeature(featureA.id)!.status).toBe("done")
    await scheduler.tick()
    expect(entryOf("b").status).toBe("waiting")
    expect(entryOf("b").reason).toContain("`a`")

    // The PR merges overnight.
    git.archivedOnRemote.add("a")
    const second = await scheduler.tick()
    expect(second.projects[0]!.started.map(s => s.change)).toEqual(["b"])
    expect(entryOf("a").status).toBe("merged")
    expect(entryOf("b").status).toBe("running")
    expect(features()).toHaveLength(2)
  })

  it("starts the feature with the title, description and change input the panel would send", async () => {
    writeChange("quest-outcomes")
    store.addEntry(project, "quest-outcomes")
    await makeScheduler().tick()
    const feature = featureOf("quest-outcomes")
    expect(feature.title).toBe("Quest Outcomes")
    expect(feature.description).toBe("Reason for quest-outcomes.")
    expect(feature.input).toEqual({ change_slug: "quest-outcomes" })
    expect(feature.workflow).toBe("dogfood")
  })

  it("runs independent changes in parallel up to the limit", async () => {
    writeChange("a")
    writeChange("b")
    store.addEntry(project, "a")
    store.addEntry(project, "b")
    store.setQueueSettings(project, { parallelism: 2 })
    const result = await makeScheduler().tick()
    expect(result.projects[0]!.started.map(s => s.change)).toEqual(["a", "b"])
    expect(features()).toHaveLength(2)
  })

  it("holds back a ready change when the parallelism limit is reached", async () => {
    writeChange("a")
    writeChange("b")
    store.addEntry(project, "a")
    store.addEntry(project, "b")
    const scheduler = makeScheduler()
    const result = await scheduler.tick()
    expect(result.projects[0]!.started.map(s => s.change)).toEqual(["a"])
    expect(entryOf("b").status).toBe("waiting")
    expect(entryOf("b").reason).toBe("parallelism limit reached (1)")
    expect(features()).toHaveLength(1)

    store.setQueueSettings(project, { parallelism: 2 })
    expect((await scheduler.tick()).projects[0]!.started.map(s => s.change)).toEqual(["b"])
  })

  it("a paused queue starts nothing and says why; running features continue", async () => {
    writeChange("a")
    writeChange("b")
    store.addEntry(project, "a")
    store.addEntry(project, "b")
    store.setQueueSettings(project, { parallelism: 2 })
    store.setQueueSettings(project, { paused: true })
    const scheduler = makeScheduler()
    const result = await scheduler.tick()
    expect(result.projects[0]!.started).toEqual([])
    expect(features()).toHaveLength(0)
    expect(entryOf("a").reason).toBe("queue paused")

    store.setQueueSettings(project, { paused: false })
    await scheduler.tick()
    expect(features()).toHaveLength(2)

    store.addEntry(project, "c")
    writeChange("c")
    store.setQueueSettings(project, { paused: true, parallelism: 3 })
    await scheduler.tick()
    expect(features()).toHaveLength(2)
    expect(entryOf("c").reason).toBe("queue paused")
    expect(featureOf("a").status).toBe("running")
  })

  it("keeps scheduling unrelated work while a dependency is escalated, and blocks only its dependants", async () => {
    writeChange("quest-outcomes")
    writeChange("quest-equipment-items", ["quest-outcomes"])
    writeChange("authoring-condition-editor")
    store.addEntry(project, "quest-outcomes")
    store.addEntry(project, "quest-equipment-items")
    store.addEntry(project, "authoring-condition-editor")
    store.setQueueSettings(project, { parallelism: 2 })
    const scheduler = makeScheduler()

    expect((await scheduler.tick()).projects[0]!.started.map(s => s.change)).toEqual([
      "quest-outcomes",
      "authoring-condition-editor",
    ])
    await escalate("quest-outcomes")
    // The unrelated change finishes, freeing a slot while quest-outcomes stays stuck.
    const unrelated = featureOf("authoring-condition-editor")
    await engine.report({ runId: store.getActiveRun(unrelated.id)!.id, outcome: "succeeded" })
    writeChange("another-independent")
    store.addEntry(project, "another-independent")

    const result = await scheduler.tick()
    expect(result.projects[0]!.started.map(s => s.change)).toEqual(["another-independent"])
    expect(entryOf("quest-outcomes").status).toBe("escalated")
    expect(entryOf("quest-equipment-items").status).toBe("blocked")
    expect(entryOf("quest-equipment-items").reason).toBe("blocked: `quest-outcomes` escalated")
  })

  it("recovery unblocks the dependants, which start after the dependency merges", async () => {
    writeChange("quest-outcomes")
    writeChange("quest-equipment-items", ["quest-outcomes"])
    store.addEntry(project, "quest-outcomes")
    store.addEntry(project, "quest-equipment-items")
    store.setQueueSettings(project, { parallelism: 2 })
    const scheduler = makeScheduler()
    await scheduler.tick()
    await escalate("quest-outcomes")
    await scheduler.tick()
    expect(entryOf("quest-equipment-items").status).toBe("blocked")

    const featureId = featureOf("quest-outcomes").id
    const recovered = await engine.recover(featureId, { notes: "fixed the environment", target: { jobId: "main", stepId: "implement" } })
    expect(recovered.ok).toBe(true)
    expect(store.getFeature(featureId)!.status).toBe("running")
    await scheduler.tick()
    expect(entryOf("quest-outcomes").status).toBe("running")
    expect(entryOf("quest-equipment-items").status).toBe("waiting")
    expect(entryOf("quest-equipment-items").reason).toBe("waiting for `quest-outcomes`")

    await engine.report({ runId: store.getActiveRun(featureId)!.id, outcome: "succeeded" })
    git.archivedOnRemote.add("quest-outcomes")
    expect((await scheduler.tick()).projects[0]!.started.map(s => s.change)).toEqual(["quest-equipment-items"])
    expect(entryOf("quest-outcomes").status).toBe("merged")
    expect(entryOf("quest-outcomes").reason).toBeNull()
    expect(entryOf("quest-equipment-items").status).toBe("running")
  })

  it("a restart right after the feature was created links it instead of starting a second one", async () => {
    writeChange("a")
    store.addEntry(project, "a")
    // Crash window: claimed and the feature exists, but the link never happened.
    const entry = entryOf("a")
    expect(store.claimEntry(entry.id, "crashed-token", clock.now())).toBe(true)
    clock.advance(10)
    const started = await engine.startFeature(project, { title: "A", inputs: { change_slug: "a" } })
    expect(started.ok).toBe(true)

    const restarted = makeScheduler()
    const result = await restarted.tick()
    expect(result.projects[0]!.started).toEqual([])
    expect(features()).toHaveLength(1)
    expect(entryOf("a").status).toBe("running")
    expect(entryOf("a").featureId).toBe(features()[0]!.id)
    await restarted.tick()
    expect(features()).toHaveLength(1)

    // Once the linked feature's change is archived on the remote the entry becomes merged.
    git.archivedOnRemote.add("a")
    await restarted.tick()
    expect(entryOf("a").status).toBe("merged")
    expect(features()).toHaveLength(1)
  })

  it("a restart after a crash before the feature was created releases the claim and starts it once", async () => {
    writeChange("a")
    store.addEntry(project, "a")
    store.claimEntry(entryOf("a").id, "crashed-token", clock.now())
    const result = await makeScheduler().tick()
    expect(result.projects[0]!.started.map(s => s.change)).toEqual(["a"])
    expect(features()).toHaveLength(1)
  })

  it("reconciles a stale starting entry from the same process on the next pass", async () => {
    writeChange("a")
    store.addEntry(project, "a")
    const scheduler = makeScheduler()
    await scheduler.tick() // first pass: recovery has already run once for this process
    store.addEntry(project, "b")
    writeChange("b")
    store.setQueueSettings(project, { parallelism: 2 })
    // A claim left behind in-process (e.g. a failed release): the feature exists, the link never landed.
    expect(store.claimEntry(entryOf("b").id, "stale-token", clock.now())).toBe(true)
    clock.advance(10)
    const orphan = await engine.startFeature(project, { title: "B", inputs: { change_slug: "b" } })
    expect(orphan.ok).toBe(true)
    expect(entryOf("b").status).toBe("starting")

    const result = await scheduler.tick()
    expect(result.projects[0]!.started).toEqual([])
    expect(entryOf("b").status).toBe("running")
    expect(entryOf("b").featureId).toBe(orphan.ok ? orphan.feature.id : null)
    expect(features()).toHaveLength(2)

    // And a stale claim with no feature is released and started on that same pass.
    writeChange("c")
    store.addEntry(project, "c")
    store.setQueueSettings(project, { parallelism: 3 })
    expect(store.claimEntry(entryOf("c").id, "stale-2", clock.now())).toBe(true)
    expect((await scheduler.tick()).projects[0]!.started.map(s => s.change)).toEqual(["c"])
    expect(features()).toHaveLength(3)
  })

  it("does not start a change twice across overlapping and repeated passes", async () => {
    writeChange("a")
    store.addEntry(project, "a")
    const scheduler = makeScheduler()
    const [one, two] = [scheduler.tick(), scheduler.tick()]
    expect(one).toBe(two)
    await one
    await scheduler.tick()
    await makeScheduler().tick()
    expect(features()).toHaveLength(1)
  })

  it("only visits projects that have live queue entries", async () => {
    const other = join(directory, "other")
    mkdirSync(other)
    writeFileSync(join(other, "conductor.yaml"), WORKFLOW)
    registry.register(other)
    const result = await makeScheduler().tick()
    expect(result.projects).toEqual([])
    expect(git.fetches).toBe(0)
    writeChange("a")
    store.addEntry(project, "a")
    await makeScheduler().tick()
    expect(git.fetches).toBe(1)
  })

  it("marks an entry invalid, with the diagnostic, when its .openspec.yaml is edited into a cycle", async () => {
    writeChange("a", ["b"])
    writeChange("b", ["a"])
    store.addEntry(project, "a")
    const result = await makeScheduler().tick()
    expect(result.projects[0]!.started).toEqual([])
    expect(entryOf("a").status).toBe("invalid")
    expect(entryOf("a").reason).toContain("dependency cycle")
    expect(features()).toHaveLength(0)
  })

  it("a malformed depends_on makes the entry invalid instead of crashing the pass", async () => {
    writeChange("a")
    writeChange("b")
    writeFileSync(join(project, "openspec/changes/a/.openspec.yaml"), "depends_on: not-a-list\n")
    store.addEntry(project, "a")
    store.addEntry(project, "b")
    const result = await makeScheduler().tick()
    expect(entryOf("a").status).toBe("invalid")
    expect(entryOf("a").reason).toContain("depends_on must be a list")
    expect(result.projects[0]!.started.map(s => s.change)).toEqual(["b"])
  })

  describe("fetch failure", () => {
    it("with a last known merged set, keeps going on it", async () => {
      writeChange("a")
      writeChange("b", ["a"])
      writeChange("c")
      store.addEntry(project, "a")
      store.addEntry(project, "b")
      store.setQueueSettings(project, { parallelism: 2 })
      git.archivedOnRemote.add("a")
      const scheduler = makeScheduler()
      await scheduler.tick()
      expect(entryOf("a").status).toBe("merged")

      git.failFetch = true
      store.addEntry(project, "c")
      const result = await scheduler.tick()
      expect(result.projects[0]!.skipped).toBeUndefined()
      expect(entryOf("b").status).toBe("running")
      expect(logs.some(line => line.includes("last known merged set"))).toBe(true)
    })

    it("with no known merged set, starts nothing for the project and does not throw", async () => {
      writeChange("a")
      store.addEntry(project, "a")
      git.failFetch = true
      const result = await makeScheduler().tick()
      expect(result.projects[0]!.skipped).toContain("merged set unknown")
      expect(result.projects[0]!.started).toEqual([])
      expect(entryOf("a").status).toBe("waiting")
      expect(features()).toHaveLength(0)

      git.failFetch = false
      expect((await makeScheduler().tick()).projects[0]!.started.map(s => s.change)).toEqual(["a"])
    })
  })

  describe("startFeature failure", () => {
    it("parks the entry as invalid with the start error and does not loop-start it every pass", async () => {
      writeChange("a")
      writeChange("b")
      store.addEntry(project, "a")
      store.addEntry(project, "b")
      store.setQueueSettings(project, { parallelism: 2 })
      let calls = 0
      const failing: QueueEngine = {
        async startFeature(dir, input) {
          calls++
          if (input.title === "A") throw new Error("boom: runner exploded")
          return engine.startFeature(dir, input)
        },
      }
      const scheduler = makeScheduler({ engine: failing })

      const first = await scheduler.tick()
      expect(first.projects[0]!.failed).toEqual([
        expect.objectContaining({ change: "a", outcome: "invalid", message: expect.stringContaining("boom: runner exploded") }),
      ])
      expect(first.projects[0]!.started.map(s => s.change)).toEqual(["b"])
      expect(entryOf("a").status).toBe("invalid")
      expect(entryOf("a").reason).toContain("boom: runner exploded")
      expect(entryOf("a").claimToken).toBeNull()

      await scheduler.tick()
      await scheduler.tick()
      expect(calls).toBe(2)
      expect(entryOf("a").status).toBe("invalid")
      expect(features()).toHaveLength(1)

      // The operator fixes the cause, removes the entry and queues the change again.
      expect(store.removeEntry(entryOf("a").id).removed).toBe(true)
      store.addEntry(project, "a")
      const again = await makeScheduler().tick()
      expect(again.projects[0]!.started.map(s => s.change)).toEqual(["a"])
    })

    it("records the start failure in one transaction: the claim is never released as waiting first", async () => {
      writeChange("a")
      store.addEntry(project, "a")
      const failing: QueueEngine = {
        async startFeature() {
          throw new Error("boom")
        },
      }
      await makeScheduler({ engine: failing }).tick()
      expect(entryOf("a").status).toBe("invalid")
      expect(store.getQueueTransitions(entryOf("a").id).map(t => t.toStatus)).toEqual(["waiting", "starting", "invalid"])
    })

    it("records an engine refusal (invalid_input) as the entry's reason", async () => {
      writeFileSync(
        join(project, "conductor.yaml"),
        WORKFLOW.replace(
          "change_slug: { type: string, required: true }",
          "change_slug: { type: string, required: true }\n  ticket: { type: string, required: true }",
        ),
      )
      expect(registry.reload(project).ok).toBe(true)
      writeChange("a")
      store.addEntry(project, "a")
      const result = await makeScheduler().tick()
      expect(result.projects[0]!.failed[0]!.outcome).toBe("invalid")
      expect(entryOf("a").status).toBe("invalid")
      expect(entryOf("a").reason).toContain("invalid_input")
      expect(features()).toHaveLength(0)
      await makeScheduler().tick()
      expect(features()).toHaveLength(0)
    })

    it("links a feature that startFeature created before throwing", async () => {
      writeChange("a")
      store.addEntry(project, "a")
      const throwsAfterCreate: QueueEngine = {
        async startFeature(dir, input) {
          await engine.startFeature(dir, input)
          throw new Error("late failure")
        },
      }
      const result = await makeScheduler({ engine: throwsAfterCreate }).tick()
      expect(result.projects[0]!.started.map(s => s.change)).toEqual(["a"])
      expect(entryOf("a").status).toBe("running")
      expect(features()).toHaveLength(1)
    })

    it("releases the claim for a retry when the project has no workflow at start time", async () => {
      writeChange("a")
      store.addEntry(project, "a")
      const gone: QueueEngine = {
        async startFeature() {
          return { ok: false, code: "project_not_configured", message: "gone" }
        },
      }
      const result = await makeScheduler({ engine: gone }).tick()
      expect(result.projects[0]!.failed[0]!.outcome).toBe("released")
      expect(entryOf("a").status).toBe("waiting")
      expect((await makeScheduler().tick()).projects[0]!.started.map(s => s.change)).toEqual(["a"])
    })
  })

  it("marks an entry invalid, and never claims it, when the workflow declares no change_slug/change input", async () => {
    writeFileSync(
      join(project, "conductor.yaml"),
      WORKFLOW.replace("change_slug: { type: string, required: true }", "ticket: { type: string, required: true }").replace("inputs.change_slug", "inputs.ticket"),
    )
    expect(registry.reload(project).ok).toBe(true)
    writeChange("a")
    store.addEntry(project, "a")
    const result = await makeScheduler().tick()
    expect(result.projects[0]!.started).toEqual([])
    expect(entryOf("a").status).toBe("invalid")
    expect(entryOf("a").reason).toContain("the workflow declares no `change_slug`/`change` string input")
    expect(entryOf("a").state).toMatchObject({ kind: "invalid", diagnostics: [{ kind: "not-startable" }] })
    expect(store.getQueueTransitions(entryOf("a").id).map(t => t.toStatus)).not.toContain("starting")
    expect(features()).toHaveLength(0)

    // Declaring the input makes it startable on the next pass (the diagnosis is not sticky).
    writeFileSync(join(project, "conductor.yaml"), WORKFLOW)
    expect(registry.reload(project).ok).toBe(true)
    expect((await makeScheduler().tick()).projects[0]!.started.map(s => s.change)).toEqual(["a"])
  })

  it("a removed entry whose feature is still running keeps holding its parallelism slot", async () => {
    writeChange("a")
    writeChange("b")
    store.addEntry(project, "a")
    const scheduler = makeScheduler()
    await scheduler.tick()
    const featureId = featureOf("a").id
    // Make the entry removable while its feature is still non-terminal (abandon, remove, re-open is not possible),
    // so model the planner input directly through the store: the feature stays running.
    connection.db.run("UPDATE feature SET status = 'abandoned' WHERE id = ?", [featureId])
    expect(store.removeEntry(entryOf("a").id).removed).toBe(true)
    connection.db.run("UPDATE feature SET status = 'running' WHERE id = ?", [featureId])
    store.addEntry(project, "b")
    const result = await scheduler.tick()
    expect(result.projects[0]!.started).toEqual([])
    expect(entryOf("b").reason).toBe("parallelism limit reached (1)")
  })

  it("does not feed merged entries with a terminal or missing feature back into planning", async () => {
    writeChange("a")
    writeChange("b")
    store.addEntry(project, "a")
    const scheduler = makeScheduler()
    await scheduler.tick()
    const featureId = featureOf("a").id
    await engine.report({ runId: store.getActiveRun(featureId)!.id, outcome: "succeeded" })
    git.archivedOnRemote.add("a")
    await scheduler.tick()
    const merged = entryOf("a")
    expect(merged.status).toBe("merged")

    // A merged entry's row is no longer rewritten by later passes: drop its stored
    // state and see that planning does not touch it again.
    connection.db.run("UPDATE change_queue_entry SET state = NULL, reason = 'untouched' WHERE id = ?", [merged.id])
    store.addEntry(project, "b")
    await scheduler.tick()
    expect(store.getQueueEntry(merged.id)).toMatchObject({ status: "merged", reason: "untouched", state: null })
  })

  it("marks an entry invalid when its change has no proposal.md", async () => {
    writeChange("a", undefined, null)
    store.addEntry(project, "a")
    await makeScheduler().tick()
    expect(entryOf("a").status).toBe("invalid")
    expect(entryOf("a").reason).toContain("no proposal.md")
  })
})
