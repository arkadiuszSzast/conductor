import { describe, expect, it } from "bun:test"
import {
  DEFAULT_ACP_DEADLINES,
  FORBIDDEN_INHERITED_ENV_NAMES,
  directoryWithinRoots,
  resolveAcpDeadlines,
  resolveAcpProfileForProject,
  type RunnersConfig,
} from "./src/acp/config.ts"
import { createFakeReportingReadiness, createReportingReadiness } from "./src/runner-execution.ts"
import type { RunnerSafetyStore } from "./src/runner-execution.ts"
import type { AcpProcessHandle, AcpProcessSpawner } from "./src/acp/process.ts"

// ---------------------------------------------------------------------------
// 1.3: config types + narrow dependency interfaces compile against fakes
// ---------------------------------------------------------------------------

function sampleConfig(): RunnersConfig {
  return {
    default: "native",
    projects: { "/srv/work/my-project": "opencode-acp" },
    acp: {
      "opencode-acp": {
        command: "/opt/opencode/bin/opencode",
        args: ["acp", "--cwd", "{directory}"],
        allowedRoots: ["/srv/work/my-project", "/srv/worktrees/my-project"],
        env: { HOME: "/srv/agent-home" },
        inheritEnv: ["PATH"],
        maxConcurrent: 2,
        permissions: { allowKinds: [] },
        bindings: { build: { mode: "build" } },
      },
    },
    reportBridge: { command: "/opt/conductor/conductor", args: ["report-mcp"] },
  }
}

describe("RunnersConfig / resolveAcpProfileForProject", () => {
  it("resolves the exact configured project to its profile", () => {
    const resolved = resolveAcpProfileForProject(sampleConfig(), "/srv/work/my-project")
    expect(resolved?.profileId).toBe("opencode-acp")
    expect(resolved?.profile.command).toBe("/opt/opencode/bin/opencode")
  })

  it("returns null (native) for an unlisted project", () => {
    expect(resolveAcpProfileForProject(sampleConfig(), "/srv/work/other-project")).toBeNull()
  })

  it("returns null when the runners config is entirely absent (native-only)", () => {
    expect(resolveAcpProfileForProject(undefined, "/srv/work/my-project")).toBeNull()
  })

  it("never longest-prefix matches an unrelated project", () => {
    // "/srv/work/my-project-2" is NOT "/srv/work/my-project" nor a child
    // of it — exact-path routing must reject it, not prefix-match it.
    expect(resolveAcpProfileForProject(sampleConfig(), "/srv/work/my-project-2")).toBeNull()
  })
})

describe("directoryWithinRoots", () => {
  const roots = ["/srv/work/my-project", "/srv/worktrees/my-project"]

  it("accepts the exact root and any proper child path", () => {
    expect(directoryWithinRoots("/srv/work/my-project", roots)).toBe(true)
    expect(directoryWithinRoots("/srv/work/my-project/sub/dir", roots)).toBe(true)
    expect(directoryWithinRoots("/srv/worktrees/my-project", roots)).toBe(true)
  })

  it("rejects a sibling directory that merely shares the prefix string", () => {
    expect(directoryWithinRoots("/srv/work/my-project-2", roots)).toBe(false)
    expect(directoryWithinRoots("/srv/workshop", ["/srv/work"])).toBe(false)
  })

  it("rejects an unrelated path entirely", () => {
    expect(directoryWithinRoots("/etc/passwd", roots)).toBe(false)
  })
})

describe("resolveAcpDeadlines", () => {
  it("applies defaults when no overrides are given", () => {
    expect(resolveAcpDeadlines()).toEqual(DEFAULT_ACP_DEADLINES)
  })

  it("overrides only the fields provided, never silently widening turnMs below a request-style timeout", () => {
    const deadlines = resolveAcpDeadlines({ turnMs: 7_200_000 })
    expect(deadlines.turnMs).toBe(7_200_000)
    expect(deadlines.startupMs).toBe(DEFAULT_ACP_DEADLINES.startupMs)
    // The whole point of D7: never the native transport's 10s HTTP
    // request deadline for a long-running ACP turn.
    expect(deadlines.turnMs).toBeGreaterThan(10_000)
  })
})

describe("FORBIDDEN_INHERITED_ENV_NAMES", () => {
  it("names the daemon's own control-plane credentials", () => {
    expect(FORBIDDEN_INHERITED_ENV_NAMES).toContain("CONDUCTOR_ADMIN_TOKEN")
    expect(FORBIDDEN_INHERITED_ENV_NAMES.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 1.3: narrow persistence/process/reporting fakes compile against the
// frozen contracts owners B/C/D depend on before Store/adapter land.
// ---------------------------------------------------------------------------

function fakeRunnerSafetyStore(): RunnerSafetyStore {
  const bindings = new Map<string, { runId: string; transport: "native" | "acp" | "opencode"; profileId: string | null; configDigest: string | null; directory: string; daemonGeneration: number; sessionRef: string | null; remoteSessionId: string | null; processGeneration: number; phase: "active" | "fenced" | "concluded"; createdAt: number; updatedAt: number }>()
  return {
    touchRunActivity() {},
    bindRunnerTransport(input) {
      const existing = bindings.get(input.runId)
      if (existing) return existing
      const record = {
        runId: input.runId,
        transport: input.transport,
        profileId: input.profileId ?? null,
        configDigest: input.configDigest ?? null,
        directory: input.directory,
        daemonGeneration: input.daemonGeneration,
        sessionRef: null,
        remoteSessionId: null,
        processGeneration: 0,
        phase: "active" as const,
        createdAt: 0,
        updatedAt: 0,
      }
      bindings.set(input.runId, record)
      return record
    },
    getRunnerBinding(runId) {
      return bindings.get(runId) ?? null
    },
    setBindingSessionRef(runId, sessionRef, remoteSessionId) {
      const existing = bindings.get(runId)
      if (!existing) return false
      bindings.set(runId, { ...existing, sessionRef, remoteSessionId: remoteSessionId ?? null })
      return true
    },
    claimOperation() {
      throw new Error("not implemented in fake")
    },
    transitionOperationPhase() {
      return false
    },
    getOperation() {
      return null
    },
    findOperation() {
      return null
    },
    listStaleGenerationOperations() {
      return []
    },
    recordFence(input) {
      return { ...input, operationId: input.operationId ?? null, resolvedAt: null, resolutionNote: null, createdAt: 0 }
    },
    getFence() {
      return null
    },
    resolveFence() {
      return false
    },
    issueCredential(input) {
      return { id: "cred-1", runId: input.runId, attempt: input.attempt, processGeneration: input.processGeneration, tokenHash: input.tokenHash, issuedAt: input.issuedAt, expiresAt: input.expiresAt ?? null, revokedAt: null, revocationReason: null }
    },
    findCredentialByHash() {
      return null
    },
    revokeCredential() {
      return false
    },
    revokeCredentialsForRun() {
      return 0
    },
  }
}

describe("RunnerSafetyStore fake compiles and round-trips a binding", () => {
  it("binds a run once and returns the same record on a second bind call", () => {
    const store = fakeRunnerSafetyStore()
    const first = store.bindRunnerTransport({ runId: "run-1", transport: "acp", directory: "/p", daemonGeneration: 1 })
    const second = store.bindRunnerTransport({ runId: "run-1", transport: "acp", directory: "/p", daemonGeneration: 1 })
    expect(second).toEqual(first)
    expect(store.getRunnerBinding("run-1")?.transport).toBe("acp")
  })

  it("setBindingSessionRef attaches an opaque session identity after the fact", () => {
    const store = fakeRunnerSafetyStore()
    store.bindRunnerTransport({ runId: "run-2", transport: "acp", directory: "/p", daemonGeneration: 1 })
    expect(store.setBindingSessionRef("run-2", "acp-session-ref-1")).toBe(true)
    expect(store.getRunnerBinding("run-2")?.sessionRef).toBe("acp-session-ref-1")
  })

  it("setBindingSessionRef fails closed (false) for an unbound run", () => {
    const store = fakeRunnerSafetyStore()
    expect(store.setBindingSessionRef("no-such-run", "ref")).toBe(false)
  })
})

function fakeProcessSpawner(): AcpProcessSpawner {
  return {
    spawn(command, options) {
      let resolveExit: (exit: { code: number | null; signal: string | null }) => void
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        resolveExit = resolve
      })
      const handle: AcpProcessHandle = {
        stdin: new WritableStream(),
        stdout: new ReadableStream(),
        recentStderr: () => "",
        signal(name) {
          resolveExit({ code: null, signal: name ?? "SIGTERM" })
        },
        exited,
      }
      void command
      void options
      return handle
    },
  }
}

describe("AcpProcessSpawner fake compiles against the frozen duplex contract", () => {
  it("spawns a handle whose exited promise resolves after signal()", async () => {
    const spawner = fakeProcessSpawner()
    const handle = spawner.spawn(["/bin/true"], { cwd: "/tmp", env: {} })
    handle.signal("SIGTERM")
    const exit = await handle.exited
    expect(exit.signal).toBe("SIGTERM")
  })
})

describe("ReportingReadinessPort fake", () => {
  it("is not ready until both initialized and tools_listed phases are marked", () => {
    const readiness = createFakeReportingReadiness()
    expect(readiness.isReady("run-1")).toBe(false)
    readiness.markPhase("run-1", "initialized")
    expect(readiness.isReady("run-1")).toBe(false)
    readiness.markPhase("run-1", "tools_listed")
    expect(readiness.isReady("run-1")).toBe(true)
  })

  it("tracks readiness independently per run", () => {
    const readiness = createFakeReportingReadiness()
    readiness.markPhase("run-a", "initialized")
    readiness.markPhase("run-a", "tools_listed")
    expect(readiness.isReady("run-a")).toBe(true)
    expect(readiness.isReady("run-b")).toBe(false)
  })
})

describe("createReportingReadiness — production readiness tracker (task 4.1)", () => {
  it("is structurally identical to the fake: both phases required, tracked independently per run", () => {
    const readiness = createReportingReadiness()
    expect(readiness.isReady("run-1")).toBe(false)
    readiness.markPhase("run-1", "initialized")
    expect(readiness.isReady("run-1")).toBe(false)
    readiness.markPhase("run-1", "tools_listed")
    expect(readiness.isReady("run-1")).toBe(true)
    expect(readiness.isReady("run-2")).toBe(false)
  })

  it("review fix: clear() frees a run's tracked phases — bounded, not an unbounded per-run leak for the daemon's whole lifetime", () => {
    const readiness = createReportingReadiness()
    readiness.markPhase("run-1", "initialized")
    readiness.markPhase("run-1", "tools_listed")
    expect(readiness.isReady("run-1")).toBe(true)
    readiness.clear("run-1")
    expect(readiness.isReady("run-1")).toBe(false)
  })

  it("clear() on a never-tracked or already-cleared run is a harmless no-op", () => {
    const readiness = createReportingReadiness()
    expect(() => readiness.clear("never-seen")).not.toThrow()
    readiness.markPhase("run-1", "initialized")
    readiness.clear("run-1")
    expect(() => readiness.clear("run-1")).not.toThrow()
  })
})
