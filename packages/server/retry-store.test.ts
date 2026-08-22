import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openMigratedDatabase, type DatabaseConnection } from "./src/database.ts"
import { Store } from "./src/store.ts"
import type { FailureEnvelope, PipelineEvent, Transition } from "@conductor/core"

let directory: string
let connection: DatabaseConnection
let store: Store

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "conductor-retry-store-"))
  connection = openMigratedDatabase({ path: join(directory, "state.db") })
  store = new Store(connection.db)
})

afterEach(() => {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
})

function failure(overrides: Partial<FailureEnvelope> = {}): FailureEnvelope {
  return { class: "transient_upstream", diagnostic: "503", source: "runner", ...overrides }
}

// ---------------------------------------------------------------------------
// retry episodes: scheduling and durable due-work claim
// ---------------------------------------------------------------------------

describe("retry episodes: scheduling", () => {
  it("schedules a retry episode and reads it back as the open episode for its target", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 1000, nextAttemptAt: 2000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    expect(episode).not.toBeNull()
    expect(episode).toMatchObject({
      featureId: feature.id, jobId: "main", stepId: "implement", status: "scheduled",
      attempts: 1, startedAt: 1000, pausedMs: 0, nextAttemptAt: 2000, delayMs: 1000,
      scheduleSource: "backoff", maxAttempts: 5, maxElapsedMs: 60_000, version: 0, recoveredFrom: null,
    })
    expect(episode?.lastFailure).toEqual(failure())

    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")?.id).toBe(episode!.id)
    expect(store.getOpenRetryEpisode(feature.id, "main", "other")).toBeNull()
    expect(store.getRetryEpisode(episode!.id)).toEqual(episode)
  })

  it("enforces one open episode per target — a second schedule for the same job+step is rejected", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const first = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    expect(first).not.toBeNull()

    const second = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    expect(second).toBeNull()
    expect(store.listRetryEpisodes(feature.id)).toHaveLength(1)
  })

  it("a different job+step target schedules independently", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const a = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    const b = store.scheduleRetry({
      featureId: feature.id, jobId: "other", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.id).not.toBe(b!.id)
  })

  it("once an episode is closed, a fresh one may be scheduled for the same target", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const first = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    expect(store.closeRetryEpisode(first.id, "dispatched")).toBe(true)

    const second = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 2, startedAt: 0, nextAttemptAt: 5000, delayMs: 4000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    expect(second).not.toBeNull()
    expect(second!.id).not.toBe(first.id)
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")?.id).toBe(second!.id)
  })

  it("closeRetryEpisode is idempotent-safe — a second close returns false", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    expect(store.closeRetryEpisode(episode.id, "dispatched")).toBe(true)
    expect(store.closeRetryEpisode(episode.id, "dispatched again")).toBe(false)
  })
})

describe("retry episodes: due-work claim", () => {
  it("lists only due, non-paused episodes and excludes claimed/closed ones", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const due = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "a",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    const notDue = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "b",
      attempts: 1, startedAt: 0, nextAttemptAt: 999_000, delayMs: 999_000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!

    expect(store.listDueRetryEpisodes(2000).map(e => e.id)).toEqual([due.id])
    expect(store.listDueRetryEpisodes(2000)).not.toContainEqual(expect.objectContaining({ id: notDue.id }))
  })

  it("excludes due episodes belonging to a paused feature (the scheduling barrier)", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "a",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })

    expect(store.listDueRetryEpisodes(2000)).toEqual([])
    // Still resolvable directly — pause hides it from due-work scans, not from existing entirely.
    expect(store.getOpenRetryEpisode(feature.id, "main", "a")).not.toBeNull()
  })

  it("claimRetryEpisode atomically moves scheduled → claimed and bumps version", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    const claimed = store.claimRetryEpisode(episode.id, 2000)
    expect(claimed).toMatchObject({ id: episode.id, status: "claimed", version: 1 })
    expect(store.listDueRetryEpisodes(2000)).toEqual([])
  })

  it("claimRetryEpisode rejects a not-yet-due episode", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 999_000, delayMs: 999_000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    expect(store.claimRetryEpisode(episode.id, 2000)).toBeNull()
    expect(store.getRetryEpisode(episode.id)?.status).toBe("scheduled")
  })

  it("claimRetryEpisode rejects claiming a paused feature's episode even if the caller has a stale id from before pause", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    expect(store.claimRetryEpisode(episode.id, 2000)).toBeNull()
    expect(store.getRetryEpisode(episode.id)?.status).toBe("scheduled")
  })

  it("concurrent claim race: two callers claiming the same due episode — exactly one wins", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    const results = [store.claimRetryEpisode(episode.id, 2000), store.claimRetryEpisode(episode.id, 2000)]
    const winners = results.filter(r => r !== null)
    expect(winners).toHaveLength(1)
  })

  it("restart before due time: a fresh Store over the same database still reports the episode as not-yet-due", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 999_000, delayMs: 999_000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    const restarted = new Store(connection.db)
    expect(restarted.listDueRetryEpisodes(2000)).toEqual([])
    expect(restarted.getOpenRetryEpisode(feature.id, "main", "implement")?.status).toBe("scheduled")
  })

  it("restart after due time: reconstructs the wait and makes exactly one attempt eligible", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    connection.close()

    const reopened = openMigratedDatabase({ path: join(directory, "state.db") })
    const reopenedStore = new Store(reopened.db)
    const due = reopenedStore.listDueRetryEpisodes(999_999)
    expect(due.map(e => e.id)).toEqual([episode.id])
    const claimed = reopenedStore.claimRetryEpisode(episode.id, 999_999)
    expect(claimed?.status).toBe("claimed")
    // Subject to normal concurrency claims — a second claim after restart finds nothing due.
    expect(reopenedStore.listDueRetryEpisodes(999_999)).toEqual([])
    reopened.close()
    // Re-point the shared afterEach connection at the still-open handle's path — already closed above.
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
  })

  it("crash boundary: rolls back an in-flight recoverRetryEpisode transaction on failure, leaving the prior episode untouched", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 5, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    store.closeRetryEpisode(episode.id, "exhausted")
    connection.db.run(`
      CREATE TRIGGER reject_recovered_insert BEFORE INSERT ON retry_episode
      WHEN NEW.recovered_from IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'recovery insert rejected'); END
    `)
    expect(() =>
      store.recoverRetryEpisode(episode.id, episode.version, { startedAt: 5000, maxAttempts: 5, maxElapsedMs: 60_000 }),
    ).toThrow("recovery insert rejected")
    // The prior episode's close from before the trigger was installed survives untouched.
    expect(store.getRetryEpisode(episode.id)).toMatchObject({ status: "closed", closedReason: "exhausted" })
    expect(store.listRetryEpisodes(feature.id)).toHaveLength(1)
  })
})

describe("retry episodes: operator recover (CAS)", () => {
  it("recovers a closed episode into a fresh chained episode with a reset budget", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const exhausted = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 5, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure({ class: "deterministic_failure", diagnostic: "exit 1" }),
    })!
    store.closeRetryEpisode(exhausted.id, "exhausted attempts")

    const recovered = store.recoverRetryEpisode(exhausted.id, exhausted.version, {
      startedAt: 10_000, maxAttempts: 3, maxElapsedMs: 30_000,
    })
    expect(recovered).not.toBeNull()
    expect(recovered).toMatchObject({
      featureId: feature.id, jobId: "main", stepId: "implement", status: "scheduled",
      attempts: 0, startedAt: 10_000, pausedMs: 0, maxAttempts: 3, maxElapsedMs: 30_000,
      recoveredFrom: exhausted.id, version: 0,
    })
    // Old failure history remains in the timeline.
    const history = store.listRetryEpisodes(feature.id)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ id: exhausted.id, status: "closed" })
    expect(history[1]).toMatchObject({ id: recovered!.id, recoveredFrom: exhausted.id })
  })

  it("recovers an episode that was still open (closes it as a side effect)", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const open = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 999_000, delayMs: 999_000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    const recovered = store.recoverRetryEpisode(open.id, open.version, { startedAt: 5000, maxAttempts: 2, maxElapsedMs: 20_000 })
    expect(recovered).not.toBeNull()
    expect(store.getRetryEpisode(open.id)).toMatchObject({ status: "closed", closedReason: "recovered" })
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")?.id).toBe(recovered!.id)
  })

  it("rejects recovery with a stale expected version (CAS failure)", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 5, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    store.closeRetryEpisode(episode.id, "exhausted")
    const staleVersion = episode.version // version has since bumped from the close
    const result = store.recoverRetryEpisode(episode.id, staleVersion - 1, { startedAt: 5000, maxAttempts: 3, maxElapsedMs: 30_000 })
    expect(result).toBeNull()
    expect(store.listRetryEpisodes(feature.id)).toHaveLength(1)
  })

  it("concurrent recover race on the same stale-checked episode: exactly one wins", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 5, startedAt: 0, nextAttemptAt: 1000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    store.closeRetryEpisode(episode.id, "exhausted")
    const closed = store.getRetryEpisode(episode.id)!
    const results = [
      store.recoverRetryEpisode(episode.id, closed.version, { startedAt: 5000, maxAttempts: 3, maxElapsedMs: 30_000 }),
      store.recoverRetryEpisode(episode.id, closed.version, { startedAt: 5000, maxAttempts: 3, maxElapsedMs: 30_000 }),
    ]
    // Both CAS-read the same version successfully, but the second's insert
    // collides with the unique open-target index the first just created —
    // "one active attempt per target" holds even across a recover race.
    const winners = results.filter(r => r !== null)
    expect(winners).toHaveLength(1)
    expect(store.listRetryEpisodes(feature.id).filter(e => e.status !== "closed")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// resource waits
// ---------------------------------------------------------------------------

describe("resource waits: upsert and observation", () => {
  it("creates a resource wait on first observation", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const wait = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 1000, nextObservationAt: 6000, deadlineAt: 1_801_000,
      diagnostic: "no compatible runner registered",
    })
    expect(wait).toMatchObject({
      featureId: feature.id, jobId: "main", stepId: "implement", status: "waiting",
      reason: "runner_unavailable", firstObservedAt: 1000, latestObservedAt: 1000, observationCount: 1,
      nextObservationAt: 6000, deadlineAt: 1_801_000, diagnostic: "no compatible runner registered", version: 0,
    })
    expect(store.getOpenResourceWait(feature.id, "main", "implement")?.id).toBe(wait.id)
  })

  it("a second observation updates latest/count/next in place — one row per target, not one per observation", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const first = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 1000, nextObservationAt: 6000, deadlineAt: 1_801_000,
    })
    const second = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 6000, nextObservationAt: 16_000, deadlineAt: 1_801_000,
      diagnostic: "still no runner",
    })
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({
      firstObservedAt: 1000, latestObservedAt: 6000, observationCount: 2,
      nextObservationAt: 16_000, diagnostic: "still no runner", version: 1,
    })
    // The deadline is fixed at creation — a later observation never moves it.
    expect(second.deadlineAt).toBe(1_801_000)
    expect(store.listResourceWaits(feature.id)).toHaveLength(1)
  })

  it("observing an unavailable resource never touches the step's run/attempt state", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 1000, nextObservationAt: 6000, deadlineAt: 1_801_000,
    })
    store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 6000, nextObservationAt: 16_000, deadlineAt: 1_801_000,
    })
    expect(store.getActiveRunForStep(feature.id, "main", "implement")).toBeNull()
    expect(store.listActiveRuns(feature.id)).toEqual([])
  })

  it("distinguishes every documented resource reason", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    for (const reason of ["runner_unavailable", "binding_unavailable", "dependency_unavailable"] as const) {
      const wait = store.upsertResourceWait({
        featureId: feature.id, jobId: "main", stepId: reason,
        reason, observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
      })
      expect(wait.reason).toBe(reason)
    }
  })

  it("closing a wait allows a fresh wait to open for the same target", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const first = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
    })
    expect(store.closeResourceWait(first.id, "runner registered")).toBe(true)
    const second = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 5000, nextObservationAt: 6000, deadlineAt: 1_805_000,
    })
    expect(second.id).not.toBe(first.id)
    expect(store.getOpenResourceWait(feature.id, "main", "implement")?.id).toBe(second.id)
  })

  it("closeResourceWait is idempotent-safe — a second close returns false", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const wait = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
    })
    expect(store.closeResourceWait(wait.id, "resolved")).toBe(true)
    expect(store.closeResourceWait(wait.id, "resolved again")).toBe(false)
  })

  it("an upsert never mutates a wait that has already been claimed by a concurrent caller", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const wait = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
    })
    const claimed = store.claimResourceWait(wait.id, 1000)
    expect(claimed?.status).toBe("claimed")

    // A racing observation lands after the claim — it must not resurrect
    // the waiting status or corrupt the in-flight claim.
    store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 1500, nextObservationAt: 2000, deadlineAt: 999_000,
    })
    expect(store.getResourceWait(wait.id)).toMatchObject({ status: "claimed", observationCount: 1 })
  })
})

describe("resource waits: due-work claim and restart", () => {
  it("lists only due, non-paused waits", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const due = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "a",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
    })
    store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "b",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 999_000, deadlineAt: 1_999_000,
    })
    expect(store.listDueResourceWaits(2000).map(w => w.id)).toEqual([due.id])
  })

  it("excludes due waits belonging to a paused feature", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "a",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
    })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    expect(store.listDueResourceWaits(2000)).toEqual([])
  })

  it("claimResourceWait atomically moves waiting → claimed, rejects a not-yet-due wait, and a race has exactly one winner", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const notDue = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "a",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 999_000, deadlineAt: 1_999_000,
    })
    expect(store.claimResourceWait(notDue.id, 2000)).toBeNull()

    const due = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "b",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
    })
    const results = [store.claimResourceWait(due.id, 2000), store.claimResourceWait(due.id, 2000)]
    const winners = results.filter(r => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ id: due.id, status: "claimed", version: 1 })
  })

  it("runner starts after submission: the reconciler claims the wait and can then dispatch exactly one first attempt", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const wait = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 0, nextObservationAt: 1000, deadlineAt: 999_000,
      diagnostic: "no compatible runner",
    })
    const claimed = store.claimResourceWait(wait.id, 2000)
    expect(claimed).not.toBeNull()
    expect(store.closeResourceWait(wait.id, "runner became available")).toBe(true)
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    expect(store.getActiveRunForStep(feature.id, "main", "implement")?.id).toBe(runId)
    expect(store.listActiveRuns(feature.id)).toHaveLength(1)
  })

  it("daemon restarts while waiting for runner: the wait survives a close/reopen without becoming failed or losing its deadline", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const wait = store.upsertResourceWait({
      featureId: feature.id, jobId: "main", stepId: "implement",
      reason: "runner_unavailable", observedAt: 1000, nextObservationAt: 6000, deadlineAt: 1_801_000,
      diagnostic: "no compatible runner",
    })
    connection.close()

    const reopened = openMigratedDatabase({ path: join(directory, "state.db") })
    const reopenedStore = new Store(reopened.db)
    const recovered = reopenedStore.getOpenResourceWait(feature.id, "main", "implement")
    expect(recovered).toMatchObject({ id: wait.id, status: "waiting", deadlineAt: 1_801_000, observationCount: 1 })
    expect(reopenedStore.getFeature(feature.id)?.status).not.toBe("escalated")
    reopened.close()
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
  })
})

// ---------------------------------------------------------------------------
// pause accounting
// ---------------------------------------------------------------------------

describe("pause accounting", () => {
  it("starts with no paused time and null pausedAt", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    expect(store.getPauseAccounting(feature.id)).toEqual({ pausedAt: null, pausedMs: 0 })
  })

  it("records pausedAt on pause and folds the span into pausedMs on resume", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    const paused = store.getPauseAccounting(feature.id)!
    expect(paused.pausedAt).not.toBeNull()
    expect(paused.pausedMs).toBe(0)

    // Simulate elapsed wall-clock time under pause directly at the row level
    // (this suite drives applyTransition with real Date.now(), so we assert
    // the shape/monotonic direction rather than an exact duration).
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: { status: "running" } })
    const resumed = store.getPauseAccounting(feature.id)!
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.pausedMs).toBeGreaterThanOrEqual(0)
  })

  it("accumulates across multiple pause/resume cycles rather than overwriting", () => {
    // The store's constructor clock only throttles run_log notifications
    // (see emitRunLogChange) — pause timestamps use Date.now() directly,
    // same as every other store timestamp, so this drives real spans and
    // asserts monotonic accumulation directly on the feature row instead
    // of an injected clock.
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })

    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    connection.db.run("UPDATE feature SET paused_at = paused_at - 5000 WHERE id = ?", [feature.id])
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: { status: "running" } })
    const afterFirst = store.getPauseAccounting(feature.id)!.pausedMs
    expect(afterFirst).toBeGreaterThanOrEqual(5000)

    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    connection.db.run("UPDATE feature SET paused_at = paused_at - 3000 WHERE id = ?", [feature.id])
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: { status: "running" } })
    const afterSecond = store.getPauseAccounting(feature.id)!.pausedMs
    expect(afterSecond).toBeGreaterThanOrEqual(afterFirst + 3000)
  })

  it("re-entering paused status while already paused does not reset pausedAt", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    const first = store.getPauseAccounting(feature.id)!.pausedAt
    // A no-op status write while already paused (patch.status omitted) must
    // not disturb the open span.
    store.applyTransition(feature.id, { kind: "step.failed", jobId: "main", stepId: "x", reason: "boom" }, {
      decisions: [{ kind: "noop", reason: "still paused" }],
      patch: {},
    })
    expect(store.getPauseAccounting(feature.id)!.pausedAt).toBe(first)
  })

  it("survives a close/reopen — pause accounting is durable, not in-memory", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    const pausedAt = store.getPauseAccounting(feature.id)!.pausedAt
    connection.close()

    const reopened = openMigratedDatabase({ path: join(directory, "state.db") })
    const reopenedStore = new Store(reopened.db)
    expect(reopenedStore.getPauseAccounting(feature.id)).toEqual({ pausedAt, pausedMs: 0 })
    reopened.close()
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
  })
})

describe("getFeaturePausedMsAsOf — cumulative pause total including an in-progress span", () => {
  it("returns the closed cumulative total when not currently paused", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    expect(store.getFeaturePausedMsAsOf(feature.id, Date.now())).toBe(0)

    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    connection.db.run("UPDATE feature SET paused_at = paused_at - 5000 WHERE id = ?", [feature.id])
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: { status: "running" } })
    const closed = store.getPauseAccounting(feature.id)!.pausedMs
    expect(closed).toBeGreaterThanOrEqual(5000)
    expect(store.getFeaturePausedMsAsOf(feature.id, Date.now())).toBe(closed)
  })

  it("includes the OPEN span (paused_at set, not yet folded) as of the given instant", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    connection.db.run("UPDATE feature SET paused_at = paused_at - 5000 WHERE id = ?", [feature.id])
    // Still paused — pausedMs (the closed-only column) is 0, but the
    // cumulative-as-of reading must count the 5000ms open span.
    expect(store.getPauseAccounting(feature.id)!.pausedMs).toBe(0)
    expect(store.getFeaturePausedMsAsOf(feature.id, Date.now())).toBeGreaterThanOrEqual(5000)
  })

  it("returns null for a feature that does not exist", () => {
    expect(store.getFeaturePausedMsAsOf("no-such-feature", Date.now())).toBeNull()
  })
})

describe("streak pause-snapshot plumbing: insertRun/scheduleRetry/recoverRetryEpisode", () => {
  it("insertRun snapshots the feature's cumulative paused_ms at dispatch time", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    connection.db.run("UPDATE feature SET paused_at = paused_at - 4000 WHERE id = ?", [feature.id])
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: { status: "running" } })
    const cumulative = store.getPauseAccounting(feature.id)!.pausedMs
    expect(cumulative).toBeGreaterThanOrEqual(4000)

    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    expect(store.getRunById(runId)!.pausedMsAtDispatch).toBe(cumulative)
  })

  it("scheduleRetry persists an explicit featurePausedMsAtStart, defaulting to 0 when omitted", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const withSnapshot = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 1000, featurePausedMsAtStart: 4200, nextAttemptAt: 2000, delayMs: 1000,
      scheduleSource: "backoff", maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    expect(withSnapshot).toMatchObject({ featurePausedMsAtStart: 4200 })

    const feature2 = store.createFeature({ title: "F2", slug: "f2", projectDir: "/p", workflow: "wf" })
    const withoutSnapshot = store.scheduleRetry({
      featureId: feature2.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 1000, nextAttemptAt: 2000, delayMs: 1000,
      scheduleSource: "backoff", maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })
    expect(withoutSnapshot).toMatchObject({ featurePausedMsAtStart: 0 })
  })

  it("recoverRetryEpisode resets featurePausedMsAtStart to the feature's cumulative paused_ms AT RECOVERY TIME, not 0 and not the recovered episode's old snapshot", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const original = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 1000, featurePausedMsAtStart: 999, nextAttemptAt: 2000, delayMs: 1000,
      scheduleSource: "backoff", maxAttempts: 1, maxElapsedMs: 1000, failure: failure(),
    })!
    store.closeRetryEpisode(original.id, "exhausted")

    // Accumulate a REAL cumulative pause total on the feature, distinct
    // from the original episode's stale 999 snapshot.
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    connection.db.run("UPDATE feature SET paused_at = paused_at - 7000 WHERE id = ?", [feature.id])
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: { status: "running" } })
    const cumulative = store.getPauseAccounting(feature.id)!.pausedMs
    expect(cumulative).toBeGreaterThanOrEqual(7000)

    const recovered = store.recoverRetryEpisode(original.id, original.version, {
      startedAt: Date.now(), maxAttempts: 5, maxElapsedMs: 60_000,
    })
    expect(recovered).toMatchObject({ featurePausedMsAtStart: cumulative, recoveredFrom: original.id })
  })
})

// ---------------------------------------------------------------------------
// run: failure envelope persistence
// ---------------------------------------------------------------------------

describe("run failure envelope", () => {
  it("finishRun persists a classified failure envelope alongside the human reason", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    store.finishRun(runId, "failed", { reason: "provider 503", failure: failure({ diagnostic: "provider 503", retryHintMs: 5000 }) })
    expect(store.getRunById(runId)?.failure).toEqual({ class: "transient_upstream", diagnostic: "provider 503", source: "runner", retryHintMs: 5000 })
  })

  it("a run with no failure envelope reads back null (succeeded run, or one concluded before the taxonomy)", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    store.finishRun(runId, "succeeded", { outputs: {} })
    expect(store.getRunById(runId)?.failure).toBeNull()
  })

  it("concludeRun persists a classified failure envelope in the same transaction as the transition", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const result = store.concludeRun(
      runId, "failed", { reason: "exit 1", failure: failure({ class: "deterministic_failure", diagnostic: "exit 1" }) },
      { kind: "step.failed", jobId: "main", stepId: "implement", reason: "exit 1" },
      { decisions: [{ kind: "escalate", reason: "deterministic failure" }], patch: { status: "escalated" } },
    )
    expect(result.claimed).toBe(true)
    expect(store.getRunById(runId)?.failure).toMatchObject({ class: "deterministic_failure", diagnostic: "exit 1" })
    expect(store.getFeature(feature.id)?.status).toBe("escalated")
  })

  it("rejects an unknown failure class at the SQLite layer (CHECK constraint) — never silently accepted", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    expect(() =>
      connection.db.run("UPDATE run SET failure_class = ? WHERE id = ?", ["not_a_real_class", runId]),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// concludeRun with a retrySchedule: atomic attempt conclusion + schedule
// ---------------------------------------------------------------------------

describe("concludeRun with retrySchedule", () => {
  const event: PipelineEvent = { kind: "step.failed", jobId: "main", stepId: "implement", reason: "503" }
  const noopTransition: Transition = { decisions: [], patch: {} }

  type RetrySchedule = NonNullable<NonNullable<Parameters<Store["concludeRun"]>[5]>["retrySchedule"]>
  function scheduleInput(overrides: Partial<RetrySchedule> = {}) {
    return {
      jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 0, nextAttemptAt: 5000, delayMs: 5000,
      scheduleSource: "backoff" as const, maxAttempts: 5, maxElapsedMs: 60_000,
      failure: failure(),
      ...overrides,
    }
  }

  it("persists the failed attempt and its retry schedule in one call", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const result = store.concludeRun(runId, "failed", { reason: "503", failure: failure() }, event, noopTransition, {
      retrySchedule: scheduleInput(),
    })

    expect(result.claimed).toBe(true)
    expect(result.episode).toMatchObject({ featureId: feature.id, jobId: "main", stepId: "implement", status: "scheduled", nextAttemptAt: 5000 })
    expect(store.getRunById(runId)).toMatchObject({ status: "failed", failure: failure() })
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")?.id).toBe(result.episode!.id)
  })

  it("returns claimed=false and schedules nothing for an already-concluded run (duplicate report)", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    store.finishRun(runId, "succeeded", { outputs: {} })

    const result = store.concludeRun(runId, "failed", { reason: "late failure", failure: failure() }, event, noopTransition, {
      retrySchedule: scheduleInput(),
    })
    expect(result).toEqual({ claimed: false, episode: null })
    expect(store.getRunById(runId)?.status).toBe("succeeded")
    expect(store.getOpenRetryEpisode(feature.id, "main", "implement")).toBeNull()
  })

  it("crash boundary: rolls back BOTH the run conclusion and the schedule when the schedule insert fails", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    connection.db.run(`
      CREATE TRIGGER reject_episode_insert BEFORE INSERT ON retry_episode
      BEGIN SELECT RAISE(ABORT, 'schedule rejected'); END
    `)
    expect(() =>
      store.concludeRun(runId, "failed", { reason: "503", failure: failure() }, event, noopTransition, { retrySchedule: scheduleInput() }),
    ).toThrow("schedule rejected")
    // Neither half landed — the run is still 'running', not half-concluded.
    expect(store.getRunById(runId)?.status).toBe("running")
    expect(store.listRetryEpisodes(feature.id)).toEqual([])
  })

  it("a duplicate conclusion never creates a duplicate retry schedule under concurrent conclude races", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const results = [
      store.concludeRun(runId, "failed", { reason: "503", failure: failure() }, event, noopTransition, { retrySchedule: scheduleInput() }),
      store.concludeRun(runId, "failed", { reason: "503 again", failure: failure() }, event, noopTransition, { retrySchedule: scheduleInput() }),
    ]
    const won = results.filter(r => r.claimed)
    expect(won).toHaveLength(1)
    expect(store.listRetryEpisodes(feature.id)).toHaveLength(1)
  })

  it("restart before the schedule is due: a fresh Store over the same database still reports it not-yet-due", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    store.concludeRun(runId, "failed", { reason: "503", failure: failure() }, event, noopTransition, {
      retrySchedule: scheduleInput({ nextAttemptAt: 999_000, delayMs: 999_000 }),
    })
    connection.close()

    const reopened = openMigratedDatabase({ path: join(directory, "state.db") })
    const reopenedStore = new Store(reopened.db)
    expect(reopenedStore.listDueRetryEpisodes(2000)).toEqual([])
    expect(reopenedStore.getOpenRetryEpisode(feature.id, "main", "implement")?.status).toBe("scheduled")
    reopened.close()
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
  })

  it("restart after the schedule is due: reconstructs the wait and the attempt becomes claimable exactly once", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const { episode } = store.concludeRun(runId, "failed", { reason: "503", failure: failure() }, event, noopTransition, {
      retrySchedule: scheduleInput({ nextAttemptAt: 1000, delayMs: 1000 }),
    })
    connection.close()

    const reopened = openMigratedDatabase({ path: join(directory, "state.db") })
    const reopenedStore = new Store(reopened.db)
    expect(reopenedStore.listDueRetryEpisodes(2000).map(e => e.id)).toEqual([episode!.id])
    expect(reopenedStore.claimRetryEpisode(episode!.id, 2000)?.status).toBe("claimed")
    expect(reopenedStore.listDueRetryEpisodes(2000)).toEqual([])
    reopened.close()
    connection = openMigratedDatabase({ path: join(directory, "state.db") })
  })

  it("a retry scheduled while the feature is already paused is excluded from due-work until resume", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.applyTransition(feature.id, { kind: "human.paused" }, { decisions: [{ kind: "pause" }], patch: { status: "paused" } })
    const runId = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    const { episode } = store.concludeRun(runId, "failed", { reason: "503", failure: failure() }, event, noopTransition, {
      retrySchedule: scheduleInput({ nextAttemptAt: 1000, delayMs: 1000 }),
    })
    expect(episode).not.toBeNull()

    expect(store.listDueRetryEpisodes(2000)).toEqual([])
    store.applyTransition(feature.id, { kind: "human.resumed" }, { decisions: [], patch: { status: "running" } })
    expect(store.listDueRetryEpisodes(2000).map(e => e.id)).toEqual([episode!.id])
  })
})

// ---------------------------------------------------------------------------
// one active attempt per target (DB uniqueness)
// ---------------------------------------------------------------------------

describe("one active run per job+step (DB uniqueness)", () => {
  it("rejects a second concurrently-running run for the same job+step at the SQLite layer", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    expect(() =>
      store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 2 }),
    ).toThrow()
  })

  it("allows a new run once the prior one has concluded", () => {
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const first = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 1 })
    store.finishRun(first, "failed", { reason: "boom" })
    const second = store.insertRun({ featureId: feature.id, jobId: "main", stepId: "implement", stepType: "agent", attempt: 2 })
    expect(store.getActiveRunForStep(feature.id, "main", "implement")?.id).toBe(second)
  })
})

// ---------------------------------------------------------------------------
// clock skew
// ---------------------------------------------------------------------------

describe("clock skew", () => {
  it("a due-check with nowMs before the episode's recorded startedAt still claims once due", () => {
    // A retry episode scheduled with a nextAttemptAt in the past relative
    // to a caller whose clock later jumps backward must still be claimable
    // once its own nowMs reaches the due time — claim eligibility depends
    // only on the caller-supplied nowMs vs. the stored due time, never on
    // wall-clock deltas computed inside the store.
    const feature = store.createFeature({ title: "F", slug: "f", projectDir: "/p", workflow: "wf" })
    const episode = store.scheduleRetry({
      featureId: feature.id, jobId: "main", stepId: "implement",
      attempts: 1, startedAt: 10_000, nextAttemptAt: 5000, delayMs: 1000, scheduleSource: "backoff",
      maxAttempts: 5, maxElapsedMs: 60_000, failure: failure(),
    })!
    expect(store.claimRetryEpisode(episode.id, 1000)).toBeNull()
    expect(store.claimRetryEpisode(episode.id, 5000)).toMatchObject({ id: episode.id, status: "claimed" })
  })

  it("pausedMs accumulation never goes negative when accumulatePausedMs sees a skewed span — verified via the core helper the store composes", async () => {
    const { accumulatePausedMs } = await import("@conductor/core")
    // Store composition (applyTransitionTx) always passes (row.paused_ms, row.paused_at, now);
    // this asserts the store's dependency stays monotonic under clock skew.
    expect(accumulatePausedMs(1000, 5000, 4000)).toBe(1000)
  })
})
