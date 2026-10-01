/**
 * Pure change-queue planning — no I/O, no clock, no randomness. The server
 * gathers the inputs (store rows, `.openspec.yaml` files, git) and persists
 * the output; every decision about what starts and why an entry waits lives
 * here so it is exhaustively unit-testable.
 */

import type { FeatureStatus } from "./types.ts"

export type QueueEntryId = string

/** Persisted status of a queue entry. `starting` is the transient claim
 *  state of the exactly-once start protocol; every other value is a state
 *  from the spec. `planQueue` recomputes `waiting`/`blocked`/`invalid` from
 *  scratch on every pass, so the persisted value only matters for entries
 *  that were started (`starting`/`running`/`escalated`) or are final
 *  (`merged`/`removed`). */
export type QueueEntryStatus =
  | "waiting"
  | "blocked"
  | "invalid"
  | "starting"
  | "running"
  | "escalated"
  | "merged"
  | "removed"

export interface QueueEntry {
  readonly id: QueueEntryId
  readonly change: string
  readonly status: QueueEntryStatus
  readonly featureId?: string
}

export type QueueDiagnostic =
  | {
      readonly kind: "cycle"
      /** Members of the cycle in dependency order, rotated to start at the lexicographically smallest name. */
      readonly changes: readonly string[]
      readonly message: string
    }
  | {
      readonly kind: "unknown-dependency"
      /** The declaring change followed by the unknown dependency. */
      readonly changes: readonly [string, string]
      readonly message: string
    }
  /**
   * Problems only the server can see (it reads the files and starts the
   * feature); `planQueue` never produces them. Stored as `invalid` states.
   *  - `invalid-depends-on`: the change's `.openspec.yaml` cannot be read or parsed.
   *  - `not-startable`: the change is not active on disk or has no `proposal.md`.
   *  - `start-failed`: starting the feature failed; sticky — the scheduler does
   *    not retry the entry until the operator removes it and queues it again.
   */
  | {
      readonly kind: "invalid-depends-on" | "not-startable" | "start-failed"
      readonly changes: readonly [string]
      readonly message: string
    }

export type StuckFeatureStatus = "escalated" | "paused" | "abandoned"

/**
 * Next state of an entry. Every state except `merged` and `removed` carries
 * a human-readable `reason`.
 *
 * Feature status mapping for started entries (queue-started feature `F`):
 *  - `running` / `waiting_human` → `running` (not stuck)
 *  - `escalated`                 → `escalated`, stuck
 *  - `paused`                    → `running` with `featureStatus: "paused"`,
 *                                  stuck: it keeps its slot and blocks its
 *                                  dependants until it resumes
 *  - `abandoned`                 → `escalated` with `featureStatus:
 *                                  "abandoned"`, stuck: the entry is never
 *                                  removed automatically; it stays stuck,
 *                                  holds no slot, and is named in its
 *                                  dependants' reasons until the operator
 *                                  removes the entry or drops the dependency
 *  - `done` without the change in `merged` → `running` with
 *                                  `featureStatus: "done"`, not stuck: it
 *                                  holds no slot and dependants simply keep
 *                                  waiting for the merge
 *  - a removed entry whose feature is abandoned keeps blocking dependants
 *    (until the change is queued again or the dependency is dropped)
 *  - feature missing from `features` → `running`/`escalated` as persisted,
 *                                  treated as non-terminal and not stuck
 */
export type QueueEntryState =
  | {
      readonly kind: "waiting"
      readonly why: "dependencies" | "limit" | "paused"
      /** Dependencies that have not merged; empty unless `why` is `dependencies`. */
      readonly waitingOn: readonly string[]
      readonly reason: string
    }
  | {
      readonly kind: "blocked"
      /** The nearest stuck change this entry depends on, directly or transitively. */
      readonly by: string
      readonly stuck: StuckFeatureStatus
      readonly reason: string
    }
  | { readonly kind: "invalid"; readonly diagnostics: readonly QueueDiagnostic[]; readonly reason: string }
  | { readonly kind: "starting"; readonly reason: string }
  | {
      readonly kind: "running"
      readonly featureStatus?: FeatureStatus
      readonly reason: string
    }
  | {
      readonly kind: "escalated"
      readonly featureStatus?: FeatureStatus
      readonly reason: string
    }
  | { readonly kind: "merged" }
  | { readonly kind: "removed" }

export interface PlanQueueInput {
  /** Queue entries in queue order. */
  readonly entries: readonly QueueEntry[]
  /** Active change → `depends_on` (absent key = no dependencies). */
  readonly graph: ReadonlyMap<string, readonly string[]>
  /** Names of all active and archived changes. */
  readonly known: ReadonlySet<string>
  /** Names merged on the default branch, archived dependencies included. */
  readonly merged: ReadonlySet<string>
  /** Status of every queue-started feature, by feature id. */
  readonly features: ReadonlyMap<string, FeatureStatus>
  /** Parallelism limit; values below 1 are treated as 1. */
  readonly limit: number
  readonly paused: boolean
}

export interface PlanQueueResult {
  /** Entry ids to start, in queue order. */
  readonly start: readonly QueueEntryId[]
  /** Next state of every entry, in queue order. */
  readonly states: ReadonlyMap<QueueEntryId, QueueEntryState>
}

const quote = (name: string): string => `\`${name}\``

function dependenciesOf(graph: ReadonlyMap<string, readonly string[]>, change: string): readonly string[] {
  return graph.get(change) ?? []
}

function canonicalCycle(cycle: readonly string[]): string[] {
  let start = 0
  for (let i = 1; i < cycle.length; i++) {
    if ((cycle[i] as string) < (cycle[start] as string)) start = i
  }
  return [...cycle.slice(start), ...cycle.slice(0, start)]
}

/**
 * Validates the dependency graph reachable from `change` (following
 * `depends_on` transitively): reports every cycle and every dependency that
 * is neither active nor archived. Returns no diagnostics when the graph is
 * sound. Used both when adding an entry and on every scheduler pass.
 */
export function validateQueueEntry(
  change: string,
  graph: ReadonlyMap<string, readonly string[]>,
  known: ReadonlySet<string>,
): QueueDiagnostic[] {
  const diagnostics: QueueDiagnostic[] = []
  const seen = new Set<string>()
  const state = new Map<string, "open" | "done">()
  const stack: string[] = []

  const visit = (current: string): void => {
    state.set(current, "open")
    stack.push(current)
    for (const dependency of dependenciesOf(graph, current)) {
      if (!known.has(dependency)) {
        const key = `unknown\0${current}\0${dependency}`
        if (seen.has(key)) continue
        seen.add(key)
        diagnostics.push({
          kind: "unknown-dependency",
          changes: [current, dependency],
          message: `${quote(current)} depends on unknown change ${quote(dependency)}`,
        })
        continue
      }
      const status = state.get(dependency)
      if (status === "open") {
        const cycle = canonicalCycle(stack.slice(stack.indexOf(dependency)))
        const key = `cycle\0${cycle.join("\0")}`
        if (seen.has(key)) continue
        seen.add(key)
        diagnostics.push({
          kind: "cycle",
          changes: cycle,
          message: `dependency cycle: ${[...cycle, cycle[0] as string].map(quote).join(" → ")}`,
        })
      } else if (status === undefined) {
        visit(dependency)
      }
    }
    stack.pop()
    state.set(current, "done")
  }

  visit(change)
  return diagnostics
}

function isFeatureTerminal(status: FeatureStatus): boolean {
  return status === "done" || status === "abandoned"
}

function stuckStatus(status: FeatureStatus | undefined): StuckFeatureStatus | undefined {
  return status === "escalated" || status === "paused" || status === "abandoned" ? status : undefined
}

function isStarted(entry: QueueEntry): boolean {
  return entry.status === "starting" || entry.status === "running" || entry.status === "escalated"
}

function startedState(entry: QueueEntry, featureStatus: FeatureStatus | undefined): QueueEntryState {
  if (entry.status === "starting") return { kind: "starting", reason: "starting: claimed, feature not created yet" }
  switch (featureStatus) {
    case "running":
      return { kind: "running", featureStatus, reason: "feature running" }
    case "waiting_human":
      return { kind: "running", featureStatus, reason: "feature waiting for a human" }
    case "paused":
      return { kind: "running", featureStatus, reason: "feature paused" }
    case "done":
      return {
        kind: "running",
        featureStatus,
        reason: "feature done; waiting for its change to merge on the default branch",
      }
    case "escalated":
      return { kind: "escalated", featureStatus, reason: "feature escalated" }
    case "abandoned":
      return {
        kind: "escalated",
        featureStatus,
        reason: "feature abandoned; remove the entry or drop the dependency to unblock dependants",
      }
    default:
      return entry.status === "escalated"
        ? { kind: "escalated", reason: "feature escalated" }
        : { kind: "running", reason: "feature running" }
  }
}

/**
 * Decides which queued changes to start and the next state (with reason) of
 * every entry. Pure and deterministic: the same input always yields the same
 * output, ordered by queue order.
 *
 * Slots: the number of entries holding a non-terminal queue-started feature
 * (or a `starting` claim) counts against `limit`; a `merged` or `removed`
 * entry whose feature is still non-terminal keeps its slot until the
 * feature is terminal (a removed entry is still never shown or started).
 */
export function planQueue(input: PlanQueueInput): PlanQueueResult {
  const { entries, graph, known, merged, features, paused } = input
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit)) : 1

  const featureStatusOf = (entry: QueueEntry): FeatureStatus | undefined =>
    entry.featureId === undefined ? undefined : features.get(entry.featureId)

  let occupied = 0
  const stuck = new Map<string, StuckFeatureStatus>()
  const liveChanges = new Set<string>()
  for (const entry of entries) {
    if (entry.status === "removed") {
      // A removed entry whose feature is still non-terminal keeps holding its slot.
      const removedFeature = featureStatusOf(entry)
      if (removedFeature !== undefined && !isFeatureTerminal(removedFeature)) occupied++
      continue
    }
    liveChanges.add(entry.change)
    const featureStatus = featureStatusOf(entry)
    const holdsSlot =
      entry.status === "starting" ||
      (featureStatus === undefined ? isStarted(entry) : !isFeatureTerminal(featureStatus))
    if (holdsSlot) occupied++
    if (entry.status === "merged" || merged.has(entry.change)) continue
    const kind = stuckStatus(featureStatus)
    if (kind !== undefined && !stuck.has(entry.change)) stuck.set(entry.change, kind)
  }
  // Removing an abandoned change's entry keeps its dependants blocked, unless
  // the change has been queued again.
  for (const entry of entries) {
    if (entry.status !== "removed" || liveChanges.has(entry.change) || merged.has(entry.change)) continue
    if (featureStatusOf(entry) === "abandoned") stuck.set(entry.change, "abandoned")
  }

  const nearestStuck = (change: string): { change: string; status: StuckFeatureStatus } | undefined => {
    const visited = new Set<string>([change])
    let frontier = [change]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const current of frontier) {
        for (const dependency of dependenciesOf(graph, current)) {
          if (visited.has(dependency)) continue
          visited.add(dependency)
          if (merged.has(dependency)) continue
          const status = stuck.get(dependency)
          if (status !== undefined) return { change: dependency, status }
          next.push(dependency)
        }
      }
      frontier = next
    }
    return undefined
  }

  let slots = Math.max(0, limit - occupied)
  const start: QueueEntryId[] = []
  const states = new Map<QueueEntryId, QueueEntryState>()

  for (const entry of entries) {
    if (entry.status === "removed") {
      states.set(entry.id, { kind: "removed" })
      continue
    }
    if (entry.status === "merged" || merged.has(entry.change)) {
      states.set(entry.id, { kind: "merged" })
      continue
    }
    if (isStarted(entry)) {
      states.set(entry.id, startedState(entry, featureStatusOf(entry)))
      continue
    }

    const diagnostics = validateQueueEntry(entry.change, graph, known)
    if (diagnostics.length > 0) {
      states.set(entry.id, {
        kind: "invalid",
        diagnostics,
        reason: `invalid: ${diagnostics.map((d) => d.message).join("; ")}`,
      })
      continue
    }

    const blocker = nearestStuck(entry.change)
    if (blocker !== undefined) {
      states.set(entry.id, {
        kind: "blocked",
        by: blocker.change,
        stuck: blocker.status,
        reason: `blocked: ${quote(blocker.change)} ${blocker.status}`,
      })
      continue
    }

    const waitingOn = [...new Set(dependenciesOf(graph, entry.change))].filter((dependency) => !merged.has(dependency))
    if (waitingOn.length > 0) {
      states.set(entry.id, {
        kind: "waiting",
        why: "dependencies",
        waitingOn,
        reason: `waiting for ${waitingOn.map(quote).join(", ")}`,
      })
      continue
    }

    if (paused) {
      states.set(entry.id, { kind: "waiting", why: "paused", waitingOn: [], reason: "queue paused" })
      continue
    }

    if (slots > 0) {
      slots--
      start.push(entry.id)
      states.set(entry.id, { kind: "starting", reason: "starting: all dependencies merged" })
      continue
    }

    states.set(entry.id, {
      kind: "waiting",
      why: "limit",
      waitingOn: [],
      reason: `parallelism limit reached (${limit})`,
    })
  }

  return { start, states }
}
