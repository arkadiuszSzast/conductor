/**
 * The change-queue scheduler (design D3/D4/D7): one `tick()` re-reads the
 * world for every project that has live queue entries, asks the pure
 * `planQueue` what to do, persists the planned states, and starts the
 * selected entries through `Engine.startFeature` with the claim/link
 * protocol that makes a start exactly-once.
 *
 * The engine knows nothing about the queue: entry state is derived from
 * feature status on every pass, and the TIMER lives in the daemon, never
 * here. `tick()` calls never overlap — a call made while one is running
 * returns the running pass.
 */

import { randomUUID } from "node:crypto"
import { planQueue } from "@conductor/core"
import type { QueueDiagnostic, QueueEntry, QueueEntryState, FeatureStatus } from "@conductor/core"
import { deriveChangeStart } from "../../../plugins/openspec/change-start.ts"
import type { Clock, Logger } from "./ports.ts"
import type { WorkflowResolver } from "./workflow-registry.ts"
import type { StartFeatureInput, StartFeatureResult } from "./engine.ts"
import type { QueueEntryRecord, Store } from "./store.ts"
import { reconcileStartingEntries } from "./change-queue-reconcile.ts"
import { diagnoseUnstartable, knownChanges, type ChangeQueueSourcePort } from "./change-queue-sources.ts"

/** The one engine method the scheduler uses. `Engine` satisfies this structurally. */
export interface QueueEngine {
  startFeature(projectDir: string, input: StartFeatureInput): Promise<StartFeatureResult>
}

export interface ChangeQueueSchedulerDeps {
  readonly store: Store
  readonly engine: QueueEngine
  readonly sources: ChangeQueueSourcePort
  /** Workflow snapshot lookup — supplies the declared inputs the change name is filled into. */
  readonly workflows: WorkflowResolver
  readonly clock: Clock
  readonly log: Logger
  /** Claim-token source; injectable for deterministic tests. */
  readonly newToken?: () => string
}

export interface QueueStartRecord {
  readonly entryId: string
  readonly change: string
  readonly featureId: string
}

export interface QueueStartFailure {
  readonly entryId: string
  readonly change: string
  readonly message: string
  /** `invalid`: the entry is now sticky-invalid; `released`: the claim was released and the next pass retries. */
  readonly outcome: "invalid" | "released"
}

export interface QueueProjectResult {
  readonly projectDir: string
  readonly started: readonly QueueStartRecord[]
  readonly failed: readonly QueueStartFailure[]
  /** Set when the project was not planned or started this pass, and why. */
  readonly skipped?: string
}

export interface ChangeQueueTickResult {
  readonly projects: readonly QueueProjectResult[]
}

const quote = (name: string): string => `\`${name}\``

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `start-failed` is sticky: an entry whose feature could not be started is
 * marked `invalid` with the start error and the scheduler does NOT retry it
 * on later passes (retrying would loop-start, and re-fail, forever on a
 * permanent problem such as a workflow that requires an input the queue
 * cannot supply). The operator fixes the cause, removes the entry and
 * queues the change again.
 */
function isStartFailed(entry: QueueEntryRecord): boolean {
  return (
    entry.status === "invalid" &&
    entry.state?.kind === "invalid" &&
    entry.state.diagnostics.some(diagnostic => diagnostic.kind === "start-failed")
  )
}

const UNSTARTED: ReadonlySet<string> = new Set(["waiting", "blocked", "invalid"])

function invalidState(diagnostics: readonly QueueDiagnostic[]): QueueEntryState & { kind: "invalid" } {
  return { kind: "invalid", diagnostics, reason: `invalid: ${diagnostics.map(d => d.message).join("; ")}` }
}

export class ChangeQueueScheduler {
  private inFlight: Promise<ChangeQueueTickResult> | null = null
  private readonly newToken: () => string

  constructor(private readonly deps: ChangeQueueSchedulerDeps) {
    this.newToken = deps.newToken ?? randomUUID
  }

  /** True while a pass is running. */
  get running(): boolean {
    return this.inFlight !== null
  }

  /**
   * Settles every `starting` entry: links the feature a crashed start
   * created, or releases the claim. `tick()` runs it at the start of every
   * pass — passes never overlap in-process, so a `starting` entry seen at
   * that point is stale whether it came from a previous process or from an
   * earlier pass of this one (e.g. a claim whose release failed). The daemon
   * also calls it once at startup, before the timer is armed.
   */
  recover(): void {
    const recovery = reconcileStartingEntries(this.deps.store)
    if (recovery.linked.length > 0 || recovery.released.length > 0) {
      this.deps.log.log(
        `change-queue: restart recovery linked ${recovery.linked.length} and released ${recovery.released.length} starting entries`,
      )
    }
  }

  tick(): Promise<ChangeQueueTickResult> {
    if (this.inFlight) return this.inFlight
    const pass = this.run().finally(() => {
      this.inFlight = null
    })
    this.inFlight = pass
    return pass
  }

  private async run(): Promise<ChangeQueueTickResult> {
    const { store, log } = this.deps
    this.recover()
    const projects: QueueProjectResult[] = []
    for (const projectDir of store.listQueuedProjects()) {
      try {
        projects.push(await this.runProject(projectDir))
      } catch (error) {
        log.log(`change-queue: ${projectDir}: pass failed: ${message(error)}`)
        projects.push({ projectDir, started: [], failed: [], skipped: `pass failed: ${message(error)}` })
      }
    }
    return { projects }
  }

  private async runProject(projectDir: string): Promise<QueueProjectResult> {
    const { store, sources, workflows, log } = this.deps
    const local = await sources.readLocal(projectDir)
    const mergedResult = await sources.readMerged(projectDir)
    if (mergedResult.kind === "unknown") {
      return { projectDir, started: [], failed: [], skipped: `merged set unknown: ${mergedResult.reason}` }
    }
    const merged = mergedResult.names

    // Read the queue only after the slow I/O so an operator edit made during
    // the fetch is seen; claims and plan application re-check status anyway.
    const queue = store.getQueue(projectDir)
    const records = queue.entries
    const workflow = workflows(projectDir)?.workflow

    const states = new Map<string, QueueEntryState>()
    const planned: QueueEntry[] = []
    const features = new Map<string, FeatureStatus>()
    for (const record of records) {
      const feature = record.featureId !== null ? store.getFeature(record.featureId) : null
      // A merged entry with no feature, or whose feature is terminal, holds
      // no slot and blocks nothing: it never needs planning again.
      if (record.status === "merged" && (feature === null || feature.status === "done" || feature.status === "abandoned")) continue
      if (record.featureId !== null && feature) features.set(record.featureId, feature.status)
      const open = UNSTARTED.has(record.status) && !merged.has(record.change)
      if (open && isStartFailed(record)) continue
      if (open) {
        const diagnostics = diagnoseUnstartable(record.change, local, merged, workflow)
        if (diagnostics.length > 0) {
          states.set(record.id, invalidState(diagnostics))
          continue
        }
      }
      planned.push({
        id: record.id,
        change: record.change,
        status: record.status,
        ...(record.featureId !== null ? { featureId: record.featureId } : {}),
      })
    }

    const plan = planQueue({
      entries: planned,
      graph: local.graph,
      known: knownChanges(local, merged),
      merged,
      features,
      limit: queue.settings.parallelism,
      paused: queue.settings.paused,
    })
    for (const [id, state] of plan.states) states.set(id, state)

    // Only `claimEntry` may move an entry into `starting`, and it claims from
    // `waiting`: make every selected entry `waiting` first (an entry that was
    // `blocked`/`invalid` last pass would otherwise never be claimable).
    for (const id of plan.start) {
      states.set(id, { kind: "waiting", why: "dependencies", waitingOn: [], reason: "ready: all dependencies merged" })
    }
    store.applyPlannedStates(projectDir, states)

    const started: QueueStartRecord[] = []
    const failed: QueueStartFailure[] = []
    if (plan.start.length > 0 && workflows(projectDir) === null) {
      log.log(`change-queue: ${projectDir}: no valid workflow registered; not starting ${plan.start.length} ready change(s)`)
      return { projectDir, started, failed, skipped: "no valid workflow registered for the project" }
    }
    for (const id of plan.start) {
      const record = records.find(entry => entry.id === id)
      if (!record) continue
      const outcome = await this.startEntry(projectDir, record)
      if (outcome.kind === "started") started.push(outcome.record)
      else if (outcome.kind === "failed") failed.push(outcome.failure)
    }
    return { projectDir, started, failed }
  }

  private async startEntry(
    projectDir: string,
    record: QueueEntryRecord,
  ): Promise<
    | { readonly kind: "started"; readonly record: QueueStartRecord }
    | { readonly kind: "failed"; readonly failure: QueueStartFailure }
    | { readonly kind: "skipped" }
  > {
    const { store, sources, workflows, engine, clock, log } = this.deps
    const token = this.newToken()
    const claimedAt = clock.now()
    if (!store.claimEntry(record.id, token, claimedAt)) {
      log.log(`change-queue: ${projectDir}: entry for ${quote(record.change)} was not claimable; skipping`)
      return { kind: "skipped" }
    }

    let result: StartFeatureResult
    try {
      const proposal = await sources.readProposal(projectDir, record.change)
      if (proposal === null) {
        return { kind: "failed", failure: this.fail(projectDir, record, token, `change ${quote(record.change)} has no proposal.md`) }
      }
      const start = deriveChangeStart(record.change, proposal, workflows(projectDir)?.workflow.inputs)
      result = await engine.startFeature(projectDir, {
        title: start.title,
        ...(start.description !== undefined ? { description: start.description } : {}),
        ...(start.inputs !== undefined ? { inputs: start.inputs } : {}),
      })
    } catch (error) {
      // startFeature may have created the feature before it threw (e.g. while
      // dispatching the first step). Link that feature rather than orphan it
      // and risk a second start.
      const created = store.findFeatureCreatedForChange(projectDir, record.change, claimedAt)
      if (created !== null && store.linkEntry(record.id, token, created, clock.now())) {
        log.log(`change-queue: ${projectDir}: start of ${quote(record.change)} threw (${message(error)}) after creating feature ${created}; linked it`)
        return { kind: "started", record: { entryId: record.id, change: record.change, featureId: created } }
      }
      return { kind: "failed", failure: this.fail(projectDir, record, token, `starting the feature failed: ${message(error)}`) }
    }

    if (!result.ok) {
      if (result.code === "project_not_configured") {
        // Transient (the project was unregistered mid-pass): release and let the next pass retry.
        store.releaseClaim(record.id, token, clock.now())
        log.log(`change-queue: ${projectDir}: ${result.message}; released the claim on ${quote(record.change)}`)
        return { kind: "failed", failure: { entryId: record.id, change: record.change, message: result.message, outcome: "released" } }
      }
      return { kind: "failed", failure: this.fail(projectDir, record, token, `starting the feature failed (${result.code}): ${result.message}`) }
    }

    if (!store.linkEntry(record.id, token, result.feature.id, clock.now())) {
      log.log(`change-queue: ${projectDir}: feature ${result.feature.id} was created for ${quote(record.change)} but the claim was lost; restart recovery will link it`)
    }
    log.log(`change-queue: ${projectDir}: started ${quote(record.change)} as feature ${result.feature.id}`)
    return { kind: "started", record: { entryId: record.id, change: record.change, featureId: result.feature.id } }
  }

  /**
   * Parks the entry as sticky-invalid with the start error (see
   * `isStartFailed`) in one store transaction that only succeeds while the
   * claim token still matches — there is no window in which the claim is
   * released but the entry is not yet invalid.
   */
  private fail(projectDir: string, record: QueueEntryRecord, token: string, reason: string): QueueStartFailure {
    const { store, clock, log } = this.deps
    const diagnostics: QueueDiagnostic[] = [{ kind: "start-failed", changes: [record.change], message: reason }]
    if (!store.failClaim(record.id, token, invalidState(diagnostics), clock.now())) {
      log.log(`change-queue: ${projectDir}: the claim on ${quote(record.change)} was lost before its start failure could be recorded`)
    }
    log.log(`change-queue: ${projectDir}: could not start ${quote(record.change)}: ${reason}`)
    return { entryId: record.id, change: record.change, message: reason, outcome: "invalid" }
  }
}
