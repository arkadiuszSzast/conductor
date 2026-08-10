/**
 * The graph engine: owns all side effects around `@conductor/core`'s
 * pure `interpret()`, driving `conductor.yaml` workflows over the
 * extracted SQLite store.
 *
 *  - dispatches decisions (agent / command steps)
 *  - reconciles reality (sessions) with stored state on demand
 *  - reaps stuck agent runs after `runTtlMs` and feeds failures back as
 *    events, same operational behaviour as the deleted seed engine
 *  - keeps a per-feature parent session, created lazily and reused
 *    across steps, with each step dispatched to its own child session
 *
 * Confirmation-of-effect rule: an agent step is only "done" when its
 * session (or a human) reports through `report()`/`approve()`/
 * `requestChanges()` — never merely because a session went idle.
 * Idle-without-report after debounce ⇒ nudged, then reaped.
 *
 * Every dependency (store, workflow resolver, sessions, process
 * execution, clock, logger) is injected via `EngineDeps` — nothing here
 * reaches for an opencode SDK import, a process-wide global, or
 * `Date.now()` directly. `reconcile()` is a plain async method; the
 * daemon owns the timer.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_OUTCOME, buildEvalContext, interpret, renderTemplate } from "@conductor/core"
import type {
  AgentStep,
  CommandStep,
  Decision,
  FeatureState,
  PipelineEvent,
  StepDef,
  WorkflowDef,
} from "@conductor/core"
import type { Store } from "./store.ts"
import type { WorkflowResolver, WorkflowSnapshot } from "./workflow-registry.ts"
import type { Clock, Logger, ProcessRunner, SessionClient } from "./ports.ts"

const DEFAULT_RUN_TTL_MS = 3_600_000
const DEFAULT_NUDGE_IDLE_CYCLES = 2
const DEFAULT_MAX_NUDGES = 2

export interface EngineDeps {
  readonly store: Store
  readonly workflows: WorkflowResolver
  readonly sessions: SessionClient
  readonly process: ProcessRunner
  readonly clock: Clock
  readonly log: Logger
  readonly notify?: (title: string, message: string) => void
}

export interface EngineOptions {
  readonly runTtlMs?: number
  readonly nudgeIdleCycles?: number
  readonly maxNudges?: number
}

export type StartFeatureResult =
  | { readonly ok: true; readonly feature: FeatureState }
  | { readonly ok: false; readonly code: "project_not_configured" | "unknown_workflow"; readonly message: string }

export interface StartFeatureInput {
  readonly title: string
  readonly description?: string
  readonly workflow?: string
  readonly pr?: number
  readonly sessionId?: string
}

export class Engine {
  /**
   * Consecutive reconcile cycles each running agent run's session has
   * been idle (run id → count). In-memory by design: after a restart
   * the debounce restarts from zero — the safe direction of error.
   */
  private readonly idleCycles = new Map<string, number>()
  private readonly runTtlMs: number
  private readonly nudgeIdleCycles: number
  private readonly maxNudges: number

  constructor(
    private readonly deps: EngineDeps,
    options: EngineOptions = {},
  ) {
    this.runTtlMs = options.runTtlMs ?? DEFAULT_RUN_TTL_MS
    this.nudgeIdleCycles = options.nudgeIdleCycles ?? DEFAULT_NUDGE_IDLE_CYCLES
    this.maxNudges = options.maxNudges ?? DEFAULT_MAX_NUDGES
  }

  // ------------------------------------------------------------- starting

  async startFeature(projectDir: string, input: StartFeatureInput): Promise<StartFeatureResult> {
    const snapshot = this.deps.workflows(projectDir)
    if (!snapshot) {
      return { ok: false, code: "project_not_configured", message: `no valid workflow registered for "${projectDir}"` }
    }
    if (input.workflow !== undefined && input.workflow !== snapshot.workflow.name) {
      return {
        ok: false,
        code: "unknown_workflow",
        message: `unknown workflow "${input.workflow}" (available: ${snapshot.workflow.name})`,
      }
    }
    const feature = this.deps.store.createFeature({
      title: input.title,
      slug: slugify(input.title),
      projectDir,
      workflow: snapshot.workflow.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.pr !== undefined ? { pr: input.pr } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    })
    await this.dispatch(feature.id, { kind: "feature.start" })
    const after = this.deps.store.getFeature(feature.id) ?? feature
    return { ok: true, feature: after }
  }

  // ------------------------------------------------------------- dispatch

  /** Feed a state-only event (feature.start, human.paused/resumed/abandoned) through the interpreter and act on the decisions. */
  async dispatch(featureId: string, event: PipelineEvent): Promise<void> {
    const { store, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) {
      log.log(`dispatch: unknown feature ${featureId}`)
      return
    }
    const snapshot = this.deps.workflows(state.projectDir)
    if (!snapshot) {
      log.log(`feature=${state.slug}: no valid workflow for ${state.projectDir} — skipping`)
      return
    }
    const transition = interpret(snapshot.workflow, state, event)
    store.applyTransition(featureId, event, transition)
    log.log(`feature=${state.slug} event=${event.kind} → ${transition.decisions.map(decisionLabel).join(",")}`)
    await this.dispatchDecisions(featureId, snapshot, transition.decisions)
  }

  private async dispatchDecisions(featureId: string, snapshot: WorkflowSnapshot, decisions: readonly Decision[]): Promise<void> {
    for (const decision of decisions) {
      await this.actDecision(featureId, snapshot, decision)
    }
  }

  private async actDecision(featureId: string, snapshot: WorkflowSnapshot, decision: Decision): Promise<void> {
    switch (decision.kind) {
      case "execute_step": {
        const step = findStep(snapshot.workflow, decision.jobId, decision.stepId)
        if (!step) {
          this.deps.log.log(`feature=${featureId}: step "${decision.stepId}" not in job "${decision.jobId}" — escalating`)
          await this.dispatch(featureId, {
            kind: "step.failed",
            jobId: decision.jobId,
            stepId: decision.stepId,
            reason: `step "${decision.stepId}" no longer exists in job "${decision.jobId}" (workflow changed?)`,
          })
          return
        }
        if (step.type === "agent") return this.executeAgent(featureId, snapshot, decision.jobId, step)
        if (step.type === "command") return this.executeCommand(featureId, snapshot, decision.jobId, step)
        // "action" steps are registry-invalid at load, so a workflow with
        // one never publishes a snapshot — this branch should be
        // unreachable. Escalate loudly rather than silently dispatching.
        await this.dispatch(featureId, {
          kind: "step.failed",
          jobId: decision.jobId,
          stepId: decision.stepId,
          reason: "action steps require a configured action registry (unreachable: workflow should have failed validation at load)",
        })
        return
      }
      case "escalate": {
        const state = this.deps.store.getFeature(featureId)
        this.deps.notify?.(`Conductor: escalation — ${state?.slug ?? featureId}`, decision.reason)
        return
      }
      case "wait_human": {
        const state = this.deps.store.getFeature(featureId)
        this.deps.notify?.(
          `Conductor: approval needed — ${state?.slug ?? featureId}`,
          `Step "${decision.stepId}" (job "${decision.jobId}") awaits your approval.`,
        )
        return
      }
      case "skip_job":
      case "finish":
      case "pause":
      case "abandon":
      case "noop":
        return
    }
  }

  // ------------------------------------------------------------- execution

  private async executeAgent(featureId: string, snapshot: WorkflowSnapshot, jobId: string, step: AgentStep): Promise<void> {
    const { store, sessions, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return
    const role = snapshot.workflow.roles[step.role]
    if (!role) {
      await this.dispatch(featureId, { kind: "step.failed", jobId, stepId: step.id, reason: `role "${step.role}" not configured` })
      return
    }

    const attempt = (state.jobs[jobId]?.attempts[step.id] ?? 0) + 1
    const feedback = store.getFeedback(featureId) ?? undefined
    const context = buildEvalContext(snapshot.workflow, state, jobId, feedback)
    const rendered = renderTemplate(step.prompt, context)
    for (const error of rendered.errors) log.log(`job=${jobId} step=${step.id}: ${error}`)

    // Claim the run synchronously, BEFORE any await: this closes the
    // reconcile race a live daemon can hit — a concurrent reconcile pass
    // would otherwise see no run for this step while session setup below
    // is still in flight and re-dispatch it.
    const runId = store.insertRun({ featureId, jobId, stepId: step.id, stepType: "agent", attempt })

    try {
      let parentId = state.sessionId
      let createdParent = false
      if (parentId && !(await sessions.sessionExists(parentId))) {
        log.log(`feature=${state.slug}: stored session ${parentId} is gone — creating a new one`)
        parentId = null
      }
      if (!parentId) {
        const created = await sessions.createSession({
          title: `[conductor] ${state.title}`,
          directory: state.worktree ?? state.projectDir,
        })
        parentId = created.id
        createdParent = true
      }

      const sessionId = (
        await sessions.createSession({
          title: `[${role.agent}] ${state.title}${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
          directory: state.worktree ?? state.projectDir,
          parentID: parentId,
        })
      ).id

      // The run may already have been reaped (TTL, missing session,
      // restart recovery) while session creation above was in flight —
      // the `WHERE status = 'running'` guard catches that: a false
      // return means nobody owns this session anymore, and prompting it
      // would dispatch a retry run's step to an orphan session no one is
      // tracking. Bail without prompting.
      if (!store.setRunSession(runId, sessionId)) {
        log.log(`feature=${state.slug}: run ${runId} concluded before its session was ready — not prompting`)
        return
      }
      if (createdParent) store.setFeatureFields(featureId, { sessionId: parentId })

      const header =
        `[conductor] Job "${jobId}" step "${step.id}" (attempt ${attempt}) — run ${runId}.\n` +
        `When this step is complete you MUST report run_id="${runId}" and its outcome.\n\n`

      await sessions.prompt({
        sessionID: sessionId,
        text: header + rendered.text,
        agent: role.agent,
        ...(role.model !== undefined ? { model: role.model } : {}),
      })
    } catch (err) {
      const reason = `failed to prompt session: ${errorMessage(err)}`
      await this.concludeAndDispatch(featureId, runId, "failed", { reason }, { kind: "step.failed", jobId, stepId: step.id, reason })
    }
  }

  private async executeCommand(featureId: string, snapshot: WorkflowSnapshot, jobId: string, step: CommandStep): Promise<void> {
    const { store, process } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return
    const attempt = (state.jobs[jobId]?.attempts[step.id] ?? 0) + 1
    const feedback = store.getFeedback(featureId) ?? undefined
    const context = buildEvalContext(snapshot.workflow, state, jobId, feedback)
    const cwd = step.cwd !== undefined ? renderTemplate(step.cwd, context).text : (state.worktree ?? state.projectDir)

    const runId = store.insertRun({ featureId, jobId, stepId: step.id, stepType: "command", attempt })

    const outputDir = await mkdtemp(join(tmpdir(), "conductor-output-"))
    const outputPath = join(outputDir, "outputs")
    try {
      let failureReason: string | null = null
      for (const raw of step.run) {
        const command = renderTemplate(raw, context).text
        const result = await process.shell(command, {
          cwd,
          env: { CONDUCTOR_OUTPUT: outputPath },
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        })
        if (result.code !== 0) {
          failureReason = `"${command}" exited ${result.code}: ${result.output.slice(-4000)}`
          break
        }
      }
      const outputs = await readOutputFile(outputPath)

      if (failureReason !== null) {
        await this.concludeAndDispatch(
          featureId,
          runId,
          "failed",
          { outputs, reason: failureReason },
          { kind: "step.failed", jobId, stepId: step.id, reason: failureReason },
        )
        return
      }
      await this.concludeAndDispatch(
        featureId,
        runId,
        "succeeded",
        { outputs },
        { kind: "step.completed", jobId, stepId: step.id, outcome: DEFAULT_OUTCOME, outputs },
      )
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  }

  // ------------------------------------------------------------ conclusion

  /**
   * Atomically concludes a run and dispatches the decisions its
   * transition produces — the single call site every run-completion
   * path (command, agent prompt failure, reaper, `report()`) goes
   * through. Returns whether the caller's conclusion attempt won the
   * atomic claim (false = a duplicate/concurrent conclusion already won
   * it — no further side effect should happen).
   */
  private async concludeAndDispatch(
    featureId: string,
    runId: string,
    status: "succeeded" | "failed" | "reaped",
    detail: { outputs?: Readonly<Record<string, string>>; reason?: string } | undefined,
    event: PipelineEvent,
  ): Promise<boolean> {
    const { store, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return false
    const snapshot = this.deps.workflows(state.projectDir)
    if (!snapshot) return false
    const transition = interpret(snapshot.workflow, state, event)
    const claimed = store.concludeRun(runId, status, detail, event, transition)
    if (!claimed) return false
    log.log(`feature=${state.slug} event=${event.kind} → ${transition.decisions.map(decisionLabel).join(",")}`)
    // Dispatch, THEN mark the outbox entry handled: a crash mid-dispatch
    // (e.g. during an agent's session creation) leaves the entry pending
    // so a restarted reconciler recovers it — the normal path closes it
    // out here so it never lingers as a false "pending" forever.
    await this.dispatchDecisions(featureId, snapshot, transition.decisions)
    store.markRunActionHandled(runId)
    return true
  }

  // --------------------------------------------------------------- reports

  /**
   * Called by the API's report endpoint from inside agent sessions. The
   * ONLY path by which an agent step concludes — idle never does.
   */
  async report(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string }): Promise<string> {
    const { store } = this.deps
    const run = store.getRunById(input.runId)
    if (!run) return `Unknown run_id "${input.runId}".`
    if (run.status !== "running") return alreadyConcludedText(input.runId, run.status)

    const event: PipelineEvent =
      input.outcome === "failed"
        ? { kind: "step.failed", jobId: run.jobId, stepId: run.stepId, reason: input.notes ?? "reported failed" }
        : {
            kind: "step.completed",
            jobId: run.jobId,
            stepId: run.stepId,
            outcome: input.verdict ?? DEFAULT_OUTCOME,
            outputs: { report: input.notes ?? "" },
          }
    const status: "succeeded" | "failed" = input.outcome === "failed" ? "failed" : "succeeded"
    const detail = status === "failed" ? { reason: input.notes ?? "reported failed" } : { outputs: { report: input.notes ?? "" } }

    const claimed = await this.concludeAndDispatch(run.featureId, input.runId, status, detail, event)
    if (!claimed) {
      const after = store.getRunById(input.runId)
      return alreadyConcludedText(input.runId, after?.status ?? run.status)
    }
    if (status === "failed") return `Step "${run.stepId}" marked failed.`
    if (input.verdict !== undefined) return `Verdict "${input.verdict}" recorded for step "${run.stepId}".`
    return `Step "${run.stepId}" marked succeeded.`
  }

  /**
   * Human approves at a waiting_human gate, optionally with notes
   * ("approve, but tweak X"). Applies to every step currently at
   * `waiting_human` (the common case is exactly one; a DAG with several
   * concurrent gates approves each in turn).
   */
  async approve(featureId: string, notes?: string): Promise<string> {
    return this.resolveGates(featureId, "approved", notes?.trim() ?? "", "Approved")
  }

  /** Human "request changes" at a waiting_human gate. `notes` is required by the API layer; the engine trusts what it is given. */
  async requestChanges(featureId: string, notes: string): Promise<string> {
    return this.resolveGates(featureId, "rejected", notes, "Changes requested")
  }

  private async resolveGates(featureId: string, outcome: string, notes: string, verb: string): Promise<string> {
    const { store, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return `Unknown feature "${featureId}".`
    const waiting = waitingHumanSteps(state)
    if (waiting.length === 0) {
      return `Feature "${state.title}" is not waiting for approval (status: ${state.status}).`
    }
    const snapshot = this.deps.workflows(state.projectDir)
    if (!snapshot) return `no valid workflow for "${state.projectDir}"`

    const allDecisions: Decision[] = []
    for (const { jobId, stepId } of waiting) {
      const current = store.getFeature(featureId)
      if (!current) break
      const event: PipelineEvent = { kind: "step.completed", jobId, stepId, outcome, outputs: { notes } }
      const transition = interpret(snapshot.workflow, current, event)
      store.applyTransition(featureId, event, transition)
      log.log(`feature=${state.slug} event=${event.kind} → ${transition.decisions.map(decisionLabel).join(",")}`)
      allDecisions.push(...transition.decisions)
    }
    await this.dispatchDecisions(featureId, snapshot, allDecisions)
    const after = store.getFeature(featureId)
    return `${verb}${notes.length > 0 ? " (notes recorded)" : ""}. Feature "${state.title}" is now: ${after?.status ?? state.status}.`
  }

  // ------------------------------------------------------------ lifecycle

  async pause(featureId: string): Promise<void> {
    await this.dispatch(featureId, { kind: "human.paused" })
  }

  async resume(featureId: string): Promise<void> {
    await this.dispatch(featureId, { kind: "human.resumed" })
  }

  async abandon(featureId: string): Promise<void> {
    await this.dispatch(featureId, { kind: "human.abandoned" })
  }

  // ------------------------------------------------------------ reconciler

  /**
   * One reconcile pass. Called on an interval by the daemon and after
   * startup recovery. Idempotent: every action is guarded by stored
   * state. Per-feature errors are isolated — one feature's failure never
   * blocks another's reconciliation.
   */
  async reconcile(): Promise<void> {
    const { store, log } = this.deps
    const features = store.listFeatures({ activeOnly: true })
    for (const feature of features) {
      try {
        await this.reconcileFeature(feature)
      } catch (err) {
        log.log(`reconcile ${feature.slug}: ${errorMessage(err)}`)
      }
    }
  }

  private async reconcileFeature(input: FeatureState): Promise<void> {
    const { store, log } = this.deps
    const snapshot = this.deps.workflows(input.projectDir)
    if (!snapshot) return

    // Restart recovery runs FIRST, unconditionally: decisions committed
    // by `concludeRun` but never acted on (process died in the gap) must
    // be replayed before the normal per-job reconciliation below sees
    // the post-recovery state. Claim the whole batch atomically (0→1);
    // each `execute_step` decision whose run already exists (dispatch
    // completed before the crash) is skipped — every other decision
    // kind is a pure notify/no-op and safe to replay unconditionally.
    const pending = store.getPendingRunAction(input.id)
    if (pending && store.markRunActionHandled(pending.runId)) {
      log.log(`reconcile ${input.slug}: recovering ${pending.decisions.length} pending decision(s) from run ${pending.runId} after restart`)
      for (const decision of pending.decisions) {
        if (decision.kind === "execute_step" && store.getActiveRunForStep(input.id, decision.jobId, decision.stepId)) {
          log.log(`reconcile ${input.slug}: "${decision.jobId}/${decision.stepId}" already dispatched before restart`)
          continue
        }
        await this.actDecision(input.id, snapshot, decision)
      }
    }

    const feature = store.getFeature(input.id) ?? input
    if (feature.status === "done" || feature.status === "abandoned") return

    for (const [jobId, jobRuntime] of Object.entries(feature.jobs)) {
      if (jobRuntime.status !== "running" || jobRuntime.currentStep === null) continue
      const stepId = jobRuntime.currentStep
      const step = findStep(snapshot.workflow, jobId, stepId)
      if (!step) {
        log.log(`reconcile ${feature.slug}: current step "${stepId}" in job "${jobId}" not in workflow — escalating`)
        await this.dispatch(feature.id, {
          kind: "step.failed",
          jobId,
          stepId,
          reason: `current step "${stepId}" no longer exists in job "${jobId}" (workflow changed?)`,
        })
        continue
      }
      if (step.type === "human") continue

      const active = store.getActiveRunForStep(feature.id, jobId, stepId)
      if (!active) {
        log.log(`reconcile ${feature.slug}: job "${jobId}" step "${stepId}" has no run — (re)executing`)
        await this.actDecision(feature.id, snapshot, { kind: "execute_step", jobId, stepId })
        continue
      }

      if (step.type === "agent") {
        await this.reconcileAgentRun(feature, snapshot, active)
      } else {
        await this.reconcileTtl(feature, snapshot, active)
      }
    }
  }

  private async reconcileAgentRun(
    feature: FeatureState,
    snapshot: WorkflowSnapshot,
    active: { id: string; jobId: string; stepId: string; sessionId: string | null; nudges: number; timeStarted: number },
  ): Promise<void> {
    const { log } = this.deps
    if (active.sessionId) {
      const status = await this.deps.sessions.status(active.sessionId)
      if (status === "missing") {
        log.log(`reconcile ${feature.slug}: run ${active.id} session is gone — reaping immediately`)
        this.idleCycles.delete(active.id)
        await this.reap(feature, active, "session disappeared before reporting")
        return
      }
      if (status === "busy" || status === "retry") {
        this.idleCycles.delete(active.id)
      } else {
        const cycles = (this.idleCycles.get(active.id) ?? 0) + 1
        this.idleCycles.set(active.id, cycles)
        if (cycles >= this.nudgeIdleCycles) {
          this.idleCycles.delete(active.id)
          if (active.nudges < this.maxNudges) {
            const nudgeNo = this.deps.store.incrementNudges(active.id)
            log.log(`reconcile ${feature.slug}: run ${active.id} idle without report — nudge ${nudgeNo}/${this.maxNudges}`)
            try {
              await this.deps.sessions.prompt({
                sessionID: active.sessionId,
                text:
                  `[conductor] Your previous turn appears to have been interrupted (session idle, no report received). ` +
                  `The work state is in your context. Finish step "${active.stepId}" and report ` +
                  `run_id="${active.id}" with the appropriate outcome.`,
              })
            } catch (err) {
              log.log(`nudge failed: ${errorMessage(err)}`)
            }
            return
          }
          log.log(`reconcile ${feature.slug}: run ${active.id} idle after ${this.maxNudges} nudges — reaping`)
          await this.reap(feature, active, `idle without report after ${active.nudges} nudge(s)`)
          return
        }
      }
    }
    await this.reconcileTtl(feature, snapshot, active)
  }

  private async reconcileTtl(
    feature: FeatureState,
    _snapshot: WorkflowSnapshot,
    active: { id: string; jobId: string; stepId: string; timeStarted: number },
  ): Promise<void> {
    const age = this.deps.clock.now() - active.timeStarted
    if (age > this.runTtlMs) {
      this.deps.log.log(`reconcile ${feature.slug}: run ${active.id} (step ${active.stepId}) exceeded TTL — reaping`)
      this.idleCycles.delete(active.id)
      await this.reap(feature, active, `run reaped after ${Math.round(age / 60000)} min without a report`)
    }
  }

  private async reap(
    feature: FeatureState,
    active: { id: string; jobId: string; stepId: string },
    reason: string,
  ): Promise<void> {
    await this.concludeAndDispatch(
      feature.id,
      active.id,
      "reaped",
      { reason },
      { kind: "step.failed", jobId: active.jobId, stepId: active.stepId, reason },
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findStep(workflow: WorkflowDef, jobId: string, stepId: string): StepDef | undefined {
  return workflow.jobs[jobId]?.steps.find(step => step.id === stepId)
}

function waitingHumanSteps(state: FeatureState): Array<{ jobId: string; stepId: string }> {
  const found: Array<{ jobId: string; stepId: string }> = []
  for (const [jobId, jobRuntime] of Object.entries(state.jobs)) {
    for (const [stepId, stepRuntime] of Object.entries(jobRuntime.steps)) {
      if (stepRuntime.status === "waiting_human") found.push({ jobId, stepId })
    }
  }
  return found
}

async function readOutputFile(path: string): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return {}
  }
  const outputs: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const name = line.slice(0, eq).trim()
    if (name === "") continue
    outputs[name] = line.slice(eq + 1)
  }
  return outputs
}

function alreadyConcludedText(runId: string, status: string): string {
  return `Run ${runId} already concluded (${status}).`
}

function decisionLabel(decision: Decision): string {
  return decision.kind === "execute_step" || decision.kind === "wait_human"
    ? `${decision.kind}:${decision.jobId}/${decision.stepId}`
    : decision.kind
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
