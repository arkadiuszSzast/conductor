import { describe, expect, it } from "bun:test"
import { ActionHost, CapabilityDeniedError } from "./src/action-host.ts"
import { realProcessRunner } from "./src/process.ts"
import type { ActionHandler } from "./src/action-host.ts"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./src/ports.ts"
import { computeActionDigest } from "@conductor/core"
import type { ActionManifest, ActionRunContext } from "@conductor/core"
import type { ResolvedActionBinding } from "./src/workflow-reservation.ts"

const noopLog = { log: () => {} }

class FakeProcess implements ProcessRunner {
  calls: Array<{ command: readonly string[]; options: ProcessExecOptions }> = []
  handler: ((command: readonly string[], options: ProcessExecOptions) => ProcessExecResult) | null = null
  async exec(command: readonly string[], options: ProcessExecOptions): Promise<ProcessExecResult> {
    this.calls.push({ command, options })
    if (this.handler) return this.handler(command, options)
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
  async shell(command: string, options: ProcessExecOptions): Promise<ProcessExecResult> {
    this.calls.push({ command: [command], options })
    return { code: 0, stdout: "", stderr: "", output: "" }
  }
}

function manifest(overrides: Partial<ActionManifest> = {}): ActionManifest {
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

function binding(m: ActionManifest): ResolvedActionBinding {
  return {
    jobId: "main",
    stepId: "step",
    uses: `${m.name}@v1`,
    manifest: m,
    digest: computeActionDigest(m),
    sourcePath: "/bundled/test-action/action.yaml",
  }
}

function ctx(overrides: Partial<ActionRunContext> = {}): ActionRunContext {
  return {
    featureId: "f1",
    jobId: "main",
    stepId: "step",
    workdir: "/tmp",
    inputs: {},
    capabilities: [],
    ...overrides,
  }
}

describe("ActionHost: in-process dispatch", () => {
  it("dispatches to the handler registered under manifest.run.handler", async () => {
    const process_ = new FakeProcess()
    const seen: ActionRunContext[] = []
    const handler: ActionHandler = async runCtx => {
      seen.push(runCtx)
      return { status: "succeeded", outputs: { greeting: "hi" } }
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const m = manifest()
    const result = await host.execute(binding(m), ctx({ inputs: { name: "world" } }))

    expect(result).toEqual({ ok: true, outputs: { greeting: "hi" } })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.inputs).toEqual({ name: "world" })
  })

  it("classifies an unknown handler as a failed result, not a thrown error", async () => {
    const process_ = new FakeProcess()
    const host = new ActionHost({}, { process: process_, log: noopLog })
    const m = manifest({ run: { kind: "inprocess", handler: "does/not-exist" } })
    const result = await host.execute(binding(m), ctx())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("unknown_handler")
    expect(result.error).toContain("does/not-exist")
  })

  it("a handler that returns status: failed surfaces the error verbatim", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async () => ({ status: "failed", error: "boom" })
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const result = await host.execute(binding(manifest()), ctx())

    expect(result).toEqual({ ok: false, error: "boom" })
  })

  it("a handler that throws is classified rather than propagating", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async () => {
      throw new Error("unexpected")
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const result = await host.execute(binding(manifest()), ctx())

    expect(result).toEqual({ ok: false, error: "unexpected" })
  })
})

describe("ActionHost: capability gating", () => {
  it("denies exec when the manifest did not declare process, with a classified error prefix", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async (_runCtx, deps) => {
      await deps.process.exec(["echo", "hi"], { cwd: "/tmp" })
      return { status: "succeeded", outputs: {} }
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const m = manifest({ capabilities: [] })
    const result = await host.execute(binding(m), ctx({ capabilities: [] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.startsWith("capability_denied:")).toBe(true)
    expect(process_.calls).toHaveLength(0)
  })

  it("denies shell for the same reason", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async (_runCtx, deps) => {
      await deps.process.shell("echo hi", { cwd: "/tmp" })
      return { status: "succeeded", outputs: {} }
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const result = await host.execute(binding(manifest()), ctx({ capabilities: [] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.startsWith("capability_denied:")).toBe(true)
  })

  it("allows exec/shell once the manifest declares process, and the context carries the capability", async () => {
    const process_ = new FakeProcess()
    process_.handler = () => ({ code: 0, stdout: "ok", stderr: "", output: "ok" })
    const handler: ActionHandler = async (_runCtx, deps) => {
      const result = await deps.process.exec(["echo", "hi"], { cwd: "/tmp" })
      return { status: "succeeded", outputs: { stdout: result.stdout } }
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const m = manifest({ capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))

    expect(result).toEqual({ ok: true, outputs: { stdout: "ok" } })
    expect(process_.calls).toHaveLength(1)
  })

  it("CapabilityDeniedError names the offending capability", () => {
    const error = new CapabilityDeniedError("network")
    expect(error.capability).toBe("network")
    expect(error.message).toContain("network")
  })

  it("denies a network git subcommand when only process+git are declared, naming network", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async (_runCtx, deps) => {
      await deps.process.exec(["git", "push", "origin", "main"], { cwd: "/tmp" })
      return { status: "succeeded", outputs: {} }
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const result = await host.execute(binding(manifest({ capabilities: ["process", "git"] })), ctx({ capabilities: ["process", "git"] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("capability_denied")
    expect(result.error).toContain('"network"')
    expect(process_.calls).toHaveLength(0)
  })

  it("allows a local git command with process+git and denies plain git without git capability", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async (_runCtx, deps) => {
      await deps.process.exec(["git", "status"], { cwd: "/tmp" })
      return { status: "succeeded", outputs: {} }
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })

    const allowed = await host.execute(binding(manifest({ capabilities: ["process", "git"] })), ctx({ capabilities: ["process", "git"] }))
    expect(allowed.ok).toBe(true)

    const denied = await host.execute(binding(manifest({ capabilities: ["process"] })), ctx({ capabilities: ["process"] }))
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error).toContain('"git"')
  })

  it("denies git worktree without filesystem and gh without credentials", async () => {
    const process_ = new FakeProcess()
    const worktreeHandler: ActionHandler = async (_runCtx, deps) => {
      await deps.process.exec(["git", "worktree", "list"], { cwd: "/tmp" })
      return { status: "succeeded", outputs: {} }
    }
    const ghHandler: ActionHandler = async (_runCtx, deps) => {
      await deps.process.exec(["gh", "pr", "view", "1"], { cwd: "/tmp" })
      return { status: "succeeded", outputs: {} }
    }
    const host = new ActionHost(
      { "test/worktree": worktreeHandler, "test/gh": ghHandler },
      { process: process_, log: noopLog },
    )

    const worktree = await host.execute(
      binding(manifest({ capabilities: ["process", "git"], run: { kind: "inprocess", handler: "test/worktree" } })),
      ctx({ capabilities: ["process", "git"] }),
    )
    expect(worktree.ok).toBe(false)
    if (!worktree.ok) expect(worktree.error).toContain('"filesystem"')

    const gh = await host.execute(
      binding(manifest({ capabilities: ["process", "network"], run: { kind: "inprocess", handler: "test/gh" } })),
      ctx({ capabilities: ["process", "network"] }),
    )
    expect(gh.ok).toBe(false)
    if (!gh.ok) expect(gh.error).toContain('"credentials"')
  })

  it("shell is opaque and demands process+network", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async (_runCtx, deps) => {
      await deps.process.shell("echo hi", { cwd: "/tmp" })
      return { status: "succeeded", outputs: {} }
    }
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })

    const denied = await host.execute(binding(manifest({ capabilities: ["process"] })), ctx({ capabilities: ["process"] }))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error).toContain('"network"')

    const allowed = await host.execute(
      binding(manifest({ capabilities: ["process", "network"] })),
      ctx({ capabilities: ["process", "network"] }),
    )
    expect(allowed.ok).toBe(true)
  })

  it("every bundled handler's calls are covered by its manifest's declared capabilities", async () => {
    const { bundledHandlers } = await import("./src/actions/bundled.ts")
    const { loadActionRegistry } = await import("./src/action-registry.ts")
    const loaded = await loadActionRegistry({ baseDir: import.meta.dir, bundledPath: "actions" })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const success = (command: readonly string[]) => {
      const stdout = command[0] === "gh" && command[2] === "checks"
        ? '[{"name":"ci","state":"SUCCESS"}]'
        : command[0] === "gh"
          ? '{"number": 7, "url": "https://github.com/o/r/pull/7", "mergeCommit": {"oid": "abc123"}}'
          : "https://github.com/o/r/pull/7\nabc123"
      return { code: 0, stdout, stderr: "", output: stdout }
    }
    for (const entries of Object.values(loaded.value.registry)) {
      for (const entry of entries) {
        const m = entry.manifest
        if (m.run.kind !== "inprocess") continue
        const process_ = new FakeProcess()
        process_.handler = success
        const host = new ActionHost(bundledHandlers, { process: process_, log: noopLog, sleep: async () => {} })
        const inputs: Record<string, unknown> = {}
        for (const [name, def] of Object.entries(m.inputs)) {
          inputs[name] = def.presence === "optional" ? def.default : sampleInput(def.type)
        }
        const result = await host.execute(
          { jobId: "main", stepId: "s", uses: `${m.name}@v1`, manifest: m, digest: computeActionDigest(m), sourcePath: "x" },
          ctx({ inputs, capabilities: m.capabilities }),
        )
        if (!result.ok) {
          expect(result.error).not.toContain("capability_denied")
        }
      }
    }
  })
})

function sampleInput(type: string): unknown {
  switch (type) {
    case "number":
      return 1
    case "boolean":
      return false
    case "string[]":
      return []
    default:
      return "feature-branch"
  }
}

describe("ActionHost: subprocess JSON protocol", () => {
  // A "process" kind action's own command launch goes through the same
  // gated ProcessRunner as any handler's exec/shell call, so its manifest
  // must declare "process" too — hence `capabilities: ["process"]` and a
  // context that carries it below.

  it("pipes the context as JSON on stdin and parses ActionResult JSON from stdout", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    const script = `
      let input = ""
      for await (const chunk of Bun.stdin.stream()) input += Buffer.from(chunk).toString()
      const ctx = JSON.parse(input)
      console.log(JSON.stringify({ status: "succeeded", outputs: { echoedFeatureId: ctx.featureId, inputs: ctx.inputs } }))
    `
    const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ featureId: "f-42", inputs: { x: 1 }, capabilities: ["process"] }))

    expect(result).toEqual({ ok: true, outputs: { echoedFeatureId: "f-42", inputs: { x: 1 } } })
  })

  it("a subprocess reporting status: failed surfaces its error", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    const script = `console.log(JSON.stringify({ status: "failed", error: "subprocess said no" }))`
    const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))

    expect(result).toEqual({ ok: false, error: "subprocess said no" })
  })

  it("a non-zero exit is a failed result carrying the process output", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    const script = `console.error("boom"); process.exit(3)`
    const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("exited 3")
    expect(result.error).toContain("boom")
  })

  it("malformed stdout JSON is a classified failure, not a thrown error", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    const script = `console.log("not json")`
    const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("invalid JSON")
  })

  it("accepts a durable pending ActionResult, carrying nextPollMs and state", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    const script = `console.log(JSON.stringify({ status: "pending", nextPollMs: 5000, state: { deadline: 123 } }))`
    const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))

    expect(result).toEqual({ ok: "pending", nextPollMs: 5000, state: { deadline: 123 } })
  })

  it("accepts a durable pending ActionResult with no state", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    const script = `console.log(JSON.stringify({ status: "pending", nextPollMs: 5000 }))`
    const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))

    expect(result).toEqual({ ok: "pending", nextPollMs: 5000, state: null })
  })

  it("a pending ActionResult with a missing or non-positive nextPollMs is a malformed-result failure", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    for (const payload of ['{"status":"pending"}', '{"status":"pending","nextPollMs":0}', '{"status":"pending","nextPollMs":-5}']) {
      const script = `console.log(JSON.stringify(${payload}))`
      const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
      const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error).toContain("malformed")
    }
  })

  it("a pending ActionResult with a non-object state is a malformed-result failure", async () => {
    const host = new ActionHost({}, { process: realProcessRunner, log: noopLog })
    const script = `console.log(JSON.stringify({ status: "pending", nextPollMs: 5000, state: "not-an-object" }))`
    const m = manifest({ run: { kind: "process", command: ["bun", "-e", script] }, capabilities: ["process"] })
    const result = await host.execute(binding(m), ctx({ capabilities: ["process"] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("malformed")
  })

  it("a process-kind action without the process capability is denied before it ever launches", async () => {
    const process_ = new FakeProcess()
    const host = new ActionHost({}, { process: process_, log: noopLog })
    const m = manifest({ run: { kind: "process", command: ["fake-cmd"] }, capabilities: [] })
    const result = await host.execute(binding(m), ctx({ capabilities: [] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.startsWith("capability_denied:")).toBe(true)
    expect(process_.calls).toHaveLength(0)
  })
})

describe("ActionHost: output contract", () => {
  it("succeeded outputs pass through untouched, including non-string values", async () => {
    const process_ = new FakeProcess()
    const handler: ActionHandler = async () => ({
      status: "succeeded",
      outputs: { count: 3, ok: true, nested: { a: 1 } },
    })
    const host = new ActionHost({ "test/action": handler }, { process: process_, log: noopLog })
    const result = await host.execute(binding(manifest()), ctx())

    expect(result).toEqual({ ok: true, outputs: { count: 3, ok: true, nested: { a: 1 } } })
  })
})
