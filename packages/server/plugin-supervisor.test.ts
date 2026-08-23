import { describe, expect, it } from "bun:test"
import { PluginSupervisor } from "./src/plugin-supervisor.ts"
import type { PluginSupervisorDeps } from "./src/plugin-supervisor.ts"
import type { PluginProcessExit, PluginProcessHandle, PluginProcessSpawnOptions, PluginProcessSpawner, PortAllocator } from "./src/ports.ts"
import type { DiscoveredPlugin, PluginStateKey } from "./src/plugin-registry.ts"
import type { PluginManifest } from "@conductor/core"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

/** Lets a chain of `.then`/`await` continuations settle after resolving a
 *  promise synchronously (`handle.finish(...)`) — several microtask ticks
 *  cover `await x.exited` → the supervise loop's own `await` → any
 *  `Promise.race`/`.then` in between. */
async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

class FakeHandle implements PluginProcessHandle {
  readonly exited: Promise<PluginProcessExit>
  private readonly resolveExit: (exit: PluginProcessExit) => void
  signals: string[] = []
  stderr = ""

  constructor() {
    const d = deferred<PluginProcessExit>()
    this.exited = d.promise
    this.resolveExit = d.resolve
  }

  signal(name: string = "SIGTERM"): void {
    this.signals.push(name)
  }

  recentStderr(): string {
    return this.stderr
  }

  finish(exit: PluginProcessExit): void {
    this.resolveExit(exit)
  }
}

class FakeSpawner implements PluginProcessSpawner {
  calls: Array<{ command: readonly string[]; options: PluginProcessSpawnOptions }> = []
  handles: FakeHandle[] = []
  spawn(command: readonly string[], options: PluginProcessSpawnOptions): PluginProcessHandle {
    this.calls.push({ command, options })
    const handle = new FakeHandle()
    this.handles.push(handle)
    return handle
  }
}

class FakePorts implements PortAllocator {
  private next = 30000
  allocated: number[] = []
  /** When set, the NEXT `allocate()` call rejects with this error instead
   *  of returning a port (once) — drives the m1 "unhandled rejection"
   *  regression test without a real port-allocation failure. */
  rejectNext: Error | null = null
  async allocate(): Promise<number> {
    if (this.rejectNext !== null) {
      const error = this.rejectNext
      this.rejectNext = null
      throw error
    }
    const port = this.next++
    this.allocated.push(port)
    return port
  }
}

const noopLog = { log: () => {} }

/** Controllable sleep: `flush()` resolves every currently pending sleep
 *  call (used to drive backoff/grace waits deterministically) after
 *  first letting the event-exit continuation actually REACH its
 *  `sleep()` call (an async chain: `await handle.exited` resolving is
 *  itself a microtask before the supervisor's loop body resumes). */
class ControllableSleep {
  waiters: Array<{ ms: number; resolve: () => void }> = []
  calls: number[] = []
  sleep = (ms: number): Promise<void> => {
    this.calls.push(ms)
    return new Promise(resolve => {
      this.waiters.push({ ms, resolve })
    })
  }
  async flush(): Promise<void> {
    await settle()
    const pending = this.waiters.splice(0)
    for (const waiter of pending) waiter.resolve()
    await settle()
  }
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "openspec",
    version: 1,
    panel: { title: "OpenSpec" },
    capabilities: [],
    ...overrides,
  }
}

function backendPlugin(overrides: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  return {
    id: "openspec",
    scope: "global",
    dir: "/plugins/openspec",
    manifest: manifest({ backend: { run: ["node", "serve.js"] } }),
    diagnostics: [],
    ...overrides,
  }
}

function staticPlugin(overrides: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  return {
    id: "static-only",
    scope: "global",
    dir: "/plugins/static-only",
    manifest: manifest({ id: "static-only", panel: { title: "Static" } }),
    diagnostics: [],
    ...overrides,
  }
}

function makeSupervisor(overrides: Partial<PluginSupervisorDeps> = {}): {
  supervisor: PluginSupervisor
  spawner: FakeSpawner
  ports: FakePorts
  sleep: ControllableSleep
} {
  const spawner = overrides.spawner as FakeSpawner ?? new FakeSpawner()
  const ports = overrides.ports as FakePorts ?? new FakePorts()
  const sleep = new ControllableSleep()
  const supervisor = new PluginSupervisor(
    { spawner, ports, log: noopLog, sleep: sleep.sleep, ...overrides },
    { conductorUrl: "http://127.0.0.1:4400", conductorToken: "secret-token" },
  )
  return { supervisor, spawner, ports, sleep }
}

describe("PluginSupervisor: spawn env contract", () => {
  it("spawns the backend argv with cwd=plugin dir and the CONDUCTOR_* env contract", async () => {
    const { supervisor, spawner, ports } = makeSupervisor()
    const plugin = backendPlugin()
    await supervisor.start([plugin])

    expect(spawner.calls).toHaveLength(1)
    const call = spawner.calls[0]!
    expect(call.command).toEqual(["node", "serve.js"])
    expect(call.options.cwd).toBe(plugin.dir)
    expect(call.options.env.CONDUCTOR_PLUGIN_PORT).toBe(String(ports.allocated[0]))
    expect(call.options.env.CONDUCTOR_URL).toBe("http://127.0.0.1:4400")
    expect(call.options.env.CONDUCTOR_TOKEN).toBe("secret-token")
    expect(call.options.env.CONDUCTOR_PROJECT_DIR).toBeUndefined()

    const key: PluginStateKey = { scope: "global", id: "openspec" }
    expect(supervisor.stateOf(key)).toBe("running")
    expect(supervisor.portOf(key)).toBe(ports.allocated[0]!)
  })

  it("passes CONDUCTOR_PROJECT_DIR for a project-scoped plugin", async () => {
    const { supervisor, spawner } = makeSupervisor()
    const plugin = backendPlugin({ scope: "project", projectId: "proj-1", projectRoot: "/repo/proj-1" })
    await supervisor.start([plugin])

    expect(spawner.calls[0]!.options.env.CONDUCTOR_PROJECT_DIR).toBe("/repo/proj-1")
  })

  it("omits CONDUCTOR_TOKEN when the daemon has no auth token", async () => {
    const spawner = new FakeSpawner()
    const ports = new FakePorts()
    const sleep = new ControllableSleep()
    const supervisor = new PluginSupervisor(
      { spawner, ports, log: noopLog, sleep: sleep.sleep },
      { conductorUrl: "http://127.0.0.1:4400" },
    )
    await supervisor.start([backendPlugin()])
    expect(spawner.calls[0]!.options.env.CONDUCTOR_TOKEN).toBeUndefined()
  })

  it("never spawns a process for a static-only plugin and reports it running", async () => {
    const { supervisor, spawner } = makeSupervisor()
    const plugin = staticPlugin()
    await supervisor.start([plugin])

    expect(spawner.calls).toHaveLength(0)
    expect(supervisor.stateOf({ scope: "global", id: "static-only" })).toBe("running")
    expect(supervisor.portOf({ scope: "global", id: "static-only" })).toBeNull()
  })

  it("does not start a process for a plugin in the disabled set", async () => {
    const { supervisor, spawner } = makeSupervisor()
    await supervisor.start([backendPlugin()], { disabled: new Set(["openspec"]) })

    expect(spawner.calls).toHaveLength(0)
    expect(supervisor.stateOf({ scope: "global", id: "openspec" })).toBeUndefined()
  })
})

describe("PluginSupervisor: restart backoff", () => {
  it("restarts on unexpected exit with a lengthening backoff sequence up to the cap", async () => {
    const { supervisor, spawner, sleep } = makeSupervisor()
    await supervisor.start([backendPlugin()])
    expect(spawner.calls).toHaveLength(1)

    spawner.handles[0]!.finish({ code: 1, signal: null })
    await sleep.flush()
    expect(sleep.calls[0]).toBe(1_000)
    expect(spawner.calls).toHaveLength(2)
    expect(supervisor.stateOf({ scope: "global", id: "openspec" })).toBe("running")

    spawner.handles[1]!.finish({ code: 1, signal: null })
    await sleep.flush()
    expect(sleep.calls[1]).toBe(2_000)
    expect(spawner.calls).toHaveLength(3)

    spawner.handles[2]!.finish({ code: 1, signal: null })
    await sleep.flush()
    expect(sleep.calls[2]).toBe(4_000)
    expect(spawner.calls).toHaveLength(4)
  })

  it("reports state 'stopped' during the backoff wait between crash and restart", async () => {
    const { supervisor, spawner, sleep } = makeSupervisor()
    await supervisor.start([backendPlugin()])
    const key: PluginStateKey = { scope: "global", id: "openspec" }

    spawner.handles[0]!.finish({ code: 1, signal: null })
    // Let the post-exit continuation run far enough to flip state before
    // the backoff sleep resolves.
    await settle()
    expect(supervisor.stateOf(key)).toBe("stopped")

    await sleep.flush()
    expect(supervisor.stateOf(key)).toBe("running")
  })

  it("parks the plugin as 'error' with a diagnostic once the restart budget is exhausted", async () => {
    const { supervisor, spawner, sleep } = makeSupervisor()
    await supervisor.start([backendPlugin()])
    const key: PluginStateKey = { scope: "global", id: "openspec" }

    // MAX_RESTART_ATTEMPTS = 5: the initial spawn is attempt 1, so 5
    // total crashes (4 restarts + the 5th exhausting the budget) are
    // needed before the 5th exit is the one that parks the plugin.
    for (let i = 0; i < 5; i++) {
      const handle = spawner.handles[spawner.handles.length - 1]!
      if (i === 4) handle.stderr = "fatal: port already in use\n"
      handle.finish({ code: 1, signal: null })
      await sleep.flush()
    }

    expect(spawner.calls).toHaveLength(5)
    expect(supervisor.stateOf(key)).toBe("error")
    const diagnostic = supervisor.diagnosticOf(key)
    expect(diagnostic).not.toBeNull()
    expect(diagnostic!.message).toContain('plugin "openspec" backend crashed 5 time(s)')
    expect(diagnostic!.message).toContain("exit code 1")
    expect(diagnostic!.message).toContain("port already in use")
  })

  it("reports the last signal when the child was killed rather than exiting with a code", async () => {
    const { supervisor, spawner, sleep } = makeSupervisor()
    await supervisor.start([backendPlugin()])

    for (let i = 0; i < 5; i++) {
      spawner.handles[spawner.handles.length - 1]!.finish({ code: null, signal: "SIGSEGV" })
      await sleep.flush()
    }

    const diagnostic = supervisor.diagnosticOf({ scope: "global", id: "openspec" })
    expect(diagnostic!.message).toContain("signal SIGSEGV")
  })

  it("does not restart once stop() has been called mid-backoff", async () => {
    const { supervisor, spawner, sleep } = makeSupervisor()
    await supervisor.start([backendPlugin()])
    spawner.handles[0]!.finish({ code: 1, signal: null })
    await settle()

    const stopPromise = supervisor.stop()
    await sleep.flush()
    await stopPromise

    expect(spawner.calls).toHaveLength(1)
    expect(supervisor.stateOf({ scope: "global", id: "openspec" })).toBe("stopped")
  })

  it("parks the plugin as 'error' instead of an unhandled rejection when the RESTART's spawnOnce fails (m1)", async () => {
    const ports = new FakePorts()
    const { supervisor, spawner, sleep } = makeSupervisor({ ports })
    await supervisor.start([backendPlugin()])
    const key: PluginStateKey = { scope: "global", id: "openspec" }

    // Crash triggers a backoff restart; the restart's own `spawnOnce`
    // call is what fails this time — `launch()`'s fire-and-forget
    // `supervise(...)` promise must not become an unhandled rejection.
    ports.rejectNext = new Error("port allocation exhausted")
    spawner.handles[0]!.finish({ code: 1, signal: null })
    await sleep.flush()

    expect(supervisor.stateOf(key)).toBe("error")
    const diagnostic = supervisor.diagnosticOf(key)
    expect(diagnostic).not.toBeNull()
    expect(diagnostic!.message).toContain("port allocation exhausted")
  })
})

describe("PluginSupervisor: graceful shutdown", () => {
  it("signals SIGTERM and waits for the child to exit on its own", async () => {
    const { supervisor, spawner } = makeSupervisor()
    await supervisor.start([backendPlugin()])
    const handle = spawner.handles[0]!

    const stopPromise = supervisor.stop()
    await settle()
    expect(handle.signals).toEqual(["SIGTERM"])
    handle.finish({ code: 0, signal: null })
    await stopPromise

    expect(handle.signals).toEqual(["SIGTERM"])
    expect(supervisor.stateOf({ scope: "global", id: "openspec" })).toBe("stopped")
  })

  it("force-kills with SIGKILL once the grace period elapses without exit", async () => {
    const { supervisor, spawner, sleep } = makeSupervisor()
    await supervisor.start([backendPlugin()])
    const handle = spawner.handles[0]!

    const stopPromise = supervisor.stop()
    await settle()
    expect(handle.signals).toEqual(["SIGTERM"])

    await sleep.flush()
    expect(handle.signals).toEqual(["SIGTERM", "SIGKILL"])
    handle.finish({ code: null, signal: "SIGKILL" })
    await stopPromise
  })

  it("is idempotent — a second stop() call resolves immediately", async () => {
    const { supervisor, spawner } = makeSupervisor()
    await supervisor.start([backendPlugin()])
    const handle = spawner.handles[0]!
    const first = supervisor.stop()
    await settle()
    handle.finish({ code: 0, signal: null })
    await first
    await supervisor.stop()
  })

  it("never touches a static-only plugin's (nonexistent) process on shutdown", async () => {
    const { supervisor, spawner } = makeSupervisor()
    await supervisor.start([staticPlugin()])
    await supervisor.stop()
    expect(spawner.calls).toHaveLength(0)
  })
})

describe("PluginSupervisor: state change notifications", () => {
  it("fires onStateChange on spawn, exit-into-backoff, restart, and exhaustion", async () => {
    const { supervisor, spawner, sleep } = makeSupervisor()
    const seen: PluginStateKey[] = []
    const unsubscribe = supervisor.onStateChange(key => seen.push(key))

    await supervisor.start([backendPlugin()])
    expect(seen).toHaveLength(1)

    spawner.handles[0]!.finish({ code: 1, signal: null })
    await settle()
    expect(seen.length).toBeGreaterThanOrEqual(2)

    await sleep.flush()
    expect(seen.length).toBeGreaterThanOrEqual(3)

    unsubscribe()
    const countBeforeUnsub = seen.length
    spawner.handles[1]!.finish({ code: 1, signal: null })
    await sleep.flush()
    expect(seen.length).toBe(countBeforeUnsub)
  })

  it("fires on graceful shutdown state transition to stopped", async () => {
    const { supervisor, spawner } = makeSupervisor()
    const seen: PluginStateKey[] = []
    supervisor.onStateChange(key => seen.push(key))
    await supervisor.start([backendPlugin()])
    const countAfterStart = seen.length

    const stopPromise = supervisor.stop()
    await settle()
    spawner.handles[0]!.finish({ code: 0, signal: null })
    await stopPromise

    expect(seen.length).toBeGreaterThan(countAfterStart)
  })
})
