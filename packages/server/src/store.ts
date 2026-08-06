import { randomUUID } from "node:crypto"
import type { Database } from "./database.ts"

export type FeatureStatus = "running" | "paused" | "waiting_human" | "escalated" | "done" | "abandoned"

export interface FeatureState {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly projectDir: string
  readonly workflow: string | null
  readonly description: string | null
  readonly status: FeatureStatus
  readonly currentStep: string | null
  readonly sessionId: string | null
  readonly worktree: string | null
  readonly branch: string | null
  readonly pr: number | null
  readonly attempts: Readonly<Record<string, number>>
  readonly rounds: Readonly<Record<string, number>>
  readonly escalation: string | null
}

export type PipelineEvent =
  | { readonly kind: "feature.start" }
  | { readonly kind: "step.succeeded"; readonly stepId: string; readonly output?: string }
  | { readonly kind: "step.failed"; readonly stepId: string; readonly reason: string }
  | { readonly kind: "step.verdict"; readonly stepId: string; readonly verdict: string }
  | { readonly kind: "human.approved"; readonly stepId: string }
  | { readonly kind: "human.rejected"; readonly stepId: string; readonly notes?: string }
  | { readonly kind: "human.paused" }
  | { readonly kind: "human.resumed" }
  | { readonly kind: "human.abandoned" }

export type Decision =
  | { readonly kind: "execute"; readonly stepId: string }
  | { readonly kind: "wait_human"; readonly stepId: string }
  | { readonly kind: "escalate"; readonly reason: string }
  | { readonly kind: "finish" }
  | { readonly kind: "pause" }
  | { readonly kind: "abandon" }
  | { readonly kind: "noop"; readonly reason: string }

export interface Transition {
  readonly decision: Decision
  readonly patch: Partial<{
    status: FeatureStatus
    currentStep: string | null
    attempts: Readonly<Record<string, number>>
    rounds: Readonly<Record<string, number>>
    escalation: string | null
  }>
}

interface FeatureRow {
  id: string
  title: string
  slug: string
  project_dir: string
  status: FeatureStatus
  current_step: string | null
  workflow: string | null
  description: string | null
  session_id: string | null
  worktree: string | null
  branch: string | null
  pr: number | null
  attempts: string
  rounds: string
  escalation: string | null
}

function toState(row: FeatureRow): FeatureState {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    projectDir: row.project_dir,
    workflow: row.workflow,
    description: row.description,
    status: row.status,
    currentStep: row.current_step,
    sessionId: row.session_id,
    worktree: row.worktree,
    branch: row.branch,
    pr: row.pr,
    attempts: JSON.parse(row.attempts) as Record<string, number>,
    rounds: JSON.parse(row.rounds) as Record<string, number>,
    escalation: row.escalation,
  }
}

export class Store {
  constructor(private readonly db: Database) {}

  createFeature(input: {
    title: string
    slug: string
    projectDir: string
    workflow?: string
    description?: string
  }): FeatureState {
    const now = Date.now()
    const id = randomUUID()
    this.db.run(
      `INSERT INTO feature (id, title, slug, project_dir, workflow, description, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title, input.slug, input.projectDir, input.workflow ?? null, input.description ?? null, now, now],
    )
    const state = this.getFeature(id)
    if (!state) throw new Error(`conductor: feature ${id} vanished after insert`)
    return state
  }

  getFeature(id: string): FeatureState | null {
    const row = this.db.query("SELECT * FROM feature WHERE id = ?").get(id) as FeatureRow | null
    return row ? toState(row) : null
  }

  listFeatures(filter?: { activeOnly?: boolean; projectDir?: string }): FeatureState[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter?.activeOnly) clauses.push("status IN ('running','paused','waiting_human','escalated')")
    if (filter?.projectDir !== undefined) {
      clauses.push("project_dir = ?")
      params.push(filter.projectDir)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.db.query(`SELECT * FROM feature ${where} ORDER BY time_created DESC`).all(...params) as FeatureRow[]
    return rows.map(toState)
  }

  findFeatureByPr(pr: number): FeatureState | null {
    const row = this.db.query("SELECT * FROM feature WHERE pr = ? AND status NOT IN ('done','abandoned')").get(pr) as FeatureRow | null
    return row ? toState(row) : null
  }

  applyTransition(featureId: string, event: PipelineEvent, transition: Transition): void {
    this.db.transaction(() => this.applyTransitionTx(featureId, event, transition))()
  }

  private applyTransitionTx(featureId: string, event: PipelineEvent, transition: Transition): void {
    const { patch, decision } = transition
    const sets: string[] = ["time_updated = ?"]
    const params: (string | number | null)[] = [Date.now()]
    if (patch.status !== undefined) {
      sets.push("status = ?")
      params.push(patch.status)
    }
    if (patch.currentStep !== undefined) {
      sets.push("current_step = ?")
      params.push(patch.currentStep)
    }
    if (patch.attempts !== undefined) {
      sets.push("attempts = ?")
      params.push(JSON.stringify(patch.attempts))
    }
    if (patch.rounds !== undefined) {
      sets.push("rounds = ?")
      params.push(JSON.stringify(patch.rounds))
    }
    if (patch.escalation !== undefined) {
      sets.push("escalation = ?")
      params.push(patch.escalation)
    } else if (decision.kind === "escalate") {
      sets.push("escalation = ?")
      params.push(decision.reason)
    }
    params.push(featureId)
    this.db.run(`UPDATE feature SET ${sets.join(", ")} WHERE id = ?`, params as never)
    this.db.run(
      `INSERT INTO transition_log (feature_id, event, decision, detail, time_created)
       VALUES (?, ?, ?, ?, ?)`,
      [featureId, JSON.stringify(event), decision.kind, decisionDetail(decision), Date.now()],
    )
  }

  setFeatureFields(id: string, fields: Partial<{
    sessionId: string | null
    worktree: string | null
    branch: string | null
    pr: number | null
  }>): void {
    const sets: string[] = ["time_updated = ?"]
    const params: (string | number | null)[] = [Date.now()]
    if ("sessionId" in fields) {
      sets.push("session_id = ?")
      params.push(fields.sessionId ?? null)
    }
    if ("worktree" in fields) {
      sets.push("worktree = ?")
      params.push(fields.worktree ?? null)
    }
    if ("branch" in fields) {
      sets.push("branch = ?")
      params.push(fields.branch ?? null)
    }
    if ("pr" in fields) {
      sets.push("pr = ?")
      params.push(fields.pr ?? null)
    }
    params.push(id)
    this.db.run(`UPDATE feature SET ${sets.join(", ")} WHERE id = ?`, params as never)
  }

  startRun(input: {
    featureId: string
    stepId: string
    stepType: "builtin" | "command" | "agent"
    attempt: number
    role?: string
    model?: string
    sessionId?: string
  }): string {
    const id = randomUUID()
    this.db.run(
      `INSERT INTO step_run (id, feature_id, step_id, step_type, attempt, role, model, session_id, time_started)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.featureId, input.stepId, input.stepType, input.attempt, input.role ?? null, input.model ?? null, input.sessionId ?? null, Date.now()],
    )
    return id
  }

  finishRun(runId: string, status: "succeeded" | "failed" | "reaped", detail?: { output?: string; reason?: string }): void {
    this.db.run(
      "UPDATE step_run SET status = ?, output = ?, reason = ?, time_finished = ? WHERE id = ?",
      [status, detail?.output ?? null, detail?.reason ?? null, Date.now(), runId],
    )
  }

  /**
   * Claims a run's session id — only while the run is still 'running'. A
   * run can be reaped (TTL, missing session) by the reconciler WHILE an
   * `executeAgent` call is still awaiting session creation for it; when
   * that stale call finally resolves, this guard makes the claim a no-op
   * (0 rows affected → false) instead of writing a session id onto an
   * already-concluded run row. Callers MUST check the return value and
   * skip prompting when it is false — otherwise a session nobody is
   * tracking anymore gets prompted into doing work for a run that has
   * already moved on (a retry run may already be in flight for the same
   * step).
   */
  setRunSession(runId: string, sessionId: string, featureSessionId?: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.query(
        "SELECT feature_id FROM step_run WHERE id = ? AND status = 'running'",
      ).get(runId) as { feature_id: string } | null
      if (!row) return false
      this.db.run("UPDATE step_run SET session_id = ? WHERE id = ?", [sessionId, runId])
      if (featureSessionId !== undefined) {
        this.db.run("UPDATE feature SET session_id = ?, time_updated = ? WHERE id = ?", [featureSessionId, Date.now(), row.feature_id])
      }
      return true
    })()
  }

  /**
   * Atomically concludes a run and applies the feature transition it
   * triggers: closes the crash window between "run finished" and "feature
   * advanced" by making both writes one transaction. The `WHERE status =
   * 'running'` guard also makes this the single point where a duplicate
   * report (e.g. an agent retries `report()` after a timeout) is caught —
   * the second call sees zero rows affected and returns false without
   * touching the feature or its transition log.
   *
   * Also persists `transition.decision` as `completion_decision` with
   * `action_handled = 0` — a durable outbox row. If the process crashes
   * between this commit and the engine acting on that decision (the next
   * `dispatch`/notify), `getPendingRunAction` lets a restarted reconciler
   * find and finish exactly that decision instead of leaving the feature
   * stuck on its old current step forever.
   */
  concludeRun(
    runId: string,
    status: "succeeded" | "failed" | "reaped",
    detail: { output?: string; reason?: string } | undefined,
    event: PipelineEvent,
    transition: Transition,
  ): boolean {
    return this.db.transaction(() => {
      const result = this.db.run(
        `UPDATE step_run SET status = ?, output = ?, reason = ?, completion_event = ?, completion_decision = ?, action_handled = 0, time_finished = ?
         WHERE id = ? AND status = 'running'`,
        [status, detail?.output ?? null, detail?.reason ?? null, JSON.stringify(event), JSON.stringify(transition.decision), Date.now(), runId],
      )
      if (result.changes === 0) return false
      const run = this.db.query("SELECT feature_id FROM step_run WHERE id = ?").get(runId) as { feature_id: string } | null
      if (!run) return false
      this.applyTransitionTx(run.feature_id, event, transition)
      return true
    })()
  }

  /**
   * The latest concluded-but-unacted-on decision for a feature — the
   * durable pending-action outbox `concludeRun` writes. Null once
   * `markRunActionHandled` closes it out (the normal, no-crash path) or
   * when nothing has ever concluded via `concludeRun` for this feature.
   */
  getPendingRunAction(featureId: string): { runId: string; decision: Decision } | null {
    const row = this.db.query(
      `SELECT id, completion_decision FROM step_run
       WHERE feature_id = ? AND action_handled = 0 AND completion_decision IS NOT NULL
       ORDER BY time_finished DESC LIMIT 1`,
    ).get(featureId) as { id: string; completion_decision: string } | null
    if (!row) return null
    return { runId: row.id, decision: JSON.parse(row.completion_decision) as Decision }
  }

  /** Atomic 0→1 claim: false if the run was never pending or is already handled. */
  markRunActionHandled(runId: string): boolean {
    return this.db.run("UPDATE step_run SET action_handled = 1 WHERE id = ? AND action_handled = 0", [runId]).changes > 0
  }

  getActiveRun(featureId: string): {
    id: string
    stepId: string
    stepType: string
    attempt: number
    sessionId: string | null
    timeStarted: number
    nudges: number
  } | null {
    const row = this.db.query(
      `SELECT id, step_id, step_type, attempt, session_id, time_started, nudges
       FROM step_run WHERE feature_id = ? AND status = 'running'
       ORDER BY time_started DESC LIMIT 1`,
    ).get(featureId) as {
      id: string
      step_id: string
      step_type: string
      attempt: number
      session_id: string | null
      time_started: number
      nudges: number
    } | null
    return row ? {
      id: row.id,
      stepId: row.step_id,
      stepType: row.step_type,
      attempt: row.attempt,
      sessionId: row.session_id,
      timeStarted: row.time_started,
      nudges: row.nudges,
    } : null
  }

  incrementNudges(runId: string): number {
    this.db.run("UPDATE step_run SET nudges = nudges + 1 WHERE id = ?", [runId])
    const row = this.db.query("SELECT nudges FROM step_run WHERE id = ?").get(runId) as { nudges: number } | null
    return row?.nudges ?? 0
  }

  getRunById(runId: string): {
    featureId: string
    stepId: string
    status: string
    role: string | null
    attempt: number
    output: string | null
    reason: string | null
    completionEvent: string | null
  } | null {
    const row = this.db.query(
      "SELECT feature_id, step_id, status, role, attempt, output, reason, completion_event FROM step_run WHERE id = ?",
    ).get(runId) as {
      feature_id: string
      step_id: string
      status: string
      role: string | null
      attempt: number
      output: string | null
      reason: string | null
      completion_event: string | null
    } | null
    return row ? {
      featureId: row.feature_id,
      stepId: row.step_id,
      status: row.status,
      role: row.role,
      attempt: row.attempt,
      output: row.output,
      reason: row.reason,
      completionEvent: row.completion_event,
    } : null
  }

  getLastHumanNotes(featureId: string, stepId: string): string | null {
    const row = this.db.query(
      `SELECT output FROM step_run
       WHERE feature_id = ? AND step_id = ? AND reason LIKE 'human %'
         AND output IS NOT NULL AND output != ''
       ORDER BY time_finished DESC LIMIT 1`,
    ).get(featureId, stepId) as { output: string | null } | null
    return row?.output ?? null
  }

  getLastOutput(featureId: string, stepId: string): string | null {
    const row = this.db.query(
      `SELECT output FROM step_run
       WHERE feature_id = ? AND step_id = ? AND status IN ('succeeded','failed')
       ORDER BY time_finished DESC LIMIT 1`,
    ).get(featureId, stepId) as { output: string | null } | null
    return row?.output ?? null
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
    return ids
  }

  listFindings(featureId: string): Array<{
    id: string
    stepId: string
    path: string
    line: number
    severity: string
    tags: string[]
    body: string
    status: "new" | "fixed" | "dismissed" | "reopened"
    resolution: string | null
    threadId: string | null
    synced: boolean
  }> {
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

  setFindingStatus(featureId: string, shortId: string, status: "new" | "fixed" | "dismissed" | "reopened", resolution?: string): boolean {
    const result = this.db.run(
      `UPDATE finding SET status = ?, resolution = COALESCE(?, resolution), synced = 0, time_updated = ?
       WHERE id = ?`,
      [status, resolution ?? null, Date.now(), `${featureId}:${shortId}`],
    )
    return result.changes > 0
  }

  setFindingThread(featureId: string, shortId: string, threadId: string): void {
    this.db.run("UPDATE finding SET thread_id = ?, time_updated = ? WHERE id = ?", [threadId, Date.now(), `${featureId}:${shortId}`])
  }

  markFindingSynced(featureId: string, shortId: string): void {
    this.db.run("UPDATE finding SET synced = 1, time_updated = ? WHERE id = ?", [Date.now(), `${featureId}:${shortId}`])
  }

  upsertThread(input: {
    threadId: string
    featureId: string
    pr: number
    path: string
    openedBy: string
    lastReplyBy: string
    lastReply: string
  }): "open" | "auto_resolved" | "reopened" {
    const now = Date.now()
    const existing = this.db.query("SELECT status FROM review_thread WHERE thread_id = ?").get(input.threadId) as { status: string } | null
    const status = existing?.status === "auto_resolved" ? "reopened" : (existing?.status ?? "open")
    this.db.run(
      `INSERT INTO review_thread (thread_id, feature_id, pr, path, opened_by, last_reply_by, last_reply, status, time_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         last_reply_by = excluded.last_reply_by,
         last_reply = excluded.last_reply,
         status = excluded.status,
         time_seen = excluded.time_seen`,
      [input.threadId, input.featureId, input.pr, input.path, input.openedBy, input.lastReplyBy, input.lastReply.slice(0, 2000), status, now],
    )
    return status as "open" | "auto_resolved" | "reopened"
  }

  markThreadResolved(threadId: string): void {
    this.db.run("UPDATE review_thread SET status = 'auto_resolved', time_resolved = ? WHERE thread_id = ?", [Date.now(), threadId])
  }

  upsertPrHead(featureId: string, pr: number, headSha: string, status: string): void {
    const now = Date.now()
    this.db.run(
      `INSERT INTO pr_head (feature_id, pr, head_sha, status, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr, head_sha) DO UPDATE SET status = excluded.status, time_updated = excluded.time_updated`,
      [featureId, pr, headSha, status, now, now],
    )
  }

  supersedeOldHeads(pr: number, currentSha: string): number {
    return this.db.run(
      `UPDATE pr_head SET status = 'superseded', time_updated = ?
       WHERE pr = ? AND head_sha != ? AND status NOT IN ('superseded','timed_out')`,
      [Date.now(), pr, currentSha],
    ).changes
  }

  getPrHead(pr: number, headSha: string): { status: string } | null {
    return this.db.query("SELECT status FROM pr_head WHERE pr = ? AND head_sha = ?").get(pr, headSha) as { status: string } | null
  }

  getTransitions(featureId: string, limit = 50): Array<{ event: string; decision: string; detail: string | null; time: number }> {
    const rows = this.db.query(
      `SELECT event, decision, detail, time_created FROM transition_log
       WHERE feature_id = ? ORDER BY time_created DESC LIMIT ?`,
    ).all(featureId, limit) as Array<{ event: string; decision: string; detail: string | null; time_created: number }>
    return rows.map(row => ({ event: row.event, decision: row.decision, detail: row.detail, time: row.time_created }))
  }
}

function decisionDetail(decision: Decision): string | null {
  switch (decision.kind) {
    case "execute":
    case "wait_human":
      return decision.stepId
    case "escalate":
    case "noop":
      return decision.reason
    default:
      return null
  }
}
