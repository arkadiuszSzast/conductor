/**
 * Composes the plugin subsystem for `startDaemon`: decides whether to
 * scan/supervise at all (`plugins.enabled`), and exposes an explicit
 * `start`/`stop` pair so the caller controls WHEN plugins spawn relative
 * to the daemon's own readiness (after the API is bound, so
 * `CONDUCTOR_URL` answers) and WHEN they are reaped (daemon shutdown).
 * Kept separate from `main.ts`'s real filesystem/process wiring so the
 * sequencing is unit-testable with fakes — no real scan, no real
 * process.
 */

import type { PluginsFileConfig } from "./daemon-config.ts"

export interface PluginSubsystemRegistry {
  list(): readonly unknown[]
}

export interface PluginSubsystemSupervisor {
  start(plugins: readonly unknown[], options?: { readonly disabled?: ReadonlySet<string> }): Promise<void>
  stop(): Promise<void>
}

export interface PluginSubsystemPorts<TRegistry extends PluginSubsystemRegistry, TSupervisor extends PluginSubsystemSupervisor, TControl> {
  /** Discovers plugins. Only invoked when `plugins.enabled` — the
   *  subsystem must never touch the filesystem while disabled. */
  readonly scan: () => Promise<TRegistry>
  readonly createSupervisor: () => TSupervisor
  readonly createControl: (registry: TRegistry, supervisor: TSupervisor) => TControl
  /** `ApiDeps.plugins` stand-in used when the subsystem is disabled. */
  readonly disabledControl: () => TControl
}

export interface PluginSubsystem<TControl> {
  readonly control: TControl
  /** Spawns supervised backends. Call once the daemon's own API is bound and answering. */
  start(): Promise<void>
  /** Reaps any spawned backends. Idempotent, safe even if `start` was never called. */
  stop(): Promise<void>
}

const noopAsync = async (): Promise<void> => {}

/**
 * Disabled: no scan, no supervisor — `start`/`stop` are no-ops.
 * Enabled: scans once up front (so `control.listing()` has data
 * immediately after `startApiServer` wires it in), and defers actually
 * spawning backends to the returned `start()`.
 */
export async function preparePluginSubsystem<
  TRegistry extends PluginSubsystemRegistry,
  TSupervisor extends PluginSubsystemSupervisor,
  TControl,
>(config: PluginsFileConfig, ports: PluginSubsystemPorts<TRegistry, TSupervisor, TControl>): Promise<PluginSubsystem<TControl>> {
  if (!config.enabled) {
    return { control: ports.disabledControl(), start: noopAsync, stop: noopAsync }
  }

  const registry = await ports.scan()
  const supervisor = ports.createSupervisor()
  const control = ports.createControl(registry, supervisor)
  const disabledIds = new Set(config.disabled)

  return {
    control,
    start: () => supervisor.start(registry.list(), { disabled: disabledIds }),
    stop: () => supervisor.stop(),
  }
}
