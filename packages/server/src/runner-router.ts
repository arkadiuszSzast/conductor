/**
 * `runner-router.ts` — immutable binding-based routing (design.md D1/D3,
 * task 5.1). Chooses an explicitly configured project route for NEW
 * work only; every subsequent operation for an existing run reads its
 * PERSISTED binding (`RunnerSafetyStore.getRunnerBinding`) instead —
 * config changes after dispatch never reroute an existing attempt
 * (runner-execution-safety spec: "Transport selection changes SHALL NOT
 * reroute existing attempts").
 */

import { directoryWithinRoots, resolveAcpProfileForProject } from "./acp/config.ts"
import type { AcpProfileConfig, RunnersConfig } from "./acp/config.ts"
import type { RunnerTransport, ReportingReadinessPort } from "./runner-execution.ts"
import type { Store } from "./store.ts"
import type { Clock, SessionClient } from "./ports.ts"
import { ManagedSessions } from "./acp/sessions.ts"
import { realAcpProcessSpawner } from "./acp/process.ts"
import { issueRunCredential } from "./run-auth.ts"

export function composeManagedRunners(config: RunnersConfig, store: Store, clock: Clock, readiness: ReportingReadinessPort, url: () => string, env: Readonly<Record<string, string | undefined>>, observe: (id: string) => void) {
  const generation = Math.max(clock.now(), ...store.listFeatures({}).flatMap(f => store.listRuns(f.id).map(r => (store.getRunnerBinding(r.id)?.daemonGeneration ?? 0) + 1)))
  const reservations = new Map<string, ManagedSessions>()
  const profiles = new Map(Object.entries(config.acp).map(([id, profile]) => {
    const selectedEnv: Record<string, string> = {}
    for (const name of profile.inheritEnv ?? []) if (!name.startsWith("CONDUCTOR_") && env[name] !== undefined) selectedEnv[name] = env[name]!
    for (const [name, value] of Object.entries(profile.env ?? {})) if (!name.startsWith("CONDUCTOR_")) selectedEnv[name] = value
    return [id, new ManagedSessions({ ...profile, env: selectedEnv, spawner: realAcpProcessSpawner, store, generation, readiness,
      activityNow: () => clock.now(),
      onOperationObserved: id => observe(id),
      reportBridge: runId => {
        const run = store.getRunById(runId)!
        const binding = store.getRunnerBinding(runId)!
        const { token } = issueRunCredential(store, { runId, attempt: run.attempt, processGeneration: binding.processGeneration, nowMs: clock.now() })
        return { command: config.reportBridge.command, args: [...config.reportBridge.args], env: { CONDUCTOR_RUN_URL: url(), CONDUCTOR_RUN_ID: runId, CONDUCTOR_RUN_TOKEN: token } }
      },
    })] as const
  }))
  const bySession = (id: string): ManagedSessions => {
    for (const f of store.listFeatures({})) for (const run of store.listRuns(f.id)) {
      const binding = store.getRunnerBinding(run.id)
      if (binding?.transport === "acp" && binding.sessionRef === id) {
        const owner = profiles.get(binding.profileId!)
        if (owner) return owner
      }
    }
    throw new Error("ACP binding owner unavailable")
  }
  const sessions: SessionClient = {
    async prepare(input) {
      const owner = profiles.get(config.projects[input.projectDir]!)
      if (!owner) return { ok: false, reason: "incompatible", diagnostic: "ACP project profile unavailable" }
      const result = await owner.prepare(input)
      if (result.ok) reservations.set(result.reservationId, owner)
      return result
    },
    async createSession(input) {
      const owner = input.reservationId && reservations.get(input.reservationId)
      if (!owner) throw new Error("ACP reservation unavailable")
      return owner.createSession(input)
    },
    prompt: input => bySession(input.sessionID).prompt(input),
    note: input => bySession(input.sessionID).note(input),
    abort: id => bySession(id).abort(id),
    status: async id => { try { return await bySession(id).status(id) } catch { return "unknown" } },
    sessionExists: async id => { try { return await bySession(id).sessionExists(id) } catch { return false } },
  }
  return { sessions, generation,
    async releaseReservation(id: string) { await reservations.get(id)?.releaseReservation(id); reservations.delete(id) },
    async cleanupRun(runId: string, sessionId: string | null) {
      const evidence = await profiles.get(store.getRunnerBinding(runId)?.profileId ?? "")?.cleanupRun(runId, sessionId) ?? "unconfirmed" as const
      // Readiness tracking for a run whose ACP session just concluded
      // cleanup can never matter again (D8's credential-revocation
      // lifecycle moment, same trigger) — free it here rather than
      // leaking one Set entry per run for the daemon's whole lifetime.
      if ("clear" in readiness && typeof readiness.clear === "function") readiness.clear(runId)
      return evidence
    },
    async stop() { await Promise.all([...profiles.values()].map(owner => owner.stop())) },
  }
}

export type RouteDecision =
  | { readonly transport: "native" }
  | { readonly transport: "acp"; readonly profileId: string; readonly profile: AcpProfileConfig }
  | { readonly transport: "acp_misconfigured"; readonly reason: string }

/**
 * Routes a NEW dispatch (no existing binding). `directory` MUST already
 * be the canonical (symlink-resolved) worktree path — this function does
 * NOT canonicalize; `packages/server/src/acp/process.ts`'s
 * `validateAcpSpawn` is the actual security boundary for the spawn
 * itself, this is only the routing decision.
 */
export function routeNewDispatch(config: RunnersConfig | undefined, projectDir: string, directory: string): RouteDecision {
  const resolved = resolveAcpProfileForProject(config, projectDir)
  if (!resolved) return { transport: "native" }
  if (!directoryWithinRoots(directory, resolved.profile.allowedRoots)) {
    return {
      transport: "acp_misconfigured",
      reason: `directory "${directory}" is outside configured allowedRoots for profile "${resolved.profileId}"`,
    }
  }
  return { transport: "acp", profileId: resolved.profileId, profile: resolved.profile }
}

/** Resolves an EXISTING run's transport strictly from its durable
 *  binding — never from current config. Absent binding means native (a
 *  pre-acp-runner row, or a native attempt that predates this change's
 *  migration). */
export function transportOfBinding(binding: { readonly transport: RunnerTransport } | null): RunnerTransport {
  return binding?.transport ?? "native"
}
