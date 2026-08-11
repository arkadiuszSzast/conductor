import { randomUUID } from "node:crypto"
import type { Database } from "./database.ts"
import { applyPatch, initialFeatureState } from "./state.ts"
import type { CreateFeatureInput } from "./state.ts"
import type { Decision, Feedback, FeatureState, FeatureStatus, PipelineEvent, Transition } from "@conductor/core"

/**
 * Post-commit change notification — the invalidation signal the API's
 * SSE stream fans out. Deliberately carries no payload beyond the kind
 * and feature id: subscribers refetch authoritative state over REST,
 * the notification itself is never a state carrier.
 */
export interface StoreChange {
  readonly kind: "feature" | "transition" | "run" | "finding"
  readonly featureId: string
}

interface FeatureRow {
  id: string
  title: string
  slug: string
  project_dir: string
  status: FeatureStatus
  workflow: string | null
  description: string | null
  pr: number | null
  escalation: string | null
  state: string
  feedback: string | null
  time_created: number
  time_updated: number
}

function toFeatureState(row: FeatureRow): FeatureState {
  return JSON.parse(row.state) as FeatureState
}

/**
 * A feature's interpreter state plus the row metadata the API projects
 * (creation/update timestamps). The timestamps deliberately live OUTSIDE
 * `FeatureState`: the interpreter never writes them, so they are store
 * metadata returned alongside the state, not part of it.
 */
export interface FeatureRecord {
  readonly state: FeatureState
  readonly createdAt: number
  readonly updatedAt: number
}

function toFeatureRecord(row: FeatureRow): FeatureRecord {
  return { state: toFeatureState(row), createdAt: row.time_created, updatedAt: row.time_updated }
}

export interface FeatureFilter {
  activeOnly?: boolean
  projectDir?: string
  statuses?: readonly FeatureStatus[]
}

function featureWhere(filter?: FeatureFilter): { where: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (filter?.activeOnly) clauses.push("status IN ('running','paused','waiting_human','escalated')")
  if (filter?.projectDir !== undefined) {
    clauses.push("project_dir = ?")
    params.push(filter.projectDir)
  }
  if (filter?.statuses !== undefined && filter.statuses.length > 0) {
    clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`)
    params.push(...filter.statuses)
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

interface RunRow {
  id: string
  feature_id: string
  job_id: string
  step_id: string
  step_type: "agent" | "command" | "action"
  attempt: number
  status: "running" | "succeeded" | "failed" | "reaped"
  session_id: string | null
  outputs: string
  reason: string | null
  nudges: number
  completion_event: string | null
  completion_decisions: string | null
  action_handled: number
  metadata: string | null
  pending_state: string | null
  next_observation: number | null
  time_started: number
  time_finished: number | null
}

/** Resolved action identity recorded on an action run — pins `uses`, the
 *  resolved manifest version and the content digest the run executed
 *  against, independent of what the registry resolves to later. */
export interface RunActionMetadata {
  readonly uses: string
  readonly version: string
  readonly digest: string
}

export interface RunSummary {
  readonly id: string
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string
  readonly stepType: "agent" | "command" | "action"
  readonly attempt: number
  readonly status: "running" | "succeeded" | "failed" | "reaped"
  readonly sessionId: string | null
  readonly outputs: Readonly<Record<string, string>>
  readonly reason: string | null
  readonly nudges: number
  readonly metadata: RunActionMetadata | null
  /** Opaque state a durable-pending action asked to see again on its next observation. */
  readonly pendingState: Readonly<Record<string, unknown>> | null
  /** When the reconciler should re-invoke a durable-pending action run. Null while not pending. */
  readonly nextObservation: number | null
  readonly timeStarted: number
  readonly timeFinished: number | null
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    featureId: row.feature_id,
    jobId: row.job_id,
    stepId: row.step_id,
    stepType: row.step_type,
    attempt: row.attempt,
    status: row.status,
    sessionId: row.session_id,
    outputs: JSON.parse(row.outputs) as Record<string, string>,
    reason: row.reason,
    nudges: row.nudges,
    metadata: row.metadata ? (JSON.parse(row.metadata) as RunActionMetadata) : null,
    pendingState: row.pending_state ? (JSON.parse(row.pending_state) as Record<string, unknown>) : null,
    nextObservation: row.next_observation,
    timeStarted: row.time_started,
    timeFinished: row.time_finished,
  }
}

export interface TransitionEntry {
  readonly event: PipelineEvent
  readonly decisions: readonly Decision[]
  readonly time: number
}

export interface FindingCounts {
  readonly new: number
  readonly fixed: number
  readonly dismissed: number
  readonly reopened: number
}

export interface FindingView {
  readonly id: string
  readonly stepId: string
  readonly path: string
  readonly line: number
  readonly severity: string
  readonly tags: string[]
  readonly body: string
  readonly status: "new" | "fixed" | "dismissed" | "reopened"
  readonly resolution: string | null
  readonly threadId: string | null
  readonly synced: boolean
}

export class Store {
  private readonly changeListeners = new Set<(change: StoreChange) => void>()

  constructor(private readonly db: Database) {}

  /**
   * Subscribe to post-commit change notifications. Listeners fire AFTER
   * the mutating transaction has committed — a notified subscriber
   * refetching over the same store always observes the new state. A
   * throwing listener is swallowed: observation must never break a
   * state transition that is already durable.
   */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private emit(change: StoreChange): void {
    for (const listener of this.changeListeners) {
      try {
        listener(change)
      } catch {
        // Listeners are projections; a broken one never blocks the store.
      }
    }
  }

  createFeature(input: CreateFeatureInput): FeatureState {
    const now = Date.now()
    const state = initialFeatureState({ ...input, id: randomUUID() })
    this.db.run(
      `INSERT INTO feature (id, slug, project_dir, title, workflow, description, status, pr, escalation, state, feedback, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        state.id,
        state.slug,
        state.projectDir,
        state.title,
        state.workflow,
        state.description,
        state.status,
        state.pr,
        null,
        JSON.stringify(state),
        null,
        now,
        now,
      ],
    )
    this.emit({ kind: "feature", featureId: state.id })
    return state
  }

  getFeature(id: string): FeatureState | null {
    const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(id) as FeatureRow | null
    return row ? toFeatureState(row) : null
  }

  /** Feedback snapshot attached by the most recent rerun transition, if any. */
  getFeedback(id: string): Feedback | null {
    const row = this.db.query("SELECT feedback FROM feature WHERE id = ?").get(id) as { feedback: string | null } | null
    return row?.feedback ? (JSON.parse(row.feedback) as Feedback) : null
  }

  listFeatures(filter?: FeatureFilter): FeatureState[] {
    return this.listFeatureRecords(filter).map(record => record.state)
  }

  /** Feature state plus row timestamps — the API's projection read. */
  getFeatureRecord(id: string): FeatureRecord | null {
    const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(id) as FeatureRow | null
    return row ? toFeatureRecord(row) : null
  }

  listFeatureRecords(filter?: FeatureFilter): FeatureRecord[] {
    const { where, params } = featureWhere(filter)
    const rows = this.db.query(`SELECT * FROM feature ${where} ORDER BY time_created DESC`).all(...params) as FeatureRow[]
    return rows.map(toFeatureRecord)
  }

  findFeatureByPr(pr: number): FeatureState | null {
    const row = this.db.query("SELECT * FROM feature WHERE pr = ? AND status NOT IN ('done','abandoned')").get(pr) as FeatureRow | null
    return row ? toFeatureState(row) : null
  }

  /** Escalation reason, tracked outside the core `FeatureState` shape. Null when not escalated. */
  getEscalation(id: string): string | null {
    const row = this.db.query("SELECT escalation FROM feature WHERE id = ?").get(id) as { escalation: string | null } | null
    return row?.escalation ?? null
  }

  /**
   * Applies a `Transition`'s patch to the feature's persisted graph
   * state and appends the audit row in ONE transaction: the invariant
   * every restart-recovery/duplicate-report guarantee depends on.
   */
  applyTransition(featureId: string, event: PipelineEvent, transition: Transition): void {
    this.db.transaction(() => this.applyTransitionTx(featureId, event, transition))()
    this.emit({ kind: "transition", featureId })
  }

  private applyTransitionTx(featureId: string, event: PipelineEvent, transition: Transition): void {
    const current = this.getFeature(featureId)
    if (!current) throw new Error(`conductor: feature ${featureId} not found`)
    const next = applyPatch(current, transition.patch)
    const escalation = transition.patch.status === "escalated"
      ? escalationReason(transition.decisions)
      : (transition.patch.status !== undefined ? null : undefined)

    const sets: string[] = ["time_updated = ?", "state = ?"]
    const params: (string | number | null)[] = [Date.now(), JSON.stringify(next)]
    if (transition.patch.status !== undefined) {
      sets.push("status = ?")
      params.push(next.status)
    }
    if (escalation !== undefined) {
      sets.push("escalation = ?")
      params.push(escalation)
    }
    if (transition.feedback !== undefined) {
      sets.push("feedback = ?")
      params.push(JSON.stringify(transition.feedback))
    }
    params.push(featureId)
    this.db.run(`UPDATE feature SET ${sets.join(", ")} WHERE id = ?`, params as never)
    this.db.run(
      `INSERT INTO transition_log (feature_id, event, decisions, time_created)
       VALUES (?, ?, ?, ?)`,
      [featureId, JSON.stringify(event), JSON.stringify(transition.decisions), Date.now()],
    )
  }

  setFeatureFields(id: string, fields: Partial<{ sessionId: string | null; pr: number | null }>): void {
    const current = this.getFeature(id)
    if (!current) return
    const next: FeatureState = {
      ...current,
      ...("sessionId" in fields ? { sessionId: fields.sessionId ?? null } : {}),
      ...("pr" in fields ? { pr: fields.pr ?? null } : {}),
    }
    const sets: string[] = ["time_updated = ?", "state = ?"]
    const params: (string | number | null)[] = [Date.now(), JSON.stringify(next)]
    if ("pr" in fields) {
      sets.push("pr = ?")
      params.push(next.pr)
    }
    params.push(id)
    this.db.run(`UPDATE feature SET ${sets.join(", ")} WHERE id = ?`, params as never)
    this.emit({ kind: "feature", featureId: id })
  }

  insertRun(input: {
    featureId: string
    jobId: string
    stepId: string
    stepType: "agent" | "command" | "action"
    attempt: number
    sessionId?: string
    metadata?: RunActionMetadata
  }): string {
    const id = randomUUID()
    this.db.run(
      `INSERT INTO run (id, feature_id, job_id, step_id, step_type, attempt, session_id, metadata, time_started)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.featureId,
        input.jobId,
        input.stepId,
        input.stepType,
        input.attempt,
        input.sessionId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        Date.now(),
      ],
    )
    this.emit({ kind: "run", featureId: input.featureId })
    return id
  }

  finishRun(runId: string, status: "succeeded" | "failed" | "reaped", detail?: { outputs?: Readonly<Record<string, string>>; reason?: string }): void {
    this.db.run(
      "UPDATE run SET status = ?, outputs = ?, reason = ?, time_finished = ? WHERE id = ?",
      [status, JSON.stringify(detail?.outputs ?? {}), detail?.reason ?? null, Date.now(), runId],
    )
    const featureId = (this.db.query("SELECT feature_id FROM run WHERE id = ?").get(runId) as { feature_id: string } | null)?.feature_id
    if (featureId) this.emit({ kind: "run", featureId })
  }

  /**
   * Records a durable-pending action's next-observation policy on its run
   * row — the run stays `running`, no new row is inserted, and the
   * attempt counter is untouched. Guarded by `WHERE status = 'running'`:
   * if the run concluded meanwhile (e.g. TTL-reaped by a concurrent
   * reconcile pass), this returns false and the caller drops the
   * observation instead of resurrecting a finished run.
   */
  recordPendingObservation(runId: string, state: Readonly<Record<string, unknown>> | null, nextObservation: number): boolean {
    return this.db.run(
      "UPDATE run SET pending_state = ?, next_observation = ? WHERE id = ? AND status = 'running'",
      [state ? JSON.stringify(state) : null, nextObservation, runId],
    ).changes > 0
  }

  /**
   * Claims a run's session id — only while the run is still 'running'. A
   * run can be reaped (TTL, missing session) by the reconciler WHILE a
   * dispatch call is still awaiting session creation for it; when that
   * stale call finally resolves, this guard makes the claim a no-op (0
   * rows affected → false) instead of writing a session id onto an
   * already-concluded run row. Callers MUST check the return value and
   * skip prompting when it is false.
   */
  setRunSession(runId: string, sessionId: string): boolean {
    return this.db.run("UPDATE run SET session_id = ? WHERE id = ? AND status = 'running'", [sessionId, runId]).changes > 0
  }

  /**
   * Atomically concludes a run and applies the feature transition it
   * triggers: closes the crash window between "run finished" and
   * "feature advanced" by making both writes one transaction. The
   * `WHERE status = 'running'` guard is also the single point where a
   * duplicate report (e.g. an agent retries `report()` after a timeout)
   * is caught — the second call sees zero rows affected and returns
   * false without touching the feature or its transition log.
   *
   * Also persists `transition.decisions` as `completion_decisions` with
   * `action_handled = 0` — a durable outbox row. If the process crashes
   * between this commit and the engine acting on those decisions, a
   * restarted reconciler can find and finish them instead of leaving the
   * feature stuck on its old current step forever.
   */
  concludeRun(
    runId: string,
    status: "succeeded" | "failed" | "reaped",
    detail: { outputs?: Readonly<Record<string, string>>; reason?: string } | undefined,
    event: PipelineEvent,
    transition: Transition,
  ): boolean {
    let featureId: string | null = null
    const claimed = this.db.transaction(() => {
      const result = this.db.run(
        `UPDATE run SET status = ?, outputs = ?, reason = ?, completion_event = ?, completion_decisions = ?, action_handled = 0, time_finished = ?
         WHERE id = ? AND status = 'running'`,
        [
          status,
          JSON.stringify(detail?.outputs ?? {}),
          detail?.reason ?? null,
          JSON.stringify(event),
          JSON.stringify(transition.decisions),
          Date.now(),
          runId,
        ],
      )
      if (result.changes === 0) return false
      const run = this.db.query("SELECT feature_id FROM run WHERE id = ?").get(runId) as { feature_id: string } | null
      if (!run) return false
      this.applyTransitionTx(run.feature_id, event, transition)
      featureId = run.feature_id
      return true
    })()
    if (claimed && featureId !== null) this.emit({ kind: "transition", featureId })
    return claimed
  }

  /**
   * The latest concluded-but-unacted-on decisions for a feature — the
   * durable pending-action outbox `concludeRun` writes. Null once
   * `markRunActionHandled` closes it out (the normal, no-crash path) or
   * when nothing has ever concluded via `concludeRun` for this feature.
   */
  getPendingRunAction(featureId: string): { runId: string; decisions: readonly Decision[] } | null {
    const row = this.db.query(
      `SELECT id, completion_decisions FROM run
       WHERE feature_id = ? AND action_handled = 0 AND completion_decisions IS NOT NULL
       ORDER BY time_finished DESC LIMIT 1`,
    ).get(featureId) as { id: string; completion_decisions: string } | null
    if (!row) return null
    return { runId: row.id, decisions: JSON.parse(row.completion_decisions) as Decision[] }
  }

  /** Atomic 0→1 claim: false if the run was never pending or is already handled. */
  markRunActionHandled(runId: string): boolean {
    return this.db.run("UPDATE run SET action_handled = 1 WHERE id = ? AND action_handled = 0", [runId]).changes > 0
  }

  getActiveRun(featureId: string): RunSummary | null {
    const row = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? AND status = 'running' ORDER BY time_started DESC LIMIT 1`,
    ).get(featureId) as RunRow | null
    return row ? toRunSummary(row) : null
  }

  /** Every currently in-flight run for a feature — a DAG feature can have several at once (fan-out). */
  listActiveRuns(featureId: string): RunSummary[] {
    const rows = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? AND status = 'running' ORDER BY time_started ASC`,
    ).all(featureId) as RunRow[]
    return rows.map(toRunSummary)
  }

  /** The in-flight run (if any) for one exact job+step — used to detect a dispatch that never happened. */
  getActiveRunForStep(featureId: string, jobId: string, stepId: string): RunSummary | null {
    const row = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? AND job_id = ? AND step_id = ? AND status = 'running'
       ORDER BY time_started DESC LIMIT 1`,
    ).get(featureId, jobId, stepId) as RunRow | null
    return row ? toRunSummary(row) : null
  }

  listRuns(featureId: string, limit = 100): RunSummary[] {
    const rows = this.db.query(
      `SELECT * FROM run WHERE feature_id = ? ORDER BY time_started DESC LIMIT ?`,
    ).all(featureId, limit) as RunRow[]
    return rows.map(toRunSummary)
  }

  incrementNudges(runId: string): number {
    this.db.run("UPDATE run SET nudges = nudges + 1 WHERE id = ?", [runId])
    const row = this.db.query("SELECT nudges FROM run WHERE id = ?").get(runId) as { nudges: number } | null
    return row?.nudges ?? 0
  }

  getRunById(runId: string): RunSummary | null {
    const row = this.db.query("SELECT * FROM run WHERE id = ?").get(runId) as RunRow | null
    return row ? toRunSummary(row) : null
  }

  // ------------------------------------------------------------ findings

  listFindings(featureId: string): FindingView[] {
    const rows = this.db.query("SELECT * FROM finding WHERE feature_id = ? ORDER BY seq").all(featureId) as Array<{
      id: string
      step_id: string
      path: string
      line: number
      severity: string
      tags: string
      body: string
      status: "new" | "fixed" | "dismissed" | "reopened"
      resolution: string | null
      thread_id: string | null
      synced: number
    }>
    return rows.map(row => ({
      id: row.id.split(":").pop() ?? row.id,
      stepId: row.step_id,
      path: row.path,
      line: row.line,
      severity: row.severity,
      tags: JSON.parse(row.tags) as string[],
      body: row.body,
      status: row.status,
      resolution: row.resolution,
      threadId: row.thread_id,
      synced: row.synced === 1,
    }))
  }

  /** One grouped query for the list projection — never one query per feature. */
  countFindingsByStatus(featureIds: readonly string[]): ReadonlyMap<string, FindingCounts> {
    const counts = new Map<string, FindingCounts>()
    if (featureIds.length === 0) return counts
    const rows = this.db.query(
      `SELECT feature_id, status, COUNT(*) AS total FROM finding
       WHERE feature_id IN (${featureIds.map(() => "?").join(", ")})
       GROUP BY feature_id, status`,
    ).all(...featureIds) as Array<{ feature_id: string; status: "new" | "fixed" | "dismissed" | "reopened"; total: number }>
    for (const row of rows) {
      const existing = counts.get(row.feature_id) ?? { new: 0, fixed: 0, dismissed: 0, reopened: 0 }
      counts.set(row.feature_id, { ...existing, [row.status]: row.total })
    }
    return counts
  }

  insertFindings(featureId: string, stepId: string, findings: ReadonlyArray<{
    path: string
    line: number
    severity: string
    tags: readonly string[]
    body: string
  }>): string[] {
    const now = Date.now()
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM finding WHERE feature_id = ?").get(featureId) as { maxSeq: number }
    const ids: string[] = []
    this.db.transaction(() => {
      for (const [offset, finding] of findings.entries()) {
        const seq = row.maxSeq + offset + 1
        const id = `F${seq}`
        this.db.run(
          `INSERT INTO finding (id, feature_id, seq, step_id, path, line, severity, tags, body, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`${featureId}:${id}`, featureId, seq, stepId, finding.path, finding.line, finding.severity, JSON.stringify(finding.tags), finding.body, now, now],
        )
        ids.push(id)
      }
    })()
    if (ids.length > 0) this.emit({ kind: "finding", featureId })
    return ids
  }

  setFindingStatus(featureId: string, shortId: string, status: "new" | "fixed" | "dismissed" | "reopened", resolution?: string): boolean {
    const result = this.db.run(
      `UPDATE finding SET status = ?, resolution = COALESCE(?, resolution), synced = 0, time_updated = ?
       WHERE id = ?`,
      [status, resolution ?? null, Date.now(), `${featureId}:${shortId}`],
    )
    if (result.changes > 0) this.emit({ kind: "finding", featureId })
    return result.changes > 0
  }

  // --------------------------------------------------------------- audit

  getTransitions(featureId: string, limit = 50): TransitionEntry[] {
    const rows = this.db.query(
      `SELECT event, decisions, time_created FROM transition_log
       WHERE feature_id = ? ORDER BY time_created DESC LIMIT ?`,
    ).all(featureId, limit) as Array<{ event: string; decisions: string; time_created: number }>
    return rows.map(row => ({
      event: JSON.parse(row.event) as PipelineEvent,
      decisions: JSON.parse(row.decisions) as Decision[],
      time: row.time_created,
    }))
  }
}

function escalationReason(decisions: readonly Decision[]): string | null {
  const escalation = decisions.find((decision): decision is Extract<Decision, { kind: "escalate" }> => decision.kind === "escalate")
  return escalation?.reason ?? null
}
