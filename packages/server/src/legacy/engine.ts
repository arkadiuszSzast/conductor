/**
 * The legacy compatibility engine: owns all side effects around the pure
 * legacy interpreter, preserving opencode-conductor's observable
 * semantics over the extracted SQLite store.
 *
 *  - executes decisions (builtin / command / agent steps)
 *  - reconciles reality (gh, sessions) with stored state on an interval
 *  - reaps stuck runs after runTtlMs and feeds failures back as events
 *  - keeps ONE logical orchestrator session per feature, woken via the
 *    injected `LegacySessionClient`; if the session died, a fresh one is
 *    created and the session_id updated — the feature never depends on a
 *    session surviving.
 *
 * Confirmation-of-effect rule: an agent step is only "done" when its
 * session (or a human) reports through `report()` — never merely because
 * a session went idle. Idle-without-report after TTL ⇒ reaped.
 *
 * Every dependency (store, config resolver, GitHub, sessions, process
 * execution, clock, logger, review publisher) is injected via
 * `LegacyEngineDeps` — nothing here reaches for an opencode SDK import, a
 * process-wide global, or `Date.now()` directly.
 */

import { interpretLegacy } from "./interpret.ts"
import { renderLegacy } from "./template.ts"
import { legacyBuiltins } from "./builtins.ts"
import {
  makePublishReviewLegacy,
  parseFindingsLegacy,
  parseResolutionsLegacy,
  severitySummaryLegacy,
} from "./publish-review.ts"
import { pipelineForLegacyWorkflow } from "./types.ts"
import type {
  Clock,
  LegacyConfigResolver,
  LegacyGh,
  LegacyPublishReview,
  LegacySessionClient,
  LegacyStorePort,
  Logger,
  ProcessRunner,
} from "./ports.ts"
import type { LegacyAgentStep, LegacyCommandStep, LegacyConfig, LegacyStepDef } from "./types.ts"
import type { LegacyDecision, LegacyFeatureState } from "../store.ts"

export interface LegacyEngineDeps {
  readonly store: LegacyStorePort
  readonly resolveConfig: LegacyConfigResolver
  readonly gh: LegacyGh
  readonly sessions: LegacySessionClient
  readonly process: ProcessRunner
  readonly clock: Clock
  readonly log: Logger
  readonly notify?: (title: string, message: string) => void
  /** Review publisher (injectable for tests). Defaults to the gh-backed one. */
  readonly publishReview?: LegacyPublishReview
}

export class LegacyEngine {
  /**
   * Consecutive reconcile cycles each running agent run's session has been
   * idle (run id → count). In-memory by design: after a restart the
   * debounce restarts from zero — the safe direction of error.
   */
  private readonly idleCycles = new Map<string, number>()
  private readonly publishReview: LegacyPublishReview

  constructor(private readonly deps: LegacyEngineDeps) {
    this.publishReview = deps.publishReview ?? makePublishReviewLegacy(deps.gh, deps.process)
  }

  private configFor(state: LegacyFeatureState): LegacyConfig | null {
    const config = this.deps.resolveConfig(state.projectDir)
    if (!config) this.deps.log.log(`feature=${state.slug}: no valid conductor config for ${state.projectDir} — skipping`)
    return config
  }

  /**
   * The (pipeline, roles) definition a feature runs under — its named
   * workflow or the default pipeline. Unknown workflow → null (logged);
   * the feature is skipped, never run under a guessed pipeline.
   */
  private defFor(state: LegacyFeatureState, config: LegacyConfig): { pipeline: readonly LegacyStepDef[]; roles: LegacyConfig["roles"] } | null {
    const pipeline = pipelineForLegacyWorkflow(config, state.workflow)
    if (!pipeline) {
      this.deps.log.log(`feature=${state.slug}: unknown workflow "${state.workflow}" — skipping`)
      return null
    }
    return { pipeline, roles: config.roles }
  }

  /** Feed an event through the interpreter and act on the decision. */
  async dispatch(featureId: string, event: Parameters<typeof interpretLegacy>[2]): Promise<void> {
    const { store, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) {
      log.log(`dispatch: unknown feature ${featureId}`)
      return
    }
    const config = this.configFor(state)
    if (!config) return
    const def = this.defFor(state, config)
    if (!def) return
    const transition = interpretLegacy(def, state, event)
    store.applyTransition(featureId, event, transition)
    log.log(
      `feature=${state.slug} event=${event.kind} → ${transition.decision.kind}` +
        (transition.decision.kind === "execute" ? `:${transition.decision.stepId}` : ""),
    )
    await this.act(featureId, transition.decision)
  }

  private async act(featureId: string, decision: LegacyDecision): Promise<void> {
    const { store } = this.deps
    switch (decision.kind) {
      case "execute": {
        const state = store.getFeature(featureId)
        if (!state) return
        const config = this.configFor(state)
        if (!config) return
        const step = this.defFor(state, config)?.pipeline.find(s => s.id === decision.stepId)
        if (!step) {
          // Decision names a step the CURRENT pipeline no longer has —
          // the config changed under a live feature. Loud escalation
          // beats a silent dead end (observed: soft-bricked feature).
          this.deps.log.log(`feature=${state.slug}: step "${decision.stepId}" not in pipeline — escalating`)
          store.applyTransition(
            featureId,
            { kind: "step.failed", stepId: decision.stepId, reason: "step vanished from pipeline" },
            {
              decision: { kind: "escalate", reason: `step "${decision.stepId}" no longer exists in the pipeline (config changed?)` },
              patch: { status: "escalated" },
            },
          )
          this.deps.notify?.(
            `Conductor: escalation — ${state.slug}`,
            `Step "${decision.stepId}" no longer exists in the pipeline (config changed under a live feature).`,
          )
          return
        }
        await this.executeStep(state, step)
        return
      }
      case "escalate": {
        const state = store.getFeature(featureId)
        this.deps.notify?.(`Conductor: escalation — ${state?.slug ?? featureId}`, decision.reason)
        return
      }
      case "wait_human": {
        const state = store.getFeature(featureId)
        this.deps.notify?.(
          `Conductor: approval needed — ${state?.slug ?? featureId}`,
          `Step "${decision.stepId}" awaits your approval.`,
        )
        return
      }
      case "finish":
      case "pause":
      case "abandon":
      case "noop":
        return
    }
  }

  // ------------------------------------------------------------- execution

  private async executeStep(state: LegacyFeatureState, step: LegacyStepDef): Promise<void> {
    const attempt = (state.attempts[step.id] ?? 0) + 1
    switch (step.type) {
      case "builtin":
        await this.executeBuiltin(state, step.id, step.action, step.params ?? {}, attempt)
        return
      case "command":
        await this.executeCommand(state, step, attempt)
        return
      case "agent":
        await this.executeAgent(state, step, attempt)
        return
    }
  }

  private templateContext(state: LegacyFeatureState, config: LegacyConfig): Record<string, unknown> {
    const { store } = this.deps
    const steps: Record<string, { output: string | null }> = {}
    const human: Record<string, string | null> = {}
    for (const s of pipelineForLegacyWorkflow(config, state.workflow) ?? config.pipeline) {
      steps[s.id] = { output: store.getLastOutput(state.id, s.id) }
      // {{human.<stepId>}} — the latest notes a human left at that gate
      // (approve-with-notes or request-changes), independent of step output.
      human[s.id] = store.getLastHumanNotes(state.id, s.id)
    }
    // Findings digests for review/fix prompts. The DB is the source of
    // truth: reviewers see all findings with statuses (loop-breaker),
    // fixers see the open ones they must address.
    const findings = store.listFindings(state.id)
    const digest = findings.length === 0
      ? "(none yet)"
      : findings
          .map(f => `${f.id} [${f.severity}] ${f.path}:${f.line} — ${f.status}${f.resolution ? ` (${f.resolution.slice(0, 100)})` : ""} — ${f.body.slice(0, 150)}`)
          .join("\n")
    const openFindings = findings.filter(f => f.status === "new" || f.status === "reopened")
    const open = openFindings.length === 0
      ? "(none)"
      : openFindings
          .map(f => `${f.id} [${f.severity}]${f.tags.length > 0 ? ` (${f.tags.join(", ")})` : ""} ${f.path}:${f.line} — ${f.body}`)
          .join("\n")
    return {
      findings: { digest, open },
      human,
      feature: {
        id: state.id,
        title: state.title,
        description: state.description ?? state.title,
        slug: state.slug,
        branch: state.branch,
        worktree: state.worktree,
        pr: state.pr,
        head_sha: this.latestHeadSha(state),
      },
      config: { repo: config.repo, baseBranch: config.baseBranch },
      steps,
    }
  }

  private latestHeadSha(state: LegacyFeatureState): string | null {
    if (state.pr === null) return null
    return this.deps.store.getLastOutput(state.id, "await_ci")
  }

  /**
   * Best-effort timeline note in the feature's parent session (noReply —
   * no inference). The parent session is otherwise empty in "fresh"
   * isolation (all work happens in child sessions), so these notes make
   * it a human-readable summary of what each step/agent did. Never
   * throws and never blocks the pipeline.
   */
  private async noteParent(featureId: string, text: string): Promise<void> {
    const { store, sessions } = this.deps
    const state = store.getFeature(featureId)
    if (!state?.sessionId) return
    try {
      if (!(await sessions.sessionExists(state.sessionId))) return
      await sessions.note({ sessionID: state.sessionId, text })
    } catch (err) {
      this.deps.log.log(`timeline note failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Clip long step output/notes for the parent-session timeline. */
  private static clip(text: string, max = 800): string {
    const trimmed = text.trim()
    return trimmed.length > max ? `${trimmed.slice(0, max)} …` : trimmed
  }

  private async executeBuiltin(
    state: LegacyFeatureState,
    stepId: string,
    action: string,
    rawParams: Readonly<Record<string, string>>,
    attempt: number,
  ): Promise<void> {
    const { store, gh, process, log } = this.deps
    const config = this.configFor(state)
    if (!config) return
    const fn = legacyBuiltins[action]
    if (!fn) {
      await this.dispatch(state.id, { kind: "step.failed", stepId, reason: `unknown builtin action "${action}"` })
      return
    }
    const context = this.templateContext(state, config)
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawParams)) {
      params[key] = renderLegacy(value, context).text
    }
    const runId = store.startRun({ featureId: state.id, stepId, stepType: "builtin", attempt })
    const fresh = store.getFeature(state.id) ?? state
    const outcome = await fn({ feature: fresh, stepId, config, store, gh, process, params })
    if (outcome.kind === "pending") {
      // Still waiting (e.g. CI running). Leave the run open; the
      // reconciler re-executes this builtin next cycle. Close this
      // run as reaped-neutral so runs don't pile up.
      store.finishRun(runId, "reaped", { reason: "pending — will re-check" })
      log.log(`builtin ${action}: pending (feature=${fresh.slug})`)
      return
    }
    if (outcome.kind === "succeeded") {
      store.finishRun(runId, "succeeded", { output: outcome.output ?? "" })
      const detail = outcome.output ? ` — ${LegacyEngine.clip(outcome.output, 200)}` : ""
      await this.noteParent(state.id, `[conductor] ✓ ${stepId}${detail}`)
      await this.dispatch(state.id, { kind: "step.succeeded", stepId, output: outcome.output ?? "" })
    } else {
      store.finishRun(runId, "failed", { output: outcome.output ?? "", reason: outcome.reason })
      await this.noteParent(state.id, `[conductor] ✗ ${stepId} failed — ${LegacyEngine.clip(outcome.reason, 300)}`)
      await this.dispatch(state.id, { kind: "step.failed", stepId, reason: outcome.reason })
    }
  }

  private async executeCommand(state: LegacyFeatureState, step: LegacyCommandStep, attempt: number): Promise<void> {
    const { store, process } = this.deps
    const config = this.configFor(state)
    if (!config) return
    const context = this.templateContext(state, config)
    const cwd = step.cwd !== undefined
      ? renderLegacy(step.cwd, context).text
      : (state.worktree ?? state.projectDir)

    const runId = store.startRun({ featureId: state.id, stepId: step.id, stepType: "command", attempt })
    for (const raw of step.run) {
      const command = renderLegacy(raw, context).text
      const result = await process.shell(command, {
        cwd,
        ...(step.timeout_ms !== undefined ? { timeoutMs: step.timeout_ms } : {}),
      })
      if (result.code !== 0) {
        const tail = result.output.slice(-4000)
        store.finishRun(runId, "failed", { output: tail, reason: `"${command}" exited ${result.code}` })
        await this.noteParent(state.id, `[conductor] ✗ ${step.id} failed — "${command}" exited ${result.code}`)
        await this.dispatch(state.id, { kind: "step.failed", stepId: step.id, reason: `"${command}" exited ${result.code}` })
        return
      }
    }
    store.finishRun(runId, "succeeded")
    await this.noteParent(state.id, `[conductor] ✓ ${step.id} (command)`)
    await this.dispatch(state.id, { kind: "step.succeeded", stepId: step.id })
  }

  private async executeAgent(state: LegacyFeatureState, step: LegacyAgentStep, attempt: number): Promise<void> {
    const { store, sessions, log } = this.deps
    const config = this.configFor(state)
    if (!config) return
    const role = config.roles[step.role]
    if (!role) {
      await this.dispatch(state.id, { kind: "step.failed", stepId: step.id, reason: `role "${step.role}" not configured` })
      return
    }

    const context = this.templateContext(state, config)
    const promptTemplate = step.prompt ?? `Execute pipeline step "${step.id}" for feature: {{feature.title}}.`
    const rendered = renderLegacy(promptTemplate, context)
    for (const missing of rendered.missing) {
      log.log(`step ${step.id}: template variable "${missing}" is empty`)
    }

    // Feature parent session: the grouping anchor for this feature's work.
    // In "fresh" mode (default) it is never prompted — each step run gets
    // its own child session beneath it (subagent-style: clean context per
    // step). In "feature" mode the parent itself is prompted, carrying
    // context across steps for roles that deliberately want continuity.
    let parentId = state.sessionId
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
      store.setFeatureFields(state.id, { sessionId: parentId })
    }

    const isolation = role.session ?? "fresh"
    const sessionId = isolation === "feature"
      ? parentId
      : (
          await sessions.createSession({
            title: `[${role.agent}] ${state.title}${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
            directory: state.worktree ?? state.projectDir,
            parentID: parentId,
          })
        ).id

    const runId = store.startRun({
      featureId: state.id,
      stepId: step.id,
      stepType: "agent",
      attempt,
      role: step.role,
      ...(role.model !== undefined ? { model: role.model } : {}),
      sessionId,
    })

    const header =
      `[conductor] Step "${step.id}" (attempt ${attempt}) — run ${runId}.\n` +
      `When this step is complete you MUST report run_id="${runId}" ` +
      `and outcome (succeeded/failed${step.on_verdict ? " or a verdict: " + Object.keys(step.on_verdict).join("/") : ""}).\n\n`

    try {
      await sessions.prompt({
        sessionID: sessionId,
        text: header + rendered.text,
        agent: role.agent,
        ...(role.model !== undefined ? { model: role.model } : {}),
      })
      if (sessionId !== parentId) {
        await this.noteParent(
          state.id,
          `[conductor] ▶ ${step.id}${attempt > 1 ? ` (attempt ${attempt})` : ""} — dispatched to ${role.agent}` +
            (role.model !== undefined ? ` (${role.model})` : ""),
        )
      }
    } catch (err) {
      store.finishRun(runId, "failed", { reason: `prompt failed: ${err instanceof Error ? err.message : String(err)}` })
      await this.dispatch(state.id, {
        kind: "step.failed",
        stepId: step.id,
        reason: `failed to prompt session: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // ------------------------------------------------------------ reconciler

  /**
   * One reconcile pass. Called on an interval by the daemon and after
   * init recovery. Idempotent: every action is guarded by stored state.
   */
  async reconcile(): Promise<void> {
    const { store, log } = this.deps
    const features = store.listFeatures({ activeOnly: true })
    for (const feature of features) {
      try {
        await this.reconcileFeature(feature)
      } catch (err) {
        log.log(`reconcile ${feature.slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async reconcileFeature(feature: LegacyFeatureState): Promise<void> {
    const { store, log } = this.deps
    if (feature.status !== "running") return
    if (feature.currentStep === null) return
    const config = this.configFor(feature)
    if (!config) return

    const step = this.defFor(feature, config)?.pipeline.find(s => s.id === feature.currentStep)
    if (!step) {
      // Current step vanished from the pipeline (config change under a
      // live feature). Escalate — the status flips to "escalated", so the
      // running-only guard above keeps this from repeating every cycle.
      this.deps.log.log(`reconcile ${feature.slug}: current step "${feature.currentStep}" not in pipeline — escalating`)
      store.applyTransition(
        feature.id,
        { kind: "step.failed", stepId: feature.currentStep, reason: "step vanished from pipeline" },
        {
          decision: { kind: "escalate", reason: `current step "${feature.currentStep}" no longer exists in the pipeline (config changed?)` },
          patch: { status: "escalated" },
        },
      )
      return
    }

    const active = store.getActiveRun(feature.id)

    // Poll-style builtins (await_checks) re-execute every cycle while pending.
    if (step.type === "builtin" && !active) {
      await this.executeStep(feature, step)
      return
    }

    // No run for the current step at all → the execute decision was made
    // but the process died before the run started. Re-execute.
    if (!active) {
      const lastOutput = store.getLastOutput(feature.id, step.id)
      if (lastOutput === null) {
        log.log(`reconcile ${feature.slug}: step ${step.id} has no run — (re)executing`)
        await this.executeStep(feature, step)
      }
      return
    }

    // Fast path for agent runs: an idle session that never reported is a
    // dead turn (provider error killed it mid-step). Detect it within a
    // few cycles and nudge the SAME session — its context still holds the
    // work in progress — instead of waiting out the full TTL and losing
    // the attempt. Busy/retry sessions are never touched, however long
    // they run.
    if (active.stepType === "agent" && active.sessionId) {
      const sessionStatus = await this.deps.sessions.status(active.sessionId)
      if (sessionStatus === "missing") {
        log.log(`reconcile ${feature.slug}: run ${active.id} session is gone — reaping immediately`)
        this.idleCycles.delete(active.id)
        store.finishRun(active.id, "reaped", { reason: "session disappeared (server restart?)" })
        await this.noteParent(feature.id, `[conductor] ⚠ ${active.stepId} reaped — session disappeared before reporting`)
        await this.dispatch(feature.id, { kind: "step.failed", stepId: active.stepId, reason: "session disappeared before reporting" })
        return
      }
      if (sessionStatus === "busy" || sessionStatus === "retry") {
        this.idleCycles.delete(active.id)
      } else {
        const cycles = (this.idleCycles.get(active.id) ?? 0) + 1
        this.idleCycles.set(active.id, cycles)
        if (cycles >= config.nudgeIdleCycles) {
          this.idleCycles.delete(active.id)
          if (active.nudges < config.maxNudges) {
            const nudgeNo = store.incrementNudges(active.id)
            log.log(`reconcile ${feature.slug}: run ${active.id} idle without report — nudge ${nudgeNo}/${config.maxNudges}`)
            try {
              await this.deps.sessions.prompt({
                sessionID: active.sessionId,
                text:
                  `[conductor] Your previous turn appears to have been interrupted (session idle, no report received). ` +
                  `The work state is in your context. Finish step "${active.stepId}" and report ` +
                  `run_id="${active.id}" with the appropriate outcome/verdict.`,
              })
            } catch (err) {
              log.log(`nudge failed: ${err instanceof Error ? err.message : String(err)}`)
            }
            return
          }
          log.log(`reconcile ${feature.slug}: run ${active.id} idle after ${config.maxNudges} nudges — reaping`)
          store.finishRun(active.id, "reaped", { reason: `idle without report after ${active.nudges} nudge(s)` })
          await this.noteParent(feature.id, `[conductor] ⚠ ${active.stepId} reaped — idle without report after ${active.nudges} nudge(s)`)
          await this.dispatch(feature.id, {
            kind: "step.failed",
            stepId: active.stepId,
            reason: `run reaped: session idle without report after ${active.nudges} nudge(s)`,
          })
          return
        }
      }
    }

    // Reap agent/command runs that exceeded the TTL with no reported effect.
    const age = this.deps.clock.now() - active.timeStarted
    if (age > config.runTtlMs) {
      log.log(`reconcile ${feature.slug}: run ${active.id} (step ${active.stepId}) exceeded TTL — reaping`)
      this.idleCycles.delete(active.id)
      store.finishRun(active.id, "reaped", { reason: `no effect after ${Math.round(age / 60000)} min` })
      await this.noteParent(feature.id, `[conductor] ⚠ ${active.stepId} reaped — no report after ${Math.round(age / 60000)} min`)
      await this.dispatch(feature.id, {
        kind: "step.failed",
        stepId: active.stepId,
        reason: `run reaped after ${Math.round(age / 60000)} min without a report`,
      })
    }
  }

  // --------------------------------------------------------------- reports

  /**
   * Human approves at a requires_human gate, optionally with notes
   * ("approve, but tweak X"). Notes are recorded on a synthetic run so
   * downstream prompts can template them via {{human.<stepId>}} —
   * approval must not silently swallow the human's words.
   */
  async approve(featureId: string, notes?: string): Promise<string> {
    const { store } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return `Unknown feature "${featureId}".`
    if (state.status !== "waiting_human" || !state.currentStep) {
      return `Feature "${state.title}" is not waiting for approval (status: ${state.status}).`
    }
    const stepId = state.currentStep
    const trimmed = notes?.trim() ?? ""
    if (trimmed.length > 0) {
      const runId = store.startRun({ featureId, stepId, stepType: "builtin", attempt: (state.attempts[stepId] ?? 0) + 1 })
      store.finishRun(runId, "succeeded", { output: trimmed, reason: "human approved with notes" })
      await this.noteParent(featureId, `[conductor] ✔ ${stepId} — approved by human with notes\n${LegacyEngine.clip(trimmed)}`)
    }
    await this.dispatch(featureId, { kind: "human.approved", stepId })
    const after = store.getFeature(featureId)
    return `Approved${trimmed.length > 0 ? " (notes recorded)" : ""}. Feature "${state.title}" is now: ${after?.status} (step: ${after?.currentStep ?? "-"}).`
  }

  /**
   * Human "request changes" at a requires_human gate. Stores the notes as
   * the gate step's output (a synthetic finished run) so downstream
   * prompts can template {{steps.<gate>.output}}, then routes via the
   * step's on_reject. No on_reject → escalates.
   */
  async requestChanges(featureId: string, notes: string): Promise<string> {
    const { store } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return `Unknown feature "${featureId}".`
    if (state.status !== "waiting_human" || !state.currentStep) {
      return `Feature "${state.title}" is not waiting for approval (status: ${state.status}).`
    }
    const stepId = state.currentStep
    const runId = store.startRun({ featureId, stepId, stepType: "builtin", attempt: (state.attempts[stepId] ?? 0) + 1 })
    store.finishRun(runId, "failed", { output: notes, reason: "human requested changes" })
    await this.noteParent(featureId, `[conductor] ✋ ${stepId} — changes requested by human\n${LegacyEngine.clip(notes)}`)
    await this.dispatch(featureId, { kind: "human.rejected", stepId, notes })
    const after = store.getFeature(featureId)
    return `Changes requested at "${stepId}". Feature is now: ${after?.status} (step: ${after?.currentStep ?? "-"}).`
  }

  /**
   * Called by the daemon's report endpoint from inside agent sessions.
   * The ONLY path by which an agent step concludes.
   */
  async report(input: {
    runId: string
    outcome?: "succeeded" | "failed"
    verdict?: string
    notes?: string
  }): Promise<string> {
    const { store } = this.deps
    const run = store.getRunById(input.runId)
    if (!run) return `Unknown run_id "${input.runId}".`
    if (run.status !== "running") return `Run ${input.runId} already concluded (${run.status}).`

    const who = run.role ?? run.stepId
    const attemptTag = run.attempt > 1 ? ` (attempt ${run.attempt})` : ""

    if (input.verdict !== undefined) {
      store.finishRun(input.runId, "succeeded", { output: input.notes ?? input.verdict })
      // Publish the review to the PR BEFORE routing the verdict: when the
      // verdict sends a fixer in, the PR threads it must reply to already
      // exist. Best-effort — a failed projection never blocks the
      // pipeline. Persist findings as DB rows FIRST — the database is the
      // source of truth for review state; GitHub is a projection synced
      // from it.
      const review = input.notes ? parseFindingsLegacy(input.notes) : null
      let findingIds: string[] = []
      if (review && review.findings.length > 0) {
        findingIds = store.insertFindings(run.featureId, run.stepId, review.findings)
        this.deps.log.log(`feature run ${input.runId}: recorded ${findingIds.length} finding(s): ${findingIds.join(", ")}`)
      }
      const publishStatus = await this.publishIfConfigured(run, input.verdict, input.notes ?? "", findingIds)
      // Timeline: prefer a structured digest (severity counts + summary)
      // over dumping raw JSON notes into the parent session.
      const counts = review && review.findings.length > 0 ? ` (${severitySummaryLegacy(review.findings)})` : ""
      const digest = review ? LegacyEngine.clip(review.summary) : ""
      await this.noteParent(
        run.featureId,
        `[conductor] ${who} · ${run.stepId}${attemptTag} → verdict: ${input.verdict}${counts}` +
          (publishStatus ? ` · ${publishStatus}` : "") +
          (digest ? `\n${digest}` : ""),
      )
      await this.dispatch(run.featureId, { kind: "step.verdict", stepId: run.stepId, verdict: input.verdict })
      return `Verdict "${input.verdict}" recorded for step "${run.stepId}".`
    }

    if (input.outcome === "succeeded") {
      store.finishRun(input.runId, "succeeded", { output: input.notes ?? "" })
      // Fixer resolutions: {"resolutions":[{"id":"F3","status":"fixed","note":"..."}]}
      // update the DB source of truth; findings.sync projects to GitHub
      // later.
      const resolutions = input.notes ? parseResolutionsLegacy(input.notes) : []
      const applied: string[] = []
      for (const r of resolutions) {
        if (store.setFindingStatus(run.featureId, r.id, r.status, r.note)) applied.push(`${r.id}→${r.status}`)
      }
      if (applied.length > 0) this.deps.log.log(`run ${input.runId}: finding resolutions: ${applied.join(", ")}`)
      await this.noteParent(
        run.featureId,
        `[conductor] ${who} · ${run.stepId}${attemptTag} → succeeded` +
          (applied.length > 0 ? ` · findings: ${applied.join(", ")}` : "") +
          (input.notes ? `\n${LegacyEngine.clip(input.notes)}` : ""),
      )
      await this.dispatch(run.featureId, { kind: "step.succeeded", stepId: run.stepId, output: input.notes ?? "" })
      return `Step "${run.stepId}" marked succeeded.`
    }

    store.finishRun(input.runId, "failed", { reason: input.notes ?? "reported failed" })
    await this.noteParent(
      run.featureId,
      `[conductor] ${who} · ${run.stepId}${attemptTag} → failed` + (input.notes ? `\n${LegacyEngine.clip(input.notes)}` : ""),
    )
    await this.dispatch(run.featureId, { kind: "step.failed", stepId: run.stepId, reason: input.notes ?? "reported failed" })
    return `Step "${run.stepId}" marked failed.`
  }

  /**
   * Publish a review verdict to the PR when the step carries a publish
   * block (per-step fields over config.reviewPublish defaults). Returns a
   * short status line for the timeline, or null when not applicable.
   */
  private async publishIfConfigured(
    run: { featureId: string; stepId: string },
    verdict: string,
    notes: string,
    findingIds: readonly string[] = [],
  ): Promise<string | null> {
    const state = this.deps.store.getFeature(run.featureId)
    if (!state) return null
    const config = this.configFor(state)
    if (!config) return null
    const step = this.defFor(state, config)?.pipeline.find(s => s.id === run.stepId)
    if (!step || step.type !== "agent" || step.publish === undefined) return null
    const publish = { ...config.reviewPublish, ...step.publish }
    if (publish.mode === "none") return null
    if (!config.repo || state.pr === null) return "publish skipped: no repo/PR"
    try {
      return await this.publishReview({
        repo: config.repo,
        pr: state.pr,
        verdict,
        notes,
        publish,
        cwd: state.worktree ?? state.projectDir,
        findingIds,
      })
    } catch (err) {
      return `publish FAILED: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
