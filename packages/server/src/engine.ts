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
import { DEFAULT_OUTCOME, buildEvalContext, extractExpressions, interpret, renderTemplate } from "@conductor/core"
import type {
  ActionInputType,
  ActionManifest,
  ActionRunContext,
  ActionStep,
  AgentStep,
  CommandStep,
  Decision,
  EvalContext,
  FeatureState,
  PipelineEvent,
  StepDef,
  WorkflowDef,
} from "@conductor/core"
import type { RunSummary, Store } from "./store.ts"
import type { WorkflowResolver, WorkflowSnapshot } from "./workflow-registry.ts"
import type { Clock, Logger, ProcessRunner, SessionClient } from "./ports.ts"
import type { ActionExecutor } from "./action-host.ts"
import { actionBindingsForReconciler } from "./workflow-reservation.ts"
import type { ResolvedActionBinding } from "./workflow-reservation.ts"

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
  readonly actions: ActionExecutor
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
  /**
   * In-flight action executions (run id → settling promise). Action
   * steps can poll for minutes (`github/await-checks`), so their host
   * execution is detached from the dispatch chain — a blocking action
   * must never freeze reconciliation for every other feature. In-memory
   * by design: a run that is `running` after a restart with no tracked
   * execution is concluded failed (bundled actions are idempotent, the
   * workflow's retry/onFail policy decides what happens next).
   */
  private readonly actionRuns = new Map<string, Promise<void>>()
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
        // One active run per job+step is an invariant: resume re-arms a
        // running agent step (onResumed cannot know a run is live — e.g.
        // mid-question on an interactive step), and dispatching a second
        // run would orphan the first's session and its context.
        const already = this.deps.store.getActiveRunForStep(featureId, decision.jobId, decision.stepId)
        if (already) {
          this.deps.log.log(
            `feature=${featureId}: step "${decision.jobId}/${decision.stepId}" already has active run ${already.id} — skipping duplicate dispatch`,
          )
          return
        }
        if (step.type === "agent") return this.executeAgent(featureId, snapshot, decision.jobId, step)
        if (step.type === "command") return this.executeCommand(featureId, snapshot, decision.jobId, step)
        if (step.type === "action") return this.executeAction(featureId, snapshot, decision.jobId, step)
        // A "human" step never produces an execute_step decision (it
        // produces wait_human) — unreachable, but escalate loudly rather
        // than silently dispatching if the interpreter's invariant ever breaks.
        await this.dispatch(featureId, {
          kind: "step.failed",
          jobId: decision.jobId,
          stepId: decision.stepId,
          reason: `execute_step targeted a "${step.type}" step (unreachable: only agent/command/action steps dispatch this way)`,
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
        this.renderGatePrompt(featureId, snapshot, decision.jobId, decision.stepId)
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

  /**
   * Render a gate's prompt template when the gate arms and persist the
   * text under the step's reserved `prompt` output. Render errors log and
   * the gate still arms with the partial text — a gate exists to hand
   * control to a human, so a broken template must never block it.
   */
  private renderGatePrompt(featureId: string, snapshot: WorkflowSnapshot, jobId: string, stepId: string): void {
    const { store, log } = this.deps
    const step = findStep(snapshot.workflow, jobId, stepId)
    if (!step || step.type !== "human" || step.prompt === undefined) return
    const state = store.getFeature(featureId)
    if (!state) return
    const feedback = store.getFeedback(featureId) ?? undefined
    const context = buildEvalContext(snapshot.workflow, state, jobId, feedback)
    const rendered = renderTemplate(step.prompt, context)
    for (const error of rendered.errors) log.log(`feature=${state.slug} gate=${jobId}/${stepId}: ${error}`)
    store.mergeStepOutputs(featureId, jobId, stepId, { prompt: rendered.text })
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
          // Optional runner hint so agent output can be attributed to this
          // run's log. The parent session (no run) is deliberately bare.
          runId,
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
        // The interleaved capture becomes the run's narrative log — the
        // failure `reason` below keeps carrying the output tail exactly as
        // before; the log supplements it, never replaces it.
        if (result.output !== "") store.appendRunLog(runId, [{ source: "process", text: result.output }])
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

  private async executeAction(featureId: string, snapshot: WorkflowSnapshot, jobId: string, step: ActionStep): Promise<void> {
    const { store } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return
    const attempt = (state.jobs[jobId]?.attempts[step.id] ?? 0) + 1

    const binding = actionBindingsForReconciler(snapshot.actionBindings).get(jobId, step.id)
    if (!binding) {
      const reason = `action "${step.uses}" has no resolved binding for job "${jobId}" step "${step.id}" (workflow changed since load?)`
      await this.dispatch(featureId, { kind: "step.failed", jobId, stepId: step.id, reason })
      return
    }

    const runId = store.insertRun({
      featureId, jobId, stepId: step.id, stepType: "action", attempt,
      metadata: { uses: step.uses, version: binding.manifest.version, digest: binding.digest },
    })

    const coerced = this.renderActionInputs(snapshot, state, jobId, step, binding.manifest)
    if (!coerced.ok) {
      await this.concludeAndDispatch(
        featureId, runId, "failed", { reason: coerced.error },
        { kind: "step.failed", jobId, stepId: step.id, reason: coerced.error },
      )
      return
    }

    this.dispatchActionObservation(featureId, jobId, step.id, runId, binding, {
      featureId,
      jobId,
      stepId: step.id,
      workdir: state.worktree ?? state.projectDir,
      inputs: coerced.inputs,
      capabilities: binding.manifest.capabilities,
    })
  }

  /**
   * Renders a step's `with:` values into typed action inputs against the
   * feature's current state — the exact same render+coerce path
   * `executeAction`'s first invocation uses and `reconcileActionRun`'s
   * re-observation reuses, so a template referencing `feedback`/`needs`
   * resolves consistently across every observation of a durable-pending run.
   */
  private renderActionInputs(
    snapshot: WorkflowSnapshot,
    state: FeatureState,
    jobId: string,
    step: ActionStep,
    manifest: ActionManifest,
  ): CoerceActionInputsResult {
    const feedback = this.deps.store.getFeedback(state.id) ?? undefined
    const context = buildEvalContext(snapshot.workflow, state, jobId, feedback)
    return coerceActionInputs(step.with, manifest, context, this.deps.log)
  }

  /**
   * Detach one action-host invocation from the dispatch chain and settle
   * its result onto `runId`. Succeeded/failed conclude the run, advancing
   * the workflow; pending records the next-observation policy on the SAME
   * run row (no new row, no burned attempt) for `reconcileActionRun` to
   * re-invoke later — one observation per invocation. Shared by the first
   * invocation (`executeAction`) and every re-observation
   * (`reconcileActionRun`): awaiting a polling action here would park
   * reconcile() — and with it nudge/reap/dispatch — for EVERY feature
   * until it settles. `settleActions()` lets tests (and shutdown) drain
   * the map.
   */
  private dispatchActionObservation(
    featureId: string,
    jobId: string,
    stepId: string,
    runId: string,
    binding: ResolvedActionBinding,
    ctx: ActionRunContext,
  ): void {
    const { store, actions, log, clock } = this.deps
    const runLog = (text: string) => {
      if (text !== "") store.appendRunLog(runId, [{ source: "action", text }])
    }
    const execution = (async () => {
      try {
        const result = await actions.execute(binding, ctx, { runLog })
        if (result.ok === "pending") {
          const claimed = store.recordPendingObservation(runId, result.state, clock.now() + result.nextPollMs)
          if (!claimed) {
            log.log(`feature=${featureId}: run ${runId} concluded before its pending observation was recorded — dropping`)
          }
          return
        }
        if (!result.ok) {
          await this.concludeAndDispatch(
            featureId, runId, "failed", { reason: result.error },
            { kind: "step.failed", jobId, stepId, reason: result.error },
          )
          return
        }
        const outputs = stringifyOutputs(result.outputs)
        await this.concludeAndDispatch(
          featureId, runId, "succeeded", { outputs },
          { kind: "step.completed", jobId, stepId, outcome: DEFAULT_OUTCOME, outputs },
        )
      } catch (err) {
        const reason = `action host error: ${errorMessage(err)}`
        await this.concludeAndDispatch(
          featureId, runId, "failed", { reason },
          { kind: "step.failed", jobId, stepId, reason },
        )
      } finally {
        this.actionRuns.delete(runId)
      }
    })()
    this.actionRuns.set(runId, execution)
  }

  /** Await every in-flight detached action execution. Tests and shutdown drain the engine with this. */
  async settleActions(): Promise<void> {
    while (this.actionRuns.size > 0) {
      await Promise.all([...this.actionRuns.values()])
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
  async report(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string; ask?: string }): Promise<string> {
    const { store } = this.deps
    const run = store.getRunById(input.runId)
    if (!run) return `Unknown run_id "${input.runId}".`
    if (run.status !== "running") return alreadyConcludedText(input.runId, run.status)

    if (input.ask !== undefined) {
      // An ask parks the run on a human question WITHOUT concluding it:
      // the session stays alive so the answer resumes with full context.
      const parked = store.setRunQuestion(input.runId, input.ask)
      if (!parked) return alreadyConcludedText(input.runId, store.getRunById(input.runId)?.status ?? run.status)
      const state = store.getFeature(run.featureId)
      this.deps.notify?.(
        `Conductor: question — ${state?.slug ?? run.featureId}`,
        `Step "${run.stepId}" (job "${run.jobId}") is waiting for your answer.`,
      )
      return `Question recorded for step "${run.stepId}" — the run is waiting for a human answer.`
    }

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
   * Deliver a human's answer to an asking run: forward the notes into the
   * run's LIVE session (that is the whole point — context is preserved),
   * clear the pending question and return the feature to `running`. A
   * dead session fails the step honestly through the normal step-failed
   * path so retry/onFail semantics apply.
   */
  async answer(runId: string, notes: string): Promise<{ ok: true; message: string } | { ok: false; code: "unknown_run" | "no_pending_question" | "session_lost"; message: string }> {
    const { store, log } = this.deps
    const run = store.getRunById(runId)
    if (!run) return { ok: false, code: "unknown_run", message: `Unknown run_id "${runId}".` }

    // Claim first, act after — the same discipline as concludeAndDispatch.
    // clearRunQuestion is a guarded transaction (`status = 'running' AND
    // pending_question IS NOT NULL`), so of two racing answers exactly one
    // wins; the loser maps to the same conflict as answering a non-asking
    // run and never re-sends the prompt into the session.
    if (!store.clearRunQuestion(runId)) {
      return { ok: false, code: "no_pending_question", message: `Run "${runId}" has no pending question.` }
    }

    const failStep = async (reason: string, message: string): Promise<{ ok: false; code: "session_lost"; message: string }> => {
      log.log(`answer ${runId}: ${reason} — failing the step`)
      await this.concludeAndDispatch(
        run.featureId, runId, "failed", { reason },
        { kind: "step.failed", jobId: run.jobId, stepId: run.stepId, reason },
      )
      return { ok: false, code: "session_lost", message }
    }

    const sessionAlive = run.sessionId !== null && (await this.deps.sessions.status(run.sessionId)) !== "missing"
    if (!sessionAlive) {
      return failStep(
        `session ${run.sessionId ?? "(none)"} was lost while waiting for a human answer`,
        `The run's session is gone — step "${run.stepId}" failed and normal failure routing applies.`,
      )
    }

    try {
      await this.deps.sessions.prompt({
        sessionID: run.sessionId!,
        text:
          `[conductor] The human answered your question:\n\n${notes}\n\n` +
          `Treat the answers as binding decisions. Continue step "${run.stepId}" and report ` +
          `run_id="${runId}" with the appropriate outcome when done (or ask again if a further decision is needed).`,
      })
    } catch (err) {
      return failStep(
        `failed to deliver the answer to session ${run.sessionId}: ${errorMessage(err)}`,
        `Delivering the answer failed — step "${run.stepId}" failed and normal failure routing applies.`,
      )
    }

    this.idleCycles.delete(runId)
    const after = store.getFeature(run.featureId)
    return { ok: true, message: `Answer delivered to step "${run.stepId}". Feature is now: ${after?.status ?? "running"}.` }
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
      // Merge over the step's existing outputs (the reserved `prompt`
      // written at arm time) — `step.completed` replaces outputs wholesale.
      const existing = current.jobs[jobId]?.steps[stepId]?.outputs ?? {}
      const event: PipelineEvent = { kind: "step.completed", jobId, stepId, outcome, outputs: { ...existing, notes } }
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
    const { store, log, clock } = this.deps
    const snapshot = this.deps.workflows(input.projectDir)
    if (!snapshot) return

    // Restart recovery runs FIRST, unconditionally: decisions committed
    // by `concludeRun` but never acted on (process died in the gap) must
    // be replayed before the normal per-job reconciliation below sees
    // the post-recovery state. Replay, THEN mark handled — the same
    // dispatch-then-mark invariant as `concludeAndDispatch`: a second
    // crash mid-replay leaves the entry pending so the next pass retries
    // the WHOLE batch. Retry is safe: each `execute_step` whose run
    // already exists (dispatch completed before the crash) is skipped,
    // and every other decision kind is a pure notify/no-op.
    const pending = store.getPendingRunAction(input.id)
    if (pending) {
      log.log(`reconcile ${input.slug}: recovering ${pending.decisions.length} pending decision(s) from run ${pending.runId} after restart`)
      for (const decision of pending.decisions) {
        if (decision.kind === "execute_step" && store.getActiveRunForStep(input.id, decision.jobId, decision.stepId)) {
          log.log(`reconcile ${input.slug}: "${decision.jobId}/${decision.stepId}" already dispatched before restart`)
          continue
        }
        await this.actDecision(input.id, snapshot, decision)
      }
      store.markRunActionHandled(pending.runId)
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
      } else if (step.type === "action" && active.nextObservation !== null) {
        // A durable-pending action run: it survives a daemon restart by
        // design (that's the whole point of the protocol) — never treated
        // as orphaned. TTL still governs its overall lifetime; short of
        // that, re-observe once its next-observation time has passed
        // (guarding against double-invocation if an observation for this
        // run is already in flight — e.g. this pass raced dispatch).
        if (clock.now() - active.timeStarted > this.runTtlMs) {
          await this.reconcileTtl(feature, snapshot, active)
        } else if (!this.actionRuns.has(active.id) && clock.now() >= active.nextObservation) {
          await this.reconcileActionRun(feature, snapshot, jobId, step, active)
        }
      } else if (step.type === "action" && !this.actionRuns.has(active.id)) {
        // A running action run with no tracked execution and no pending
        // observation means the daemon restarted mid-action. Waiting for
        // TTL would stall the feature for no reason: conclude it failed
        // now — bundled actions are idempotent, so the workflow's
        // retry/onFail policy can safely re-dispatch.
        log.log(`reconcile ${feature.slug}: run ${active.id} (action ${stepId}) has no live execution — daemon restarted, failing for retry`)
        await this.concludeAndDispatch(
          feature.id, active.id, "failed",
          { reason: "daemon restarted while action was executing" },
          { kind: "step.failed", jobId, stepId, reason: "daemon restarted while action was executing" },
        )
      } else {
        await this.reconcileTtl(feature, snapshot, active)
      }
    }
  }

  private async reconcileActionRun(
    feature: FeatureState,
    snapshot: WorkflowSnapshot,
    jobId: string,
    step: ActionStep,
    active: RunSummary,
  ): Promise<void> {
    const binding = actionBindingsForReconciler(snapshot.actionBindings).get(jobId, step.id)
    if (!binding) {
      const reason = `action "${step.uses}" has no resolved binding for job "${jobId}" step "${step.id}" (workflow changed since load?)`
      await this.concludeAndDispatch(
        feature.id, active.id, "failed", { reason },
        { kind: "step.failed", jobId, stepId: step.id, reason },
      )
      return
    }
    const coerced = this.renderActionInputs(snapshot, feature, jobId, step, binding.manifest)
    if (!coerced.ok) {
      await this.concludeAndDispatch(
        feature.id, active.id, "failed", { reason: coerced.error },
        { kind: "step.failed", jobId, stepId: step.id, reason: coerced.error },
      )
      return
    }
    this.dispatchActionObservation(feature.id, jobId, step.id, active.id, binding, {
      featureId: feature.id,
      jobId,
      stepId: step.id,
      workdir: feature.worktree ?? feature.projectDir,
      inputs: coerced.inputs,
      capabilities: binding.manifest.capabilities,
      resume: active.pendingState ?? undefined,
    })
  }

  private async reconcileAgentRun(
    feature: FeatureState,
    snapshot: WorkflowSnapshot,
    active: { id: string; jobId: string; stepId: string; sessionId: string | null; nudges: number; timeStarted: number; pendingQuestion?: string | null },
  ): Promise<void> {
    const { log } = this.deps
    // Waiting for a human answer is not being stuck: no idle nudging, no
    // idle reaping. The TTL below still bounds an abandoned question.
    if (active.pendingQuestion != null) {
      this.idleCycles.delete(active.id)
      // A pause/resume cycle rewrites feature.status to `running` without
      // knowing about the pending question — re-park so the answering
      // surfaces reappear instead of the question silently aging out.
      if (feature.status === "running") {
        this.deps.store.setRunQuestion(active.id, active.pendingQuestion)
      }
      await this.reconcileTtl(feature, snapshot, active)
      return
    }
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

type CoerceActionInputsResult =
  | { readonly ok: true; readonly inputs: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string }

/**
 * Renders each `with:` value through the template evaluator, applies the
 * manifest's default for values the step omitted, and coerces a rendered
 * template's string result to the manifest's declared type (validation at
 * reservation time deferred exactly this check for template values — a
 * literal has already been type-checked and passes through unchanged).
 */
function coerceActionInputs(
  values: Readonly<Record<string, unknown>>,
  manifest: ActionManifest,
  context: EvalContext,
  log: Logger,
): CoerceActionInputsResult {
  const inputs: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(manifest.inputs)) {
    const raw = values[name] ?? (def.presence === "optional" ? def.default : undefined)
    if (raw === undefined) continue // required-but-missing is caught at reservation

    if (typeof raw === "string" && extractExpressions(raw).length > 0) {
      const rendered = renderTemplate(raw, context)
      for (const error of rendered.errors) log.log(`action input "${name}": ${error}`)
      if (rendered.errors.length > 0) {
        return { ok: false, error: `action input "${name}" failed to render: ${rendered.errors.join("; ")}` }
      }
      const coerced = coerceInputValue(rendered.text, def.type)
      if (coerced === undefined) {
        return { ok: false, error: `action input "${name}" rendered "${rendered.text}" which is not a valid ${def.type}` }
      }
      inputs[name] = coerced
      continue
    }
    inputs[name] = raw
  }
  return { ok: true, inputs }
}

function coerceInputValue(text: string, type: ActionInputType): unknown {
  switch (type) {
    case "string":
      return text
    case "number": {
      const n = Number(text)
      return Number.isFinite(n) ? n : undefined
    }
    case "boolean":
      if (text === "true") return true
      if (text === "false") return false
      return undefined
    default:
      // Array-typed inputs are not rendered from a single template string;
      // a template value for one is out of scope for v1.
      return undefined
  }
}

function stringifyOutputs(outputs: Readonly<Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(outputs)) {
    result[name] = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value)
  }
  return result
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
