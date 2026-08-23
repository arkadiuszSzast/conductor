/**
 * Plugin subsystem composition (`preparePluginSubsystem`): the ordering
 * guarantee `startDaemon` depends on — disabled means no scan at all,
 * enabled defers spawning to an explicit `start()` (called once the
 * daemon's own API is ready) and `stop()` reaps supervised backends on
 * shutdown. Driven entirely with fakes — no real scan, no real process.
 */
import { describe, expect, it } from "bun:test"
import { preparePluginSubsystem } from "./src/plugin-runtime.ts"
import type { PluginsFileConfig } from "./src/daemon-config.ts"

function pluginsConfig(overrides: Partial<PluginsFileConfig> = {}): PluginsFileConfig {
  return { enabled: true, disabled: [], paths: [], ...overrides }
}

interface FakeRegistry {
  list(): readonly string[]
}

class FakeSupervisor {
  startCalls: Array<{ plugins: readonly string[]; disabled?: ReadonlySet<string> }> = []
  stopCalls = 0
  async start(plugins: readonly string[], options?: { readonly disabled?: ReadonlySet<string> }): Promise<void> {
    this.startCalls.push({ plugins, ...(options?.disabled !== undefined ? { disabled: options.disabled } : {}) })
  }
  async stop(): Promise<void> {
    this.stopCalls += 1
  }
}

describe("preparePluginSubsystem: disabled", () => {
  it("never scans and start/stop are no-ops", async () => {
    let scanned = false
    const subsystem = await preparePluginSubsystem(pluginsConfig({ enabled: false }), {
      scan: async () => {
        scanned = true
        return { list: () => [] } as FakeRegistry
      },
      createSupervisor: () => new FakeSupervisor(),
      createControl: () => "control",
      disabledControl: () => "disabled-control",
    })
    expect(scanned).toBe(false)
    expect(subsystem.control).toBe("disabled-control")
    await subsystem.start()
    await subsystem.stop()
    expect(scanned).toBe(false)
  })
})

describe("preparePluginSubsystem: enabled lifecycle", () => {
  it("scans up front but defers spawning to start(), and start() forwards the disabled set", async () => {
    const supervisor = new FakeSupervisor()
    const order: string[] = []
    const subsystem = await preparePluginSubsystem(pluginsConfig({ disabled: ["broken-plugin"] }), {
      scan: async () => {
        order.push("scan")
        return { list: () => ["openspec", "broken-plugin"] } as FakeRegistry
      },
      createSupervisor: () => supervisor,
      createControl: () => "control",
      disabledControl: () => "disabled-control",
    })
    expect(order).toEqual(["scan"])
    expect(supervisor.startCalls).toEqual([])

    order.push("ready")
    await subsystem.start()
    order.push("started")

    expect(order).toEqual(["scan", "ready", "started"])
    expect(supervisor.startCalls).toHaveLength(1)
    expect(supervisor.startCalls[0]!.plugins).toEqual(["openspec", "broken-plugin"])
    expect(supervisor.startCalls[0]!.disabled).toEqual(new Set(["broken-plugin"]))
  })

  it("stop() reaps the supervisor even if start() was never called", async () => {
    const supervisor = new FakeSupervisor()
    const subsystem = await preparePluginSubsystem(pluginsConfig(), {
      scan: async () => ({ list: () => [] }) as FakeRegistry,
      createSupervisor: () => supervisor,
      createControl: () => "control",
      disabledControl: () => "disabled-control",
    })
    await subsystem.stop()
    expect(supervisor.stopCalls).toBe(1)
    expect(supervisor.startCalls).toEqual([])
  })

  it("start() then stop() is the shutdown ordering main.ts relies on", async () => {
    const supervisor = new FakeSupervisor()
    const subsystem = await preparePluginSubsystem(pluginsConfig(), {
      scan: async () => ({ list: () => ["openspec"] }) as FakeRegistry,
      createSupervisor: () => supervisor,
      createControl: () => "control",
      disabledControl: () => "disabled-control",
    })
    await subsystem.start()
    await subsystem.stop()
    expect(supervisor.startCalls).toHaveLength(1)
    expect(supervisor.stopCalls).toBe(1)
  })
})
