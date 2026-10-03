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
 * Idle-without-report after debounce ⇒ nudged, then reaped (governed by
 * `idleSilenceNudgeMs`/`nudgeIdleCycles`); a `busy`/`retry` session gone
 * silent past `busySilenceNudgeMs` is nudged the same way. Both paths
 * share one durable per-run `maxNudges` budget; either can be overridden
 * per agent step (see `runLimits`). `runTtlMs` (or a step's own `ttlMs`)
 * is the outer bound in both directions: a TTL at or below either
 * silence threshold makes that threshold's recovery unreachable, so the
 * engine skips its debounce/nudge machinery entirely and reaps on TTL.
 *
 * Every dependency (store, workflow resolver, sessions, process
 * execution, clock, logger) is injected via `EngineDeps` — nothing here
 * reaches for an opencode SDK import, a process-wide global, or
 * `Date.now()` directly. `reconcile()` is a plain async method; the
 * daemon owns the timer.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { prepareReview, renderFixPack, validateReview, type AcceptedReview, type ReviewReport } from "./review.ts"
import { REPORT_REJECTED_PREFIX } from "./run-reporting.ts"
import { join } from "node:path"
import {
  DEFAULT_OUTCOME,
  behaviourForClass,
  boundDiagnostic,
  buildEvalContext,
  checkActiveStateInvariant,
  checkRetryBudget,
  classifyFence,
  healingDelayMs,
  needsAttention,
  normalizeHealingPolicy,
  computeScheduledDelayMs,
  decideResourceWaitRoute,
  extractExpressions,
  interpret,
  makeFailureEnvelope,
  normalizeResourceWaitPolicy,
  normalizeRetryPolicy,
  parseIsoDurationMs,
  renderTemplate,
  resolveWorkflowInputs,
  systemRandom,
} from "@conductor/core"
import type {
  HealingPolicy,
  Random,
  ActionInputType,
  ActionManifest,
  ActionRunContext,
  ActionStep,
  AgentStep,
  CommandStep,
  Decision,
  EvalContext,
  FailureClass,
  FailureEnvelope,
  FeatureState,
  PipelineEvent,
  StepDef,
  Transition,
  WorkflowDef,
  WorkflowInputDiagnostic,
} from "@conductor/core"
import type { RunSummary, Store } from "./store.ts"
import { applyPatch } from "./state.ts"
import { NoLiveRunnerError } from "./runner-transport.ts"
import type { WorkflowResolver, WorkflowSnapshot } from "./workflow-registry.ts"
import { RunnerOperationError, type Clock, type Logger, type ProcessRunner, type SessionClient } from "./ports.ts"
import type { ActionExecutor } from "./action-host.ts"
import { actionBindingsForReconciler } from "./workflow-reservation.ts"
import type { ResolvedActionBinding } from "./workflow-reservation.ts"
import { routeNewDispatch } from "./runner-router.ts"
import { deriveOperationLogicalKey, type RunnerFenceReasonCode, type RunnerOperationRecord } from "./runner-execution.ts"
import type { RunnersConfig } from "./acp/config.ts"

const DEFAULT_RUN_TTL_MS = 3_600_000
const DEFAULT_IDLE_SILENCE_NUDGE_MS = 120_000
const DEFAULT_BUSY_SILENCE_NUDGE_MS = 600_000
const DEFAULT_NUDGE_IDLE_CYCLES = 2
const DEFAULT_MAX_NUDGES = 2
/** Claim lease for an answer delivery attempt (harden-interactive-answer-
 *  delivery): bounds how long a claimant has to confirm or fail delivery
 *  before a crashed claimant's row becomes claimable again — same
 *  purpose as the retry-episode/resource-wait claim, sized for a single
 *  runner prompt round trip rather than a whole agent step. */
const ANSWER_DELIVERY_LEASE_MS = 60_000

export interface EngineDeps {
  readonly store: Store
  readonly workflows: WorkflowResolver
  /** The NATIVE SessionClient — used whenever a run's transport (new or
   *  bound) resolves to "native". */
  readonly sessions: SessionClient
  readonly process: ProcessRunner
  readonly clock: Clock
  readonly log: Logger
  readonly actions: ActionExecutor
  readonly runnerAvailable?: () => boolean
  readonly notify?: (title: string, message: string) => void
  /** Optional ACP runner configuration (D3) — absent means native-only,
   *  the existing default behavior is completely unchanged. */
  readonly runners?: RunnersConfig
  /** The ACP SessionClient (`ManagedSessions`, task 3.x) — required only
   *  when `runners` is configured with at least one ACP profile. */
  readonly acpSessions?: SessionClient
  /** Composition must release an unused preparation; abort is not cleanup evidence. */
  readonly releaseAcpReservation?: (reservationId: string) => Promise<void>
  readonly cleanupAcpRun?: (runId: string, sessionId: string | null) => Promise<"confirmed_terminated" | "unconfirmed">
  /** Monotonic daemon generation (D5/D10) — incremented every process
   *  start, persisted alongside bindings/operations so a restart can
   *  identify and fence stale-generation work before dispatching new
   *  work. Defaults to 0 for callers (most tests) that never restart. */
  readonly daemonGeneration?: number
}

export interface EngineOptions {
  readonly runTtlMs?: number
  readonly idleSilenceNudgeMs?: number
  readonly busySilenceNudgeMs?: number
  readonly nudgeIdleCycles?: number
  readonly maxNudges?: number
  /** Self-healing backoff/attention policy (D3). */
  readonly healing?: Partial<HealingPolicy>
  /** Upper bound on waiting for cleanup evidence before a fence is
   *  classified with whatever evidence exists (unconfirmed → unsafe). */
  readonly fenceClassifyTimeoutMs?: number
  readonly random?: Random
}

const DEFAULT_FENCE_CLASSIFY_TIMEOUT_MS = 15_000

export type StartFeatureResult =
  | { readonly ok: true; readonly feature: FeatureState }
  | { readonly ok: false; readonly code: "project_not_configured" | "unknown_workflow"; readonly message: string }
  | {
      readonly ok: false
      readonly code: "invalid_input"
      readonly message: string
      readonly diagnostics: readonly WorkflowInputDiagnostic[]
    }

export interface StartFeatureInput {
  readonly title: string
  readonly description?: string
  readonly workflow?: string
  readonly pr?: number
  readonly sessionId?: string
  /** Values for the selected workflow's declared `inputs`. OMITTED
   *  (`undefined`) is equivalent to `{}` — a workflow with no required
   *  inputs starts fine either way; `resolveWorkflowInputs` still applies
   *  its defaults. An explicit `null` (or any other non-object JSON
   *  value) is NOT coalesced to `{}` here — it reaches
   *  `resolveWorkflowInputs` as-is and is rejected as `invalid_payload`,
   *  the same as any other malformed payload a caller sends on purpose. */
  readonly inputs?: unknown
}

/** `Engine.answer`'s result contract — UNCHANGED wire shape across the
 *  harden-interactive-answer-delivery durability rework (same codes, same
 *  ok/message shape the API/CLI/web already handle). */
export type AnswerResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly code: "unknown_run" | "no_pending_question" | "session_lost"; readonly message: string }

/** Internal outcome of one `attemptAnswerDelivery` call — never exposed
 *  across the engine boundary; `answer()`/`reconcile()` each map it to
 *  their own caller-facing shape. */
type AnswerDeliveryAttemptResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "session_lost"; readonly message: string }
  | { readonly kind: "transient"; readonly message: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "not_claimed" }
  /** ACP-only (D5/D7): the delivery's local write submitted but is not
   *  yet (or never will be) confirmed — the run has been fenced; no
   *  replay, no step failure. */
  | { readonly kind: "fenced"; readonly message: string }

/** `planFailureDisposition`'s pure computation result: what
 *  `concludeAndDispatch` hands to `store.concludeRun` as ONE transaction
 *  alongside the run's own conclusion. `decisions` always replaces the
 *  interpreter's raw `transition.decisions` for both persistence and
 *  dispatch; `retrySchedule`/`followUp` are the two disposition shapes
 *  (durable retry vs. elapsed-budget exhaustion) and are mutually
 *  exclusive. */
type FailureDispositionPlan =
  | {
      readonly decisions: readonly Decision[]
      readonly retrySchedule: {
        readonly jobId: string
        readonly stepId: string
        readonly attempts: number
        readonly startedAt: number
        readonly pausedMs: number
        readonly featurePausedMsAtStart: number
        readonly nextAttemptAt: number
        readonly delayMs: number
        readonly scheduleSource: "backoff" | "retry_hint"
        readonly maxAttempts: number
        readonly maxElapsedMs: number
        readonly failure: FailureEnvelope
      }
      readonly followUp?: never
    }
  | {
      readonly decisions: readonly Decision[]
      readonly retrySchedule?: never
      readonly followUp: { readonly event: PipelineEvent; readonly transition: Transition }
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
  private readonly commandRuns = new Map<string, { featureId: string; controller: AbortController }>()
  private readonly runTtlMs: number
  private readonly idleSilenceNudgeMs: number
  private readonly busySilenceNudgeMs: number
  private readonly nudgeIdleCycles: number
  private readonly maxNudges: number
  private readonly healingPolicy: HealingPolicy
  private readonly fenceClassifyTimeoutMs: number
  private readonly random: Random

  constructor(
    private readonly deps: EngineDeps,
    options: EngineOptions = {},
  ) {
    this.runTtlMs = options.runTtlMs ?? DEFAULT_RUN_TTL_MS
    this.idleSilenceNudgeMs = options.idleSilenceNudgeMs ?? DEFAULT_IDLE_SILENCE_NUDGE_MS
    this.busySilenceNudgeMs = options.busySilenceNudgeMs ?? DEFAULT_BUSY_SILENCE_NUDGE_MS
    this.nudgeIdleCycles = options.nudgeIdleCycles ?? DEFAULT_NUDGE_IDLE_CYCLES
    this.maxNudges = options.maxNudges ?? DEFAULT_MAX_NUDGES
    this.healingPolicy = normalizeHealingPolicy(options.healing)
    this.fenceClassifyTimeoutMs = options.fenceClassifyTimeoutMs ?? DEFAULT_FENCE_CLASSIFY_TIMEOUT_MS
    this.random = options.random ?? systemRandom
  }

  /** The engine's resource-wait policy — normalized core defaults (v1):
   *  finite 30-minute deadline, bounded exponential observation backoff. */
  private resourceWaitPolicy(): ReturnType<typeof normalizeResourceWaitPolicy> {
    return normalizeResourceWaitPolicy()
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
    // Resolve declared workflow inputs BEFORE any durable state exists —
    // a rejected/mistyped/unknown input must leave no feature, run,
    // session, command or action behind. Only an OMITTED `inputs` field
    // (undefined) becomes `{}`; an explicit `null` is passed through
    // unchanged so `resolveWorkflowInputs` rejects it as `invalid_payload`
    // exactly like any other non-object payload a caller sends on purpose.
    const resolved = resolveWorkflowInputs(snapshot.workflow.inputs, input.inputs === undefined ? {} : input.inputs)
    if (!resolved.ok) {
      return {
        ok: false,
        code: "invalid_input",
        message: resolved.diagnostics.map(d => d.message).join("; "),
        diagnostics: resolved.diagnostics,
      }
    }
    const feature = this.deps.store.createFeature({
      title: input.title,
      slug: slugify(input.title),
      projectDir,
      workflow: snapshot.workflow.name,
      input: resolved.inputs,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.pr !== undefined ? { pr: input.pr } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    })
    // Interpret feature.start against the SAME snapshot already validated
    // and persisted above — never re-resolve via `this.deps.workflows()`
    // here. A `conductor.yaml` reload racing this call must not let the
    // first dispatch interpret a different workflow than the one whose
    // inputs were just resolved and whose name was just persisted.
    await this.dispatchWithSnapshot(feature.id, snapshot, { kind: "feature.start" })
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
    await this.dispatchWithSnapshot(featureId, snapshot, event)
  }

  /** `dispatch`'s core, parameterized on an already-resolved snapshot —
   *  the one seam `startFeature` reuses so the snapshot its inputs were
   *  resolved against is EXACTLY the snapshot `feature.start` interprets,
   *  even if a concurrent registry reload swaps `this.deps.workflows()`'s
   *  answer in between. Every other caller resolves fresh via `dispatch`. */
  private async dispatchWithSnapshot(featureId: string, snapshot: WorkflowSnapshot, event: PipelineEvent): Promise<void> {
    const { store, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) {
      log.log(`dispatch: unknown feature ${featureId}`)
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
        const state = this.deps.store.getFeature(featureId)
        const runtime = state?.jobs[decision.jobId]
        if (!state || !["running", "waiting_human"].includes(state.status)
          || runtime?.status !== "running" || runtime.currentStep !== decision.stepId
          || runtime.steps[decision.stepId]?.status !== "running") return
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

  private readonly preparingTargets = new Set<string>()

  /**
   * True while ANY step for `featureId` is between `executeAgent`'s entry
   * and its `finally` release — in particular while an ACP `prepare()`
   * call is awaiting a bounded resource/process wait (acp-runner review
   * F1). This is the "blocked prepare" progress anchor: no durable run
   * row or resource_wait row exists yet, so without this in-memory
   * anchor a concurrent reconcile pass sees zero anchors and would
   * wrongly mark the feature stranded/escalated while preparation is
   * still legitimately in flight on THIS SAME engine instance. Naturally
   * empty after a process restart (a fresh engine holds no in-flight
   * prepare calls) — restart correctly re-attempts instead of trying to
   * durably resume "was preparing".
   */
  private isPreparingAnyTargetFor(featureId: string): boolean {
    for (const key of this.preparingTargets) {
      const parsed = JSON.parse(key) as [string, string, string]
      if (parsed[0] === featureId) return true
    }
    return false
  }

  private async executeAgent(featureId: string, snapshot: WorkflowSnapshot, jobId: string, step: AgentStep): Promise<void> {
    const key = JSON.stringify([featureId, jobId, step.id])
    if (this.preparingTargets.has(key)) return
    this.preparingTargets.add(key)
    try {
      await this.executeAgentGuarded(featureId, snapshot, jobId, step)
    } finally {
      this.preparingTargets.delete(key)
    }
  }

  private async executeAgentGuarded(featureId: string, snapshot: WorkflowSnapshot, jobId: string, step: AgentStep): Promise<void> {
    const { store, sessions, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return
    const role = snapshot.workflow.roles[step.role]
    if (!role) {
      await this.dispatch(featureId, { kind: "step.failed", jobId, stepId: step.id, reason: `role "${step.role}" not configured` })
      return
    }

    if (store.getActiveRunForStep(featureId, jobId, step.id) || store.hasUnresolvedRunnerFence(featureId, jobId, step.id)) return
    const directory = state.worktree ?? state.projectDir
    const route = routeNewDispatch(this.deps.runners, state.projectDir, directory)
    if (route.transport === "acp_misconfigured") {
      await this.dispatch(featureId, { kind: "step.failed", jobId, stepId: step.id, reason: route.reason })
      return
    }

    if (route.transport === "native" && this.deps.runnerAvailable?.() === false) {
      const now = this.deps.clock.now()
      const policy = this.resourceWaitPolicy()
      const waitState = { firstObservedAtMs: now, observationCount: 0 }
      const observed = decideResourceWaitRoute("runner_unavailable", policy, waitState, now, systemRandom)
      store.upsertResourceWait({
        featureId,
        jobId,
        stepId: step.id,
        reason: "runner_unavailable",
        observedAt: now,
        nextObservationAt: observed.kind === "wait_resource" ? observed.nextObservationAtMs : now,
        deadlineAt: now + policy.maxWaitMs,
        diagnostic: "no runner registered with the daemon",
      })
      log.log(`feature=${state.slug} step=${jobId}/${step.id}: waiting for a runner`)
      return
    }

    const attempt = (state.jobs[jobId]?.attempts[step.id] ?? 0) + 1
    const feedback = store.getFeedback(featureId) ?? undefined
    const context = buildEvalContext(snapshot.workflow, state, jobId, feedback)
    let prompt = step.prompt
    let fixEvidence = ""
    try {
      const from = (ref: string | undefined, key: string) => {
        if (!ref) return undefined
        const [sourceJob, sourceStep] = ref.split("/")
        return feedback?.jobs[sourceJob!]?.[sourceStep!]?.[key]
      }
      const rawOrder = from(step.fixFrom, "work_order")
      const diagnostic = from(step.qualityFrom, "diagnostic")
      if (step.fixPrompt !== undefined && (rawOrder !== undefined || diagnostic !== undefined)) {
        prompt = step.fixPrompt
        if (rawOrder !== undefined) {
          const order = JSON.parse(rawOrder) as AcceptedReview
          const source = store.getRunById(order.runId)
          if (!source || source.featureId !== featureId || `${source.jobId}/${source.stepId}` !== step.fixFrom || source.status !== "succeeded" || source.outputs.work_order !== rawOrder) throw new Error("fix work order is not an accepted report from the configured gate")
          fixEvidence += `\n\n${renderFixPack(order)}`
        }
        if (diagnostic !== undefined) fixEvidence += `\n\nQuality diagnostic (${step.qualityFrom}):\n${diagnostic}`
      }
    } catch (error) {
      await this.dispatch(featureId, { kind: "step.failed", jobId, stepId: step.id, reason: `Invalid fix evidence: ${errorMessage(error)}` })
      return
    }
    if (step.reviewHead !== undefined) {
      const prior = store.listFindings(featureId).filter(finding => finding.sourceJobId === jobId && finding.stepId === step.id)
      fixEvidence += `\n\nStructured review required. Submit review JSON with head and findings using conductor report --review @file (or HTTP). Reuse every previous ID, explicitly fixing/dismissing or carrying it forward; reopening requires a reason. Explicit active blockers require changes_requested, otherwise approved.\nPrevious gate findings:\n${JSON.stringify(prior)}`
    }
    const rendered = renderTemplate(prompt, context)
    for (const error of rendered.errors) log.log(`job=${jobId} step=${step.id}: ${error}`)

    // Route BEFORE claiming the run: immutable binding-based routing
    // (D1/D3/D5) decides the transport for this NEW dispatch. An
    // existing run always keeps reading its persisted binding instead —
    // this call site only ever runs for a fresh attempt (executeAgent is
    // never called for an already-running run; the active-run guard in
    // actDecision/reconcile ensures that).
    let reservationId: string | undefined
    if (route.transport === "acp") {
      if (!this.deps.releaseAcpReservation) {
        await this.dispatch(featureId, { kind: "step.failed", jobId, stepId: step.id, reason: "ACP requires a reservation release hook before preparation" })
        return
      }
      const prepared = await this.deps.acpSessions?.prepare?.({ projectDir: state.projectDir, directory, agent: role.agent, ...(role.model !== undefined ? { model: role.model } : {}) })
      if (!prepared?.ok) {
        if (prepared?.reason === "unavailable") {
          const now = this.deps.clock.now()
          const policy = this.resourceWaitPolicy()
          const prior = store.getOpenResourceWait(featureId, jobId, step.id)
          store.upsertResourceWait({ featureId, jobId, stepId: step.id, reason: "runner_unavailable", observedAt: now,
            nextObservationAt: now + 1000, deadlineAt: prior?.deadlineAt ?? now + policy.maxWaitMs, diagnostic: prepared.diagnostic })
        } else {
          await this.dispatch(featureId, { kind: "step.failed", jobId, stepId: step.id, reason: prepared?.diagnostic ?? "ACP preparation unavailable" })
        }
        return
      }
      reservationId = prepared.reservationId
      const current = store.getFeature(featureId)
      if (!current || !["running", "waiting_human"].includes(current.status)
        || current.jobs[jobId]?.currentStep !== step.id
        || store.getActiveRunForStep(featureId, jobId, step.id)
        || store.hasUnresolvedRunnerFence(featureId, jobId, step.id)) {
        await this.deps.releaseAcpReservation?.(reservationId)
        return
      }
    }

    // Claim the run synchronously, BEFORE any await: this closes the
    // reconcile race a live daemon can hit — a concurrent reconcile pass
    // would otherwise see no run for this step while session setup below
    // is still in flight and re-dispatch it.
    const runId = store.insertRun({
      featureId,
      jobId,
      stepId: step.id,
      stepType: "agent",
      attempt,
      binding: {
        transport: route.transport,
        directory,
        daemonGeneration: this.deps.daemonGeneration ?? 0,
        ...(route.transport === "acp" ? { profileId: route.profileId, configDigest: acpConfigDigest(route.profile) } : {}),
      },
    })

    if (route.transport === "acp") {
      await this.executeAgentAcp(featureId, jobId, step, role, route.profileId, route.profile, runId, attempt, directory, rendered.text + fixEvidence, reservationId!)
      return
    }

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

      const recoverNotes = store.getRunById(runId)?.recoverNotes ?? null
      const header =
        `[conductor] Job "${jobId}" step "${step.id}" (attempt ${attempt}) — run ${runId}.\n` +
        `When this step is complete you MUST report run_id="${runId}" and its outcome.\n\n` +
        (recoverNotes !== null
          ? `[conductor] This step was recovered by an operator. Operator notes:\n${recoverNotes}\n\n`
          : "")

      await sessions.prompt({
        sessionID: sessionId,
        text: header + rendered.text + fixEvidence,
        agent: role.agent,
        ...(role.model !== undefined ? { model: role.model } : {}),
      })
    } catch (err) {
      // Secret-safe diagnostics: a prompt exception's message can embed
      // a huge upstream error body carrying a Bearer token/api_key/
      // password (a proxy or provider echoing the failed request back)
      // — `boundDiagnostic` redacts common credential shapes THEN
      // truncates, applied here so the SAME bounded/redacted text lands
      // in every downstream sink this `reason` reaches (run.reason,
      // the `step.failed` event, and the transition-log entry
      // `concludeAndDispatch`/`concludeRun` persist from it — never just
      // the FailureEnvelope's own `diagnostic`, which `makeFailureEnvelope`
      // already bounds separately).
      const reason = boundDiagnostic(`failed to prompt session: ${errorMessage(err)}`)
      if (err instanceof NoLiveRunnerError) {
        const now = this.deps.clock.now()
        const policy = this.resourceWaitPolicy()
        const wait = store.getOpenResourceWait(featureId, jobId, step.id)
        const observed = decideResourceWaitRoute("runner_unavailable", policy, {
          firstObservedAtMs: wait?.firstObservedAt ?? now,
          observationCount: wait?.observationCount ?? 0,
        }, now, systemRandom)
        store.concludeRunForResourceWait(runId, {
          featureId, jobId, stepId: step.id, reason: "runner_unavailable", observedAt: now,
          nextObservationAt: observed.kind === "wait_resource" ? observed.nextObservationAtMs : now,
          deadlineAt: wait?.deadlineAt ?? now + policy.maxWaitMs, diagnostic: reason,
        })
        return
      }
      await this.concludeAndDispatch(
        featureId, runId, "failed",
        { reason, failure: makeFailureEnvelope({ class: classifyThrownBoundary(err), diagnostic: reason, source: "runner" }) },
        { kind: "step.failed", jobId, stepId: step.id, reason },
      )
    }
  }

  /**
   * ACP execution path (D4/D5/D6/D7): prepare a bounded reservation,
   * create the session, submit the initial prompt through the durable
   * operation journal, and observe completion asynchronously — never
   * blocking dispatch on turn completion. Every failure mode that could
   * mean a create/prompt effect landed on the agent side fences the run
   * (D6) instead of routing through ordinary `step.failed`.
   */
  private async executeAgentAcp(
    featureId: string,
    jobId: string,
    step: AgentStep,
    role: { agent: string; model?: string; variant?: string },
    profileId: string,
    profile: import("./acp/config.ts").AcpProfileConfig,
    runId: string,
    attempt: number,
    directory: string,
    promptText: string,
    reservationId: string,
  ): Promise<void> {
    const { store, log } = this.deps
    const acpSessions = this.deps.acpSessions
    if (!acpSessions) {
      await this.fenceOrFail(featureId, runId, jobId, step.id, "acp_not_configured", "ACP profile is routed but no ACP session client is wired into the engine")
      return
    }
    // role→mode binding validation (D3: "each must map explicitly to an
    // advertised ACP mode") lives inside ManagedSessions.prepare() itself
    // — this call site only routes to the transport, never duplicates
    // that validation.

    // Preparation already completed under the target guard before run insertion.
    // Only consume the reserved process here; never prepare a second process.
    const prepareResult = { ok: true as const, reservationId }

    let sessionId: string
    try {
      sessionId = (await acpSessions.createSession({
        title: `[${role.agent}] run ${runId}`,
        directory,
        runId,
        reservationId: prepareResult.reservationId,
        operationId: deriveOperationLogicalKey("create", { runId }),
      })).id
    } catch (err) {
      if (!(err instanceof RunnerOperationError) || err.delivery === "unknown") {
        await this.fenceOrFail(featureId, runId, jobId, step.id, "lost_create_response", err instanceof RunnerOperationError ? err.diagnostic : "ACP create outcome unknown")
        return
      }
      const reason = boundDiagnostic(`ACP session creation failed: ${errorMessage(err)}`)
      await this.concludeAndDispatch(
        featureId, runId, "failed",
        { reason, failure: makeFailureEnvelope({ class: acpFailureClass(err), diagnostic: reason, source: "acp" }) },
        { kind: "step.failed", jobId, stepId: step.id, reason },
      )
      return
    }

    if (!store.setRunSession(runId, sessionId)) {
      log.log(`run ${runId}: concluded before its ACP session was ready — not prompting`)
      return
    }

    const recoverNotes = store.getRunById(runId)?.recoverNotes ?? null
    const header =
      `[conductor] Job "${jobId}" step "${step.id}" (attempt ${attempt}) — run ${runId}.\n` +
      `When this step is complete you MUST report run_id="${runId}" and its outcome.\n\n` +
      (recoverNotes !== null ? `[conductor] This step was recovered by an operator. Operator notes:\n${recoverNotes}\n\n` : "")

    try {
      await acpSessions.prompt({
        sessionID: sessionId,
        text: header + promptText,
        agent: role.agent,
        ...(role.model !== undefined ? { model: role.model } : {}),
        operationId: deriveOperationLogicalKey("prompt", { runId }),
        purpose: "initial",
      })
      // A resolved `void`/`{kind:"submitted"}` both mean "engine calls
      // return after bounded write submission ... not turn completion"
      // (D7) — the actual turn outcome is observed later via
      // observeOperation from reconcileAgentRun/nudge/report paths, not
      // awaited here.
    } catch (err) {
      if (!(err instanceof RunnerOperationError) || err.delivery === "unknown") {
        await this.fenceOrFail(featureId, runId, jobId, step.id, "lost_prompt_response", err instanceof RunnerOperationError ? err.diagnostic : "ACP prompt outcome unknown")
        return
      }
      const reason = boundDiagnostic(`ACP prompt failed: ${errorMessage(err)}`)
      await this.concludeAndDispatch(
        featureId, runId, "failed",
        { reason, failure: makeFailureEnvelope({ class: acpFailureClass(err), diagnostic: reason, source: "acp" }) },
        { kind: "step.failed", jobId, stepId: step.id, reason },
      )
    }
    void profileId
    void profile
  }

  /** Fences a run for durable execution uncertainty (D6) — the
   *  transaction wrapper every ACP call site with `delivery: "unknown"`
   *  goes through. Best-effort: if the fence transaction itself finds
   *  the run no longer fenceable (already concluded another way), that
   *  is the SAFE outcome (a report won the race) and is silently
   *  accepted. */
  private async fenceOrFail(
    featureId: string,
    runId: string,
    jobId: string,
    stepId: string,
    reasonCode: RunnerFenceReasonCode | "acp_not_configured",
    diagnostic: string,
    operationId?: string,
  ): Promise<void> {
    const { store, log } = this.deps
    if (reasonCode === "acp_not_configured") {
      // A pure configuration/wiring defect — never a "might have
      // executed" uncertainty. Ordinary step.failed, not a fence.
      await this.concludeAndDispatch(
        featureId, runId, "failed",
        { reason: diagnostic, failure: makeFailureEnvelope({ class: "invalid_config", diagnostic, source: "acp" }) },
        { kind: "step.failed", jobId, stepId, reason: diagnostic },
      )
      return
    }
    const result = store.fenceRunnerExecution(
      { runId, jobId, stepId, reasonCode, diagnostic: boundDiagnostic(diagnostic), ...(operationId !== undefined ? { operationId } : {}) },
      projectDir => this.deps.workflows(projectDir) ?? undefined,
    )
    if (!result.fenced) {
      log.log(`run ${runId}: fence request (${reasonCode}) did not apply (${result.reason}) — another disposition already won`)
    } else {
      this.cleanupRunner(runId)
      // Notification is delivered by the durable completion outbox.
    }
  }

  private readonly runnerCleanupTasks = new Set<Promise<void>>()
  private readonly cleanupInFlight = new Set<string>()

  private cleanupRunner(runId: string): void {
    const run = this.deps.store.getRunById(runId)
    if (!run) return
    if (this.deps.store.getRunnerBinding(runId)?.transport !== "acp") {
      void this.classifyFencedRun(runId, true)
      return
    }
    this.cleanupInFlight.add(runId)
    const task = Promise.resolve().then(async () => {
      if (this.deps.cleanupAcpRun) {
        const evidence = await this.deps.cleanupAcpRun(runId, run.sessionId)
        this.deps.store.recordRunnerCleanup(runId, evidence)
      } else if (run.sessionId) await this.deps.acpSessions?.abort(run.sessionId)
    }).catch(error => this.deps.log.log(`ACP cleanup unconfirmed: ${boundDiagnostic(errorMessage(error))}`))
      .then(() => this.classifyFencedRun(runId, true))
    this.runnerCleanupTasks.add(task)
    void task.finally(() => {
      this.runnerCleanupTasks.delete(task)
      this.cleanupInFlight.delete(runId)
    })
  }

  async drainRunnerCleanup(): Promise<void> {
    await Promise.all(this.runnerCleanupTasks)
  }

  /**
   * Self-healing D1: classify a fence from durable evidence once cleanup
   * evidence exists (or `force` after the bounded wait), then route it —
   * unsafe escalates, healable schedules a healing attempt.
   */
  async classifyFencedRun(runId: string, force = false): Promise<void> {
    const { store, log } = this.deps
    const fence = store.getFence(runId)
    if (!fence || fence.resolvedAt !== null || (fence.classification ?? null) !== null) return
    if (!force && fence.cleanupState === "unconfirmed" && this.deps.cleanupAcpRun) return
    const run = store.getRunById(runId)
    if (!run) return
    const feature = store.getFeature(run.featureId)
    if (!feature) return
    const snapshot = this.deps.workflows(feature.projectDir)
    const step = snapshot ? findStep(snapshot.workflow, run.jobId, run.stepId) : undefined
    const pre = fence.evidence ?? {}
    const evidence = {
      sessionBound: pre["sessionBound"] !== false,
      promptLeftPrepared: pre["promptLeftPrepared"] !== false,
      pendingAnswerDelivery: pre["pendingAnswerDelivery"] !== false,
      cleanup: fence.cleanupState,
      stepReplaySafe: step?.type === "agent" && step.replaySafe === true,
    }
    const classification = classifyFence(evidence)
    const result = store.classifyFenceExecution(runId, {
      classification,
      evidence: { ...evidence, reasonCode: fence.reasonCode },
      planHealing: failures => ({
        delayMs: healingDelayMs(this.healingPolicy, failures, this.random),
        attention: needsAttention(this.healingPolicy, failures),
      }),
    }, projectDir => this.deps.workflows(projectDir) ?? undefined)
    if (!result.classified) return
    log.log(`run ${runId}: fence classified ${classification}${result.healing
      ? ` — healing attempt ${result.healing.consecutiveFailures} in ${Math.round(result.healing.delayMs / 1000)}s` : ""}`)
    if (classification === "unsafe") {
      const pending = store.getPendingRunAction(run.featureId)
      if (pending?.runId === runId) {
        for (const decision of pending.decisions) {
          if (decision.kind === "escalate") this.deps.notify?.(`Conductor: escalation — ${feature.slug}`, decision.reason)
        }
        store.markRunActionHandled(runId)
      }
    }
  }

  /** Reconcile-side classification: fences whose cleanup evidence landed
   *  but whose classification did not (crash in between), or whose
   *  evidence never arrives within the bound (e.g. after a restart). */
  private async classifyPendingFences(): Promise<void> {
    const now = this.deps.clock.now()
    for (const fence of this.deps.store.listUnclassifiedFences()) {
      const inFlight = this.cleanupInFlight.has(fence.runId)
      const timedOut = now - fence.createdAt >= this.fenceClassifyTimeoutMs
      if (inFlight && !timedOut) continue
      if (fence.cleanupState === "unconfirmed" && this.deps.cleanupAcpRun && !timedOut) continue
      await this.classifyFencedRun(fence.runId, true)
    }
  }

  /** Dispatch due healing attempts (self-healing D3). */
  private async healDueTargets(featureId: string, snapshot: WorkflowSnapshot): Promise<void> {
    const { store, clock, log } = this.deps
    for (const episode of store.listDueHealingEpisodes(featureId, clock.now())) {
      const healed = store.healFencedTarget(episode.id, clock.now())
      if (!healed) continue
      log.log(`feature=${featureId}: healing "${healed.jobId}/${healed.stepId}" (${healed.classification}, attempt ${healed.consecutiveFailures})`)
      await this.actDecision(featureId, snapshot, { kind: "execute_step", jobId: healed.jobId, stepId: healed.stepId })
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

    const runId = store.insertRun({
      featureId,
      jobId,
      stepId: step.id,
      stepType: "command",
      attempt,
    })

    const controller = new AbortController()
    this.commandRuns.set(runId, { featureId, controller })
    const outputDir = await mkdtemp(join(tmpdir(), "conductor-output-"))
    const outputPath = join(outputDir, "outputs")
    try {
      let failureReason: string | null = null
      let failureClass: FailureClass = "deterministic_failure"
      for (const raw of step.run) {
        if (controller.signal.aborted) return
        const command = renderTemplate(raw, context).text
        const result = await process.shell(command, {
          cwd,
          signal: controller.signal,
          env: { CONDUCTOR_OUTPUT: outputPath },
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        })
        // The interleaved capture becomes the run's narrative log — the
        // failure `reason` below keeps carrying the output tail exactly as
        // before; the log supplements it, never replaces it.
        if (controller.signal.aborted) return
        if (result.output !== "") store.appendRunLog(runId, [{ source: "process", text: result.output }])
        if (result.code !== 0) {
          // Secret-safe diagnostics: a failing command's captured output
          // tail can carry a credential the command itself printed (a
          // curl invocation logging its own Authorization header, a
          // misconfigured tool dumping env). `boundDiagnostic` redacts
          // common credential shapes before this becomes the durable
          // run.reason/transition-log/API-visible failure text.
          failureReason = boundDiagnostic(`"${command}" exited ${result.code}: ${result.output.slice(-4000)}`)
          failureClass = classifyProcessExit(result.code)
          break
        }
      }
      const outputs = await readOutputFile(outputPath)

      if (failureReason !== null) {
        await this.concludeAndDispatch(
          featureId,
          runId,
          "failed",
          {
            outputs,
            reason: failureReason,
            failure: makeFailureEnvelope({ class: failureClass, diagnostic: failureReason, source: "command" }),
          },
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
      this.commandRuns.delete(runId)
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
          // Classification reads the RAW error text (never redacted —
          // redaction only strips credential shapes, never the
          // `capability_denied:`/exit-code markers classification keys
          // on, but classifying on the post-redaction text would be one
          // avoidable coupling between two independent concerns).
          // Secret-safe diagnostics: an action's error can carry a
          // credential (a bundled action's subprocess echoing a failed
          // authenticated request) — bound/redact once here and reuse
          // the SAME text for `run.reason`, the FailureEnvelope
          // diagnostic, and the `step.failed` event reason.
          const failureClass: FailureClass = result.error.startsWith("capability_denied:")
            ? "invalid_config"
            : /exited 127/.test(result.error)
              ? "invalid_config"
              : "deterministic_failure"
          const reason = boundDiagnostic(result.error)
          await this.concludeAndDispatch(
            featureId, runId, "failed",
            { reason, failure: makeFailureEnvelope({ class: failureClass, diagnostic: reason, source: "action" }) },
            { kind: "step.failed", jobId, stepId, reason },
          )
          return
        }
        const outputs = stringifyOutputs(result.outputs)
        await this.concludeAndDispatch(
          featureId, runId, "succeeded", { outputs },
          { kind: "step.completed", jobId, stepId, outcome: DEFAULT_OUTCOME, outputs },
        )
      } catch (err) {
        const reason = boundDiagnostic(`action host error: ${errorMessage(err)}`)
        await this.concludeAndDispatch(
          featureId, runId, "failed",
          { reason, failure: makeFailureEnvelope({ class: classifyThrownBoundary(err), diagnostic: reason, source: "action" }) },
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
   *
   * When the conclusion is a classified failure and the interpreter
   * decided to retry the same step, `planFailureDisposition` computes
   * (purely — no store writes) whether a non-zero backoff delay should
   * convert the immediate `execute_step` into a DURABLE scheduled retry,
   * or whether the elapsed retry budget is already exhausted and the
   * step should instead route straight to its `step.budget_exhausted`
   * terminal transition. Either way the plan's decisions/schedule/
   * follow-up transition are handed to `store.concludeRun` as ONE
   * transaction with the run's conclusion — a crash between "run
   * concluded" and "its retry disposition recorded" is impossible: both
   * land in the same commit, so a restarted reconciler never replays a
   * stale immediate `execute_step` that bypasses backoff. Zero-delay
   * policies (and non-failure conclusions) keep the plain immediate
   * dispatch, unchanged.
   */
  private async concludeAndDispatch(
    featureId: string,
    runId: string,
    status: "succeeded" | "failed" | "reaped",
    detail: { outputs?: Readonly<Record<string, string>>; reason?: string; failure?: FailureEnvelope } | undefined,
    event: PipelineEvent,
    review?: AcceptedReview,
    authorize?: () => void,
  ): Promise<boolean> {
    const { store, log } = this.deps
    const state = store.getFeature(featureId)
    if (!state) return false
    const snapshot = this.deps.workflows(state.projectDir)
    if (!snapshot) return false
    let transition = interpret(snapshot.workflow, state, event)
    if (event.kind === "step.failed" && detail?.failure?.source === "command" && transition.feedback) {
      const feedback = transition.feedback
      transition = {
        ...transition,
        feedback: {
          ...feedback,
          jobs: {
            ...feedback.jobs,
            [event.jobId]: {
              ...feedback.jobs[event.jobId],
              [event.stepId]: {
                ...feedback.jobs[event.jobId]?.[event.stepId],
                diagnostic: boundDiagnostic(detail.reason ?? event.reason),
              },
            },
          },
        },
      }
    }

    const plan =
      detail?.failure !== undefined && event.kind === "step.failed"
        ? this.planFailureDisposition(featureId, runId, snapshot, state, event, detail.failure, transition)
        : null
    const decisions = plan?.decisions ?? transition.decisions

    const result = store.concludeRun(runId, status, detail, event, transition, {
      persistDecisions: decisions,
      ...(authorize ? { authorize } : {}),
      ...(review ? { review } : {}),
      ...(plan?.retrySchedule ? { retrySchedule: plan.retrySchedule } : {}),
      ...(plan?.followUp ? { followUp: plan.followUp } : {}),
    })
    if (!result.claimed) return false
    this.cleanupRunner(runId)
    log.log(`feature=${state.slug} event=${event.kind} → ${transition.decisions.map(decisionLabel).join(",")}`)

    if (plan?.retrySchedule) {
      log.log(
        result.episode !== null
          ? `feature=${state.slug}: retry of "${plan.retrySchedule.jobId}/${plan.retrySchedule.stepId}" scheduled in ${plan.retrySchedule.delayMs}ms (class ${plan.retrySchedule.failure.class}, ${plan.retrySchedule.scheduleSource})`
          // A racing conclusion for the same job+step already owns the open
          // episode: its own schedule fires the retry, so there is
          // deliberately no immediate fallback dispatch here — that
          // fallback was the schedule-contention bug (a second in-flight
          // conclusion bypassing the owner's backoff).
          : `feature=${state.slug}: "${plan.retrySchedule.jobId}/${plan.retrySchedule.stepId}" already has an open retry episode — its own schedule applies, no immediate dispatch`,
      )
    }
    // Dispatch, THEN mark the outbox entry handled: a crash mid-dispatch
    // (e.g. during an agent's session creation) leaves the entry pending
    // so a restarted reconciler recovers it — the normal path closes it
    // out here so it never lingers as a false "pending" forever.
    await this.dispatchDecisions(featureId, snapshot, decisions)
    store.markRunActionHandled(runId)
    return true
  }

  /**
   * Pure computation of a classified failure's retry disposition — no
   * store writes, so `concludeAndDispatch` can hand the result straight
   * to `store.concludeRun` as part of ONE transaction. Returns `null`
   * when the transition has no matching `execute_step` decision to
   * intercept (nothing to retry-schedule) OR the computed backoff delay
   * is zero (immediate retry, unchanged behaviour) — both cases mean
   * "dispatch `transition.decisions` exactly as the interpreter produced
   * them", the caller's fallback.
   *
   * The delay comes from the STEP's own `retry.backoff` when declared
   * (the workflow author's word), else from the class-default policy —
   * an adapter's retry hint can only raise it within policy bounds.
   *
   * Before scheduling, the candidate attempt is checked against the
   * class's elapsed retry budget via the pure `checkRetryBudget`
   * (retry-budget spec: "the next computed attempt would start after the
   * elapsed deadline ... it is not scheduled, and the workflow reaches
   * its configured terminal route at the deadline without one extra
   * attempt"). The interpreter already gates the ATTEMPTS bound before
   * ever producing this `execute_step` decision, so this call's attempts
   * axis is always satisfied here — only the elapsed axis can newly
   * reject, and it routes through `step.budget_exhausted` (the SAME
   * `onFail`/job-failure terminal route an attempts-exhausted failure
   * takes) instead of scheduling — computed here as a `followUp`
   * transition over `applyPatch(state, transition.patch)` (the state as
   * it will read once the main transition lands) so it commits alongside
   * the main transition instead of a second, separately-crashable step.
   */
  private planFailureDisposition(
    featureId: string,
    runId: string,
    snapshot: WorkflowSnapshot,
    state: FeatureState,
    event: Extract<PipelineEvent, { kind: "step.failed" }>,
    failure: FailureEnvelope,
    transition: Transition,
  ): FailureDispositionPlan | null {
    const { store, clock } = this.deps
    const matchIndex = transition.decisions.findIndex(
      decision => decision.kind === "execute_step" && decision.jobId === event.jobId && decision.stepId === event.stepId,
    )
    if (matchIndex === -1) return null

    const step = findStep(snapshot.workflow, event.jobId, event.stepId)
    const patchedState = applyPatch(state, transition.patch)
    const attempts = patchedState.jobs[event.jobId]?.attempts[event.stepId] ?? 1
    const classBehaviour = behaviourForClass(normalizeRetryPolicy(), failure.class)
    const stepRetry = step !== undefined && step.retry.strategy === "backoff" ? step.retry : undefined
    const backoff = stepRetry?.backoff ?? classBehaviour.backoff
    const maxAttempts = stepRetry?.maxAttempts ?? classBehaviour.budget.maxAttempts
    // The step's own `retry.maxElapsed`, when declared, is the episode's
    // elapsed deadline; absent (or unparseable, which validation already
    // rejects at load time) falls back to the failure class's default.
    const maxElapsedMs = (stepRetry?.maxElapsed !== undefined ? parseIsoDurationMs(stepRetry.maxElapsed) : undefined) ?? classBehaviour.budget.maxElapsedMs
    const schedule = computeScheduledDelayMs(backoff, attempts, systemRandom, failure.retryHintMs)
    const now = clock.now()

    // The streak's elapsed-budget anchor (`startedAt`) is inherited from
    // the immediately preceding episode for this exact job+step when
    // this failure continues an existing streak (attempts > 1) — never
    // reset to "now" mid-streak, or the elapsed deadline could never be
    // reached. With no prior episode (genuinely attempt 1, or every
    // earlier attempt in the streak was an immediate zero-delay retry
    // that never persisted a row) the anchor is the JUST-CONCLUDED run's
    // own dispatch time (design.md: "max_elapsed starts immediately
    // before first dispatch") — never "now", which would silently
    // exclude however long that first attempt actually ran for from its
    // own budget.
    //
    // `pausedMs` for the budget check is the streak's pause total
    // computed FRESH here — feature cumulative paused_ms NOW (as of
    // `now`, including any pause span still open at this instant) minus
    // the streak's baseline snapshot — rather than trusting a stale
    // per-episode column: the old per-episode `pausedMs` fold only ever
    // covered spans while an episode was OPEN, silently losing pause
    // time during an executing attempt (no open row for the pause-fold
    // to land in, whether this is the first attempt with no episode yet
    // or a later attempt whose previous episode already closed
    // `attempt_dispatched`). Computing the delta at read time instead
    // counts every pause span inside the streak exactly once, no matter
    // when during the streak it happened.
    const previousEpisode = store.listRetryEpisodes(featureId)
      .filter(episode => episode.jobId === event.jobId && episode.stepId === event.stepId)
      .at(-1)
    const chained = attempts > 1 ? previousEpisode : undefined
    const anchorRun = store.getRunById(runId)
    const firstAttemptStartedAt = anchorRun?.timeStarted ?? now
    const episodeStartedAtMs = chained?.startedAt ?? firstAttemptStartedAt
    const featurePausedMsAtStart = chained?.featurePausedMsAtStart ?? anchorRun?.pausedMsAtDispatch ?? 0
    const featurePausedMsNow = store.getFeaturePausedMsAsOf(featureId, now) ?? featurePausedMsAtStart
    const pausedMs = Math.max(0, featurePausedMsNow - featurePausedMsAtStart)
    const candidateAtMs = now + schedule.delayMs

    const budget = checkRetryBudget({
      attempts, maxAttempts, maxElapsedMs,
      episodeStartedAtMs, pausedMs,
      candidateAttemptAtMs: candidateAtMs,
    })
    const withoutRetriedStep = transition.decisions.filter((_, index) => index !== matchIndex)

    if (!budget.ok) {
      const elapsed = Math.max(0, now - episodeStartedAtMs - pausedMs)
      const reason = budget.exhaustedBy === "attempts"
        ? `"${event.jobId}/${event.stepId}" exhausted ${maxAttempts} attempt(s) for class "${failure.class}": ${failure.diagnostic}`
        : `"${event.jobId}/${event.stepId}" exceeded ${maxElapsedMs}ms elapsed retry budget (${elapsed}ms elapsed) for class "${failure.class}": ${failure.diagnostic}`
      const budgetEvent: PipelineEvent = { kind: "step.budget_exhausted", jobId: event.jobId, stepId: event.stepId, reason }
      const budgetTransition = interpret(snapshot.workflow, patchedState, budgetEvent)
      return {
        decisions: [...withoutRetriedStep, ...budgetTransition.decisions],
        followUp: { event: budgetEvent, transition: budgetTransition },
      }
    }

    if (schedule.delayMs <= 0) return null

    return {
      decisions: withoutRetriedStep,
      retrySchedule: {
        jobId: event.jobId, stepId: event.stepId,
        attempts, startedAt: episodeStartedAtMs, pausedMs, featurePausedMsAtStart,
        nextAttemptAt: candidateAtMs, delayMs: schedule.delayMs, scheduleSource: schedule.source,
        maxAttempts, maxElapsedMs,
        failure,
      },
    }
  }

  // --------------------------------------------------------------- reports

  /**
   * Called by the API's report endpoint from inside agent sessions. The
   * ONLY path by which an agent step concludes — idle never does.
   */
  async report(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string; ask?: string; review?: unknown }): Promise<string> {
    return this.reportAuthorized(input)
  }

  async reportWorker(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string; ask?: string; review?: unknown; invocationId?: string; authorize: () => void }): Promise<string> {
    return this.reportAuthorized(input, input)
  }

  /** Shared validation and dispatch; only synchronous Store mutations receive the guard. */
  private async reportAuthorized(input: { runId: string; outcome?: "succeeded" | "failed"; verdict?: string; notes?: string; ask?: string; review?: unknown }, worker?: { authorize: () => void; invocationId?: string }): Promise<string> {
    const { store } = this.deps
    const run = store.getRunById(input.runId)
    if (!run) return `Unknown run_id "${input.runId}".`
    if (run.status !== "running") return alreadyConcludedText(input.runId, run.status)

    const feature = store.getFeature(run.featureId)
    const definition = feature ? this.deps.workflows(feature.projectDir)?.workflow : undefined
    const configured = definition ? findStep(definition, run.jobId, run.stepId) : undefined
    let review: AcceptedReview | undefined
    if (input.review !== undefined || (configured?.type === "agent" && configured.reviewHead !== undefined && input.outcome !== "failed" && input.ask === undefined)) {
      try {
        if (configured?.type !== "agent" || configured.reviewHead === undefined || !feature || !definition) throw new Error("step is not configured for structured review")
        if (input.outcome === "failed" || input.ask !== undefined) throw new Error("review cannot be combined with failure or ask")
        const error = validateReview(input.review)
        if (error) throw new Error(error)
        const report = input.review as ReviewReport
        const head = renderTemplate(configured.reviewHead, buildEvalContext(definition, feature, run.jobId))
        if (head.errors.length || head.text !== report.head) throw new Error("review head does not match configured reviewed head")
        review = prepareReview(report, store.listFindings(run.featureId), { runId: run.id, jobId: run.jobId, stepId: run.stepId }, input.verdict)
      } catch (error) {
        return `Invalid review: ${errorMessage(error)}`
      }
    }
    const outputs = { report: input.notes ?? "", ...(review ? { work_order: JSON.stringify(review) } : {}) }

    if (input.ask !== undefined) {
      // Asking is a privilege the workflow grants per step: only an
      // `interactive: true` agent step may pause for a human. Refusal is
      // NOT a failure — the run stays running and the agent is told to
      // decide autonomously (or report failed with notes if truly stuck).
      const state = store.getFeature(run.featureId)
      const snapshot = state ? this.deps.workflows(state.projectDir) : null
      const step = snapshot ? findStep(snapshot.workflow, run.jobId, run.stepId) : undefined
      if (!step || step.type !== "agent" || step.interactive !== true) {
        return (
          `Step "${run.stepId}" is not interactive — asking is not available here. ` +
          `Decide autonomously using your best judgment and report run_id="${input.runId}" with an outcome. ` +
          `If human input is truly indispensable, report outcome "failed" with notes explaining exactly what is missing.`
        )
      }
      // An ask parks the run on a human question WITHOUT concluding it:
      // the session stays alive so the answer resumes with full context.
      const disposition = `Question recorded for step "${run.stepId}" — the run is waiting for a human answer.`
      if (worker && !worker.invocationId) throw new Error("ask requires invocationId")
      const parked = store.setRunQuestion(input.runId, input.ask, worker ? {
        authorize: worker.authorize, invocationId: worker.invocationId!, disposition,
        payloadDigest: createHash("sha256").update(JSON.stringify({ ask: input.ask, notes: input.notes ?? null })).digest("hex"),
      } : undefined)
      if (typeof parked === "string") return parked
      if (!parked) return alreadyConcludedText(input.runId, store.getRunById(input.runId)?.status ?? run.status)
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
            outputs,
          }
    if (event.kind === "step.completed") {
      // A step that declares outcomes routes on the verdict — concluding
      // it with an unmapped one would escalate the whole feature over a
      // mis-filed report. Bounce it back to the agent instead: the run
      // stays running and the agent re-reports with a declared verdict.
      const state = store.getFeature(run.featureId)
      const snapshot = state ? this.deps.workflows(state.projectDir) : null
      const step = snapshot ? findStep(snapshot.workflow, run.jobId, run.stepId) : undefined
      if (step && step.type === "agent") {
        const declared = Object.keys(step.outcomes)
        if (declared.length > 0 && !declared.includes(event.outcome ?? DEFAULT_OUTCOME)) {
          const options = declared.map(name => `"${name}"`).join(", ")
          return input.verdict !== undefined
            ? `Verdict "${input.verdict}" is not declared for step "${run.stepId}" — report again with one of: ${options}.`
            : `Step "${run.stepId}" requires a verdict — report again with verdict set to one of: ${options}.`
        }
      }
    }
    const status: "succeeded" | "failed" = input.outcome === "failed" ? "failed" : "succeeded"
    const detail = status === "failed" ? { reason: input.notes ?? "reported failed" } : { outputs }

    const claimed = await this.concludeAndDispatch(run.featureId, input.runId, status, detail, event, review, worker?.authorize)
    if (!claimed) {
      const after = store.getRunById(input.runId)
      return alreadyConcludedText(input.runId, after?.status ?? run.status)
    }
    if (status === "failed") return `Step "${run.stepId}" marked failed.`
    if (input.verdict !== undefined) return `Verdict "${input.verdict}" recorded for step "${run.stepId}".`
    return `Step "${run.stepId}" marked succeeded.`
  }

  /**
   * Deliver a human's answer to an asking run. Acceptance is durable
   * BEFORE any runner side effect (`store.acceptAnswer`) — the
   * confirmation-of-effect split harden-interactive-answer-delivery adds
   * ahead of the completion-decision outbox's existing discipline: a
   * crash after this call returns cannot lose the operator's decision,
   * only defer its delivery to reconciliation. Delivery itself (forward
   * the notes into the run's LIVE session — that is the whole point,
   * context is preserved) is attempted immediately for low latency via
   * `attemptAnswerDelivery`, the SAME worker `reconcile()` uses to repair
   * a crash or resume a paused delivery. A dead session or terminal
   * prompt error fails the step honestly through the normal step-failed
   * path so retry/onFail semantics apply; the accepted notes remain on
   * the (now failed) delivery record for audit either way.
   */
  async answer(runId: string, notes: string): Promise<AnswerResult> {
    const { store } = this.deps
    const run = store.getRunById(runId)
    if (!run) return { ok: false, code: "unknown_run", message: `Unknown run_id "${runId}".` }

    const accepted = store.acceptAnswer(runId, notes)
    if (accepted.kind === "not_asking" || accepted.kind === "run_not_active") {
      return { ok: false, code: "no_pending_question", message: `Run "${runId}" has no pending question.` }
    }
    if (accepted.kind === "already_accepted") {
      // Clarified decision ("Repeated answer while accepted-pending"): a
      // second answer for the same question while the first is
      // accepted-but-undelivered is a conflict, never an idempotent
      // success and never a notes replacement — reuses the same wire
      // code as "no pending question" since there is no caller
      // idempotency key in the current contract to distinguish them.
      return { ok: false, code: "no_pending_question", message: `Run "${runId}" already has an accepted answer awaiting delivery.` }
    }

    // Clarified decision ("Pause interaction"): acceptance is durable
    // regardless of pause, but the runner prompt side effect is never
    // attempted while the feature is paused — the same scheduling
    // barrier `listPendingAnswerDeliveries` enforces for reconciliation.
    // The delivery stays pending; resuming and reconciling delivers it.
    const feature = store.getFeature(run.featureId)
    if (feature?.status === "paused") {
      return {
        ok: true,
        message: `Answer accepted for step "${run.stepId}" — the feature is paused; delivery resumes once it is unpaused.`,
      }
    }

    const attempt = await this.attemptAnswerDelivery(accepted.delivery.id)
    if (attempt.kind === "session_lost") return { ok: false, code: "session_lost", message: attempt.message }
    if (attempt.kind === "delivered") {
      const after = store.getFeature(run.featureId)
      return { ok: true, message: `Answer delivered to step "${run.stepId}". Feature is now: ${after?.status ?? "running"}.` }
    }
    if (attempt.kind === "fenced") {
      // Notes remain accepted/durable; the ANSWER call itself never
      // fails — the run's uncertainty is now operator-visible and
      // requires explicit recovery acknowledgment (D6), never an
      // automatic replay from here.
      return { ok: true, message: attempt.message }
    }
    // "transient" (a retryable prompt failure, released for the next
    // attempt, OR — for ACP — a local write successfully submitted and
    // awaiting turn confirmation), "not_claimed" (a concurrent reconcile
    // pass or another answer() call already claimed it) and "cancelled"
    // (the run concluded in the gap) never fail the ANSWER call itself —
    // acceptance already succeeded durably; reconciliation resolves the
    // rest.
    return { ok: true, message: `Answer accepted for step "${run.stepId}" — delivery to the session is in progress.` }
  }

  /**
   * Claims and attempts one answer delivery — the shared worker
   * `Engine.answer` (immediate, low-latency path) and `reconcile()`
   * (restart/pause-resume/lease-expiry recovery path) both call. Returns
   * a discriminated outcome instead of throwing so both callers can
   * react without duplicating the classification logic.
   */
  private async attemptAnswerDelivery(deliveryId: string): Promise<AnswerDeliveryAttemptResult> {
    const { store, log, clock } = this.deps
    const pending = store.getAnswerDelivery(deliveryId)
    if (pending && store.getRunnerBinding(pending.runId)?.transport === "acp") {
      const operation = store.findOperation(pending.runId, "answer", pending.deliveryToken)
      if (operation) {
        if (operation.phase === "completed") store.confirmAnswerDelivered(deliveryId)
        else if (operation.phase === "unknown") await this.observeRunnerOperation(operation.id)
        return { kind: "not_claimed" }
      }
      const run = store.getRunById(pending.runId)
      if (!run || run.status !== "running") return { kind: "not_claimed" }
      let status: string = "unknown"
      try { status = run.sessionId ? await this.deps.acpSessions?.status(run.sessionId) ?? "unknown" : "unknown" } catch { /* conservative */ }
      if (status === "busy" || status === "retry") return { kind: "not_claimed" }
      if (status !== "idle") {
        await this.fenceOrFail(run.featureId, run.id, run.jobId, run.stepId, "lost_answer_response", "ACP answer ownership unknown")
        return { kind: "fenced", message: "ACP answer ownership unknown" }
      }
    }
    const claimed = store.claimAnswerDelivery(deliveryId, clock.now(), ANSWER_DELIVERY_LEASE_MS)
    if (!claimed) return { kind: "not_claimed" }

    const run = store.getRunById(claimed.runId)
    if (!run || run.status !== "running") {
      store.cancelAnswerDelivery(claimed.id, "run concluded before delivery could be attempted")
      return { kind: "cancelled" }
    }

    const sessionId = claimed.targetSessionId ?? run.sessionId
    const binding = store.getRunnerBinding(run.id)
    const isAcp = binding?.transport === "acp"
    const sessionClient = isAcp ? this.deps.acpSessions : this.deps.sessions
    if (!sessionClient) {
      // A wiring defect (ACP-bound run but no acpSessions dependency) —
      // treat the same as a lost session: fail the step honestly rather
      // than silently dropping the answer forever.
      const reason = `run ${run.id} is bound to acp transport but no ACP session client is configured`
      store.failAnswerDelivery(claimed.id, reason)
      await this.concludeAndDispatch(
        run.featureId, run.id, "failed",
        { reason, failure: makeFailureEnvelope({ class: "invalid_config", diagnostic: reason, source: "answer" }) },
        { kind: "step.failed", jobId: run.jobId, stepId: run.stepId, reason },
      )
      return { kind: "session_lost", message: `Delivering the answer failed — step "${run.stepId}" failed and normal failure routing applies.` }
    }
    const sessionAlive = sessionId !== null && (await sessionClient.status(sessionId)) !== "missing"
    if (!sessionAlive) {
      // ACP's "missing" never fires (D4: no receiver-side session
      // query) — this branch is reachable only for native. An ACP
      // session reporting "unknown" status intentionally does NOT reach
      // here; it is handled by the fence path below via a thrown
      // RunnerOperationError from prompt(), matching D6's "silence is
      // not interpreted as ... missing".
      const reason = `session ${sessionId ?? "(none)"} was lost while waiting for a human answer`
      store.failAnswerDelivery(claimed.id, reason)
      log.log(`answer ${claimed.runId}: ${reason} — failing the step`)
      await this.concludeAndDispatch(
        run.featureId, run.id, "failed",
        { reason, failure: makeFailureEnvelope({ class: "missing_session", diagnostic: reason, source: "answer" }) },
        { kind: "step.failed", jobId: run.jobId, stepId: run.stepId, reason },
      )
      return { kind: "session_lost", message: `The run's session is gone — step "${run.stepId}" failed and normal failure routing applies.` }
    }

    try {
      // Same as the nudge path: deliver the human answer as the STEP's
      // agent so the resumed turn keeps the step's system prompt instead
      // of falling back to the runner's default build agent.
      const answerState = store.getFeature(run.featureId)
      const answerSnapshot = answerState ? this.deps.workflows(answerState.projectDir) : undefined
      const answerStep = answerSnapshot ? findStep(answerSnapshot.workflow, run.jobId, run.stepId) : undefined
      const answerRole = answerStep?.type === "agent" ? answerSnapshot!.workflow.roles[answerStep.role] : undefined
      const promptResult = await sessionClient.prompt({
        sessionID: sessionId!,
        text:
          `[conductor] The human answered your question:\n\n${claimed.notes}\n\n` +
          `Treat the answers as binding decisions. Continue step "${run.stepId}" and report ` +
          `run_id="${run.id}" with the appropriate outcome when done (or ask again if a further decision is needed).\n\n` +
          `[conductor delivery ${claimed.deliveryToken}]`,
        ...(answerRole
          ? { agent: answerRole.agent, ...(answerRole.model !== undefined ? { model: answerRole.model } : {}) }
          : {}),
        ...(isAcp
          ? { operationId: deriveOperationLogicalKey("answer", { runId: run.id, deliveryToken: claimed.deliveryToken }), purpose: "answer" as const }
          : {}),
      })
      if (isAcp && promptResult) {
        // D5/D7: local write submitted, NOT yet confirmed delivered —
        // open but non-reclaimable. The matching turn's eventual
        // completion (observed elsewhere, e.g. a subsequent report or
        // reconcile pass) is what would confirm it; this path never
        // blocks on that.
        store.markAnswerDeliverySubmitted(claimed.id)
        return { kind: "transient", message: "answer submitted to ACP; awaiting turn completion" }
      }
    } catch (err) {
      if (isAcp && (!(err instanceof RunnerOperationError) || err.delivery === "unknown")) {
        // D6: uncertain ACP delivery fences the run — retains accepted
        // notes/question for audit, never replays, never fails the step.
        const result = store.fenceRunnerExecution(
          { runId: run.id, jobId: run.jobId, stepId: run.stepId, reasonCode: "lost_answer_response", diagnostic: err instanceof RunnerOperationError ? boundDiagnostic(err.diagnostic) : "ACP answer outcome unknown" },
          projectDir => this.deps.workflows(projectDir) ?? undefined,
        )
        if (!result.fenced) log.log(`answer ${claimed.runId}: fence request did not apply (${result.reason})`)
        else this.cleanupRunner(run.id)
        return { kind: "fenced", message: `The answer's delivery is uncertain — step "${run.stepId}" is fenced pending operator recovery.` }
      }
      const failureClass = classifyThrownBoundary(err)
      // Secret-safe diagnostics: a prompt-delivery exception's message
      // can embed a huge upstream error body carrying a credential —
      // bound/redact once here so the SAME text lands in `run.reason`,
      // the log line, the FailureEnvelope diagnostic, and (via
      // `store.failAnswerDelivery`'s own `boundDiagnostic` call, applied
      // again defense-in-depth) `answer_delivery.failure_detail`.
      const reason = boundDiagnostic(`failed to deliver the answer to session ${sessionId}: ${errorMessage(err)}`)
      // Transient weather (transport/capacity/upstream/timeout) keeps the
      // delivery pending for BOUNDED reconciliation rather than clearing
      // the question or failing the step — design.md risk: "Transient
      // infrastructure errors keep the delivery pending". Review fix:
      // bounded, not unconditional — the SAME class-default budget/
      // backoff a step's own transient retries use
      // (`behaviourForClass`/`computeScheduledDelayMs`/`checkRetryBudget`,
      // matching `deadline_at`'s fixed acceptance-time deadline) caps how
      // many attempts and how long this keeps retrying before it routes
      // through normal run failure exactly like every other terminal
      // delivery error. Everything else (deterministic/invalid/internal)
      // is a terminal prompt error and routes through normal run
      // conclusion immediately, unbudgeted.
      if (isTransientFailureClass(failureClass)) {
        const attempts = claimed.attemptCount + 1
        const behaviour = behaviourForClass(normalizeRetryPolicy(), failureClass)
        const now = clock.now()
        const schedule = computeScheduledDelayMs(behaviour.backoff, attempts, systemRandom)
        const candidateAtMs = now + schedule.delayMs
        const budget = checkRetryBudget({
          attempts,
          maxAttempts: behaviour.budget.maxAttempts,
          maxElapsedMs: behaviour.budget.maxElapsedMs,
          episodeStartedAtMs: claimed.createdAt,
          pausedMs: 0,
          candidateAttemptAtMs: candidateAtMs,
        })
        if (budget.ok) {
          store.scheduleAnswerDeliveryRetry(claimed.id, candidateAtMs)
          log.log(`answer ${claimed.runId}: ${reason} — transient, retry ${attempts} scheduled in ${schedule.delayMs}ms`)
          return { kind: "transient", message: reason }
        }
        const exhaustedReason = budget.exhaustedBy === "attempts"
          ? `${reason} — exhausted ${behaviour.budget.maxAttempts} delivery attempt(s)`
          : `${reason} — exceeded ${behaviour.budget.maxElapsedMs}ms elapsed delivery budget`
        store.failAnswerDelivery(claimed.id, exhaustedReason)
        log.log(`answer ${claimed.runId}: ${exhaustedReason} — failing the step`)
        await this.concludeAndDispatch(
          run.featureId, run.id, "failed",
          { reason: exhaustedReason, failure: makeFailureEnvelope({ class: failureClass, diagnostic: exhaustedReason, source: "answer" }) },
          { kind: "step.failed", jobId: run.jobId, stepId: run.stepId, reason: exhaustedReason },
        )
        return { kind: "session_lost", message: `Delivering the answer failed — step "${run.stepId}" failed and normal failure routing applies.` }
      }
      store.failAnswerDelivery(claimed.id, reason)
      log.log(`answer ${claimed.runId}: ${reason} — failing the step`)
      await this.concludeAndDispatch(
        run.featureId, run.id, "failed",
        { reason, failure: makeFailureEnvelope({ class: failureClass, diagnostic: reason, source: "answer" }) },
        { kind: "step.failed", jobId: run.jobId, stepId: run.stepId, reason },
      )
      return { kind: "session_lost", message: `Delivering the answer failed — step "${run.stepId}" failed and normal failure routing applies.` }
    }

    const confirmed = store.confirmAnswerDelivered(claimed.id)
    if (confirmed.kind === "not_claimed") {
      // The prompt already landed in the session (an at-least-once edge
      // — design.md: "Treat confirmation strength as a runner boundary"),
      // but the run concluded in the gap before this could be confirmed.
      // Cancel the record rather than leaving it claimed forever; there
      // is no live question left to clear.
      store.cancelAnswerDelivery(claimed.id, "run concluded before delivery could be confirmed")
      return { kind: "cancelled" }
    }
    if (confirmed.kind === "stale_superseded") {
      // `Store.confirmAnswerDelivered` already atomically cancelled this
      // delivery WITHOUT touching the run's newer question — nothing left
      // to do here but report it up.
      log.log(`answer ${claimed.runId}: delivery superseded by a newer question — cancelled without clearing it`)
      return { kind: "cancelled" }
    }
    this.idleCycles.delete(run.id)
    return { kind: "delivered" }
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

  // ------------------------------------------------------------ recovery

  /**
   * The API/CLI/web projection's read-only view of `recoveryCandidates`:
   * every currently recoverable job/step target for an escalated
   * feature, in the same order `recover()` would apply as the default
   * (no-target) choice. Null when the feature is not escalated or has no
   * resolvable workflow — recoverability is meaningless outside those.
   */
  recoverableTargets(featureId: string): readonly { readonly jobId: string; readonly stepId: string }[] | null {
    const { store } = this.deps
    const state = store.getFeature(featureId)
    if (!state || state.status !== "escalated") return null
    const snapshot = this.deps.workflows(state.projectDir)
    if (!snapshot) return null
    return this.recoveryCandidates(featureId, state, snapshot).map(({ jobId, stepId }) => ({ jobId, stepId }))
  }

  /**
   * A currently recoverable job/step, derived from the DURABLE frontier
   * (open resource waits, failed jobs' failed steps) — never from run
   * history alone (retry-budget spec: "Historical resource wait is not
   * the current failure"). `lastActivityAt` is history used ONLY to
   * order/present candidates (most recent first); it never decides
   * which candidate is selected.
   */
  private recoveryCandidates(
    featureId: string,
    state: FeatureState,
    snapshot: WorkflowSnapshot,
  ): Array<{ jobId: string; stepId: string; step: AgentStep | CommandStep | ActionStep; lastActivityAt: number }> {
    const { store } = this.deps
    const found = new Map<string, { jobId: string; stepId: string; step: AgentStep | CommandStep | ActionStep; lastActivityAt: number }>()
    const add = (jobId: string, stepId: string, lastActivityAt: number): void => {
      const key = `${jobId}\u0000${stepId}`
      if (found.has(key)) return
      const step = findStep(snapshot.workflow, jobId, stepId)
      if (!step || step.type === "human") return
      if (state.jobs[jobId]?.status === "succeeded") return
      if (store.getActiveRunForStep(featureId, jobId, stepId)) return
      found.set(key, { jobId, stepId, step, lastActivityAt })
    }

    for (const wait of store.listResourceWaits(featureId)) {
      if (wait.status === "closed") continue
      add(wait.jobId, wait.stepId, wait.updatedAt)
    }
    for (const [jobId, jobRuntime] of Object.entries(state.jobs)) {
      if (jobRuntime.status !== "failed") continue
      for (const [stepId, stepRuntime] of Object.entries(jobRuntime.steps)) {
        if (stepRuntime.status === "failed") {
          add(jobId, stepId, 0)
          continue
        }
        // Rerun-budget exhaustion: the routing step itself SUCCEEDED (its
        // run completed fine) but the job failed because its loop outcome
        // burned maxRounds. Re-arming the step — recoverStepTargets resets
        // the rerun counter alongside attempts — starts a fresh loop.
        if (stepRuntime.status === "succeeded" && (jobRuntime.reruns[stepId] ?? 0) > 0) add(jobId, stepId, 0)
      }
    }

    // The frontier is a durable projection of CURRENT job/step state, so
    // it is empty only for legacy/stranded escalations that predate this
    // projection (design.md: "Legacy stranded state is ambiguous — only
    // reconstruct when target is unique; otherwise escalate with
    // diagnostics instead of guessing"). Reconstruct from history ONLY
    // when it points at exactly one job/step — never offer a guessed
    // ambiguous set built from historical data alone.
    if (found.size === 0) {
      const legacy = new Map<string, { jobId: string; stepId: string; step: AgentStep | CommandStep | ActionStep; lastActivityAt: number }>()
      const addLegacy = (jobId: string, stepId: string, lastActivityAt: number): void => {
        const key = `${jobId}\u0000${stepId}`
        if (legacy.has(key)) return
        const step = findStep(snapshot.workflow, jobId, stepId)
        if (!step || step.type === "human") return
        if (state.jobs[jobId]?.status === "succeeded") return
        if (store.getActiveRunForStep(featureId, jobId, stepId)) return
        legacy.set(key, { jobId, stepId, step, lastActivityAt })
      }
      for (const wait of store.listResourceWaits(featureId)) {
        if (wait.status === "closed" && wait.closedReason === "deadline_exhausted") addLegacy(wait.jobId, wait.stepId, wait.updatedAt)
      }
      for (const run of store.listRuns(featureId)) {
        if (run.status === "failed" || run.status === "reaped") addLegacy(run.jobId, run.stepId, run.timeFinished ?? run.timeStarted)
      }
      if (legacy.size === 1) return [...legacy.values()]
      return []
    }

    return [...found.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  /**
   * Chains the target's latest retry episode (if any) into a fresh,
   * finite-budget episode via `store.recoverRetryEpisode` (retry-budget
   * spec: "the selected failed step receives a new finite budget…old
   * failure history remains in the timeline"). Immediately closed: the
   * attempt this recover dispatches happens directly (`executeAgent`/
   * `executeCommand`/`executeAction`), not via the reconciler's due-
   * schedule claim, so an OPEN episode row here would only block the
   * next durable retry schedule for this job/step behind the "one open
   * episode per target" uniqueness index. Best-effort: a missing prior
   * episode or a lost CAS race never blocks the recover itself — the
   * job-runtime attempt-counter reset in `recoverStepTargets` is the
   * budget reset that actually governs the interpreter's next decision.
   */
  private resetRetryEpisodeForRecover(featureId: string, jobId: string, stepId: string, step: AgentStep | CommandStep | ActionStep): void {
    const { store, clock } = this.deps
    const latest = store
      .listRetryEpisodes(featureId)
      .filter(episode => episode.jobId === jobId && episode.stepId === stepId)
      .at(-1)
    if (!latest) return
    const classBehaviour = behaviourForClass(normalizeRetryPolicy(), latest.lastFailure?.class ?? "internal")
    const stepRetry = step.retry.strategy === "backoff" ? step.retry : undefined
    const maxAttempts = stepRetry?.maxAttempts ?? classBehaviour.budget.maxAttempts
    // Recovery keeps the step's own elapsed deadline so a long step is not
    // reset to the (much smaller) class default on the operator's retry.
    const maxElapsedMs = (stepRetry?.maxElapsed !== undefined ? parseIsoDurationMs(stepRetry.maxElapsed) : undefined) ?? classBehaviour.budget.maxElapsedMs
    const recovered = store.recoverRetryEpisode(latest.id, latest.version, {
      startedAt: clock.now(),
      maxAttempts,
      maxElapsedMs,
    })
    if (recovered) store.closeRetryEpisode(recovered.id, "attempt_dispatched")
  }

  /**
   * Explicit operator recovery for an escalated feature: derives the
   * currently recoverable job/step target(s) from the durable frontier
   * (`recoveryCandidates`), requires a non-empty note, and re-arms the
   * SELECTED steps — never the whole workflow implicitly. A still-absent
   * runner re-enters a fresh resource wait (the upsert's uniqueness
   * keeps it to one open row per target); an available runner dispatches
   * one new run per recovered step.
   *
   * Selection takes exactly ONE form: `target` (one candidate,
   * back-compat), `targets` (an explicit non-empty subset), or
   * `all: true` (every current candidate — resolved server-side under
   * the same version check, so a stale view can never silently widen
   * the set). More than one form is rejected as invalid. Every
   * explicitly named target must be in the current candidate set; any
   * miss rejects the WHOLE request (`staleTarget`, no partial re-arm,
   * no fallback — retry-budget spec: "Selected recovery target became
   * stale"). Omitted selection with exactly one candidate recovers it
   * (backwards compatible); omitted with several is rejected
   * `ambiguous` listing them and offering the recover-all form
   * (retry-budget spec: "Parallel failures recover together or by
   * explicit selection"). All selected targets are re-armed in ONE
   * `recoverStepTargets` transaction — one idempotency key, one
   * version check, no observable partial re-arm.
   *
   * Optimistic concurrency (retry-policy 4.1): `expectedVersion` is the
   * feature's `updatedAt` the operator's view was rendered from — a
   * mismatch means the feature moved since (another operator recovered
   * it, a late report landed) and the stale recover is rejected instead
   * of double-arming. `idempotencyKey` dedupes retried deliveries of the
   * SAME logical recover (client retry after a network timeout): a key
   * already recorded on this feature returns success without re-arming.
   * These checks run here as a fast preflight AND, authoritatively,
   * inside `store.recoverStepTargets`'s own transaction — a race between
   * the preflight and the commit is caught there, not silently missed.
   */
  async recover(
    featureId: string,
    input: {
      readonly notes?: string
      readonly expectedVersion?: number
      readonly idempotencyKey?: string
      readonly target?: { readonly jobId: string; readonly stepId: string }
      readonly targets?: readonly { readonly jobId: string; readonly stepId: string }[]
      readonly all?: boolean
      readonly acknowledgeUncertain?: boolean
      readonly cleanupAttested?: boolean
    },
  ): Promise<{
    ok: boolean
    message: string
    readonly stale?: boolean
    readonly duplicate?: boolean
    readonly ambiguous?: boolean
    readonly staleTarget?: boolean
    readonly allowAll?: boolean
    readonly targets?: readonly { readonly jobId: string; readonly stepId: string }[]
    readonly recovered?: readonly { readonly jobId: string; readonly stepId: string }[]
  }> {
    const { store, log } = this.deps
    const selectionForms = [input.target !== undefined, input.targets !== undefined, input.all === true].filter(Boolean).length
    if (selectionForms > 1) {
      return { ok: false, message: 'pass exactly one of "target", "targets", or "all" — they cannot be combined' }
    }
    if (input.targets !== undefined && input.targets.length === 0) {
      return { ok: false, message: '"targets" must be a non-empty list — omit it to recover a single candidate' }
    }
    const record = store.getFeatureRecord(featureId)
    if (!record) return { ok: false, message: `unknown feature "${featureId}"` }
    const state = record.state
    if (input.idempotencyKey !== undefined && store.hasRecoverKey(featureId, input.idempotencyKey)) {
      return { ok: true, duplicate: true, message: "Already recovered (idempotency key seen) — no new work armed." }
    }
    if (state.status !== "escalated") {
      return { ok: false, message: `feature is not escalated (status: ${state.status}) — recover only applies to escalated features` }
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== record.updatedAt) {
      return {
        ok: false,
        stale: true,
        message: `feature changed since your view (version ${record.updatedAt} != expected ${input.expectedVersion}) — refresh and retry`,
      }
    }
    if (input.notes === undefined || input.notes.trim() === "") {
      return { ok: false, message: "recover requires a non-empty note" }
    }
    const snapshot = this.deps.workflows(state.projectDir)
    if (!snapshot) return { ok: false, message: `no valid workflow for ${state.projectDir}` }

    const candidates = this.recoveryCandidates(featureId, state, snapshot)
    if (candidates.length === 0) {
      return { ok: false, message: "no recoverable failed or blocked step found — nothing to recover" }
    }

    let selected: typeof candidates
    if (input.all === true) {
      selected = candidates
    } else if (input.targets !== undefined || input.target !== undefined) {
      const requested = input.targets ?? [input.target!]
      const matches: typeof candidates = []
      const misses: string[] = []
      for (const req of requested) {
        const match = candidates.find(candidate => candidate.jobId === req.jobId && candidate.stepId === req.stepId)
        if (match) {
          if (!matches.includes(match)) matches.push(match)
        } else {
          misses.push(`"${req.jobId}/${req.stepId}"`)
        }
      }
      if (misses.length > 0) {
        return {
          ok: false,
          staleTarget: true,
          message: `target(s) ${misses.join(", ")} are not currently recoverable (already resolved, active, or unknown) — nothing re-armed; refresh and select current targets`,
        }
      }
      selected = matches
    } else if (candidates.length > 1) {
      const targets = candidates.map(candidate => ({ jobId: candidate.jobId, stepId: candidate.stepId }))
      const list = targets.map(t => `"${t.jobId}/${t.stepId}"`).join(", ")
      return {
        ok: false,
        ambiguous: true,
        allowAll: true,
        targets,
        message: `multiple recoverable targets: ${list} — pass "target"/"targets" to select, or "all" to recover every one`,
      }
    } else {
      selected = [candidates[0]!]
    }

    // Repair the DAG state FIRST, atomically and authoritatively: recovered
    // jobs go back to running with their step as currentStep (the
    // interpreter's completion guard requires it), the recovered step's
    // attempt counter resets to 0 (a fresh finite budget), and
    // cascade-skipped jobs reset to pending so the cascade re-fires when
    // the recovered jobs conclude. Without this the recovered run's
    // conclusion is dropped as "stale" and the reconciler re-escalates on
    // its next pass. The idempotency key is recorded in the SAME
    // transaction — a client retry after this commit is a duplicate,
    // before it re-runs the whole recover. Dispatch happens ONLY when
    // this transaction actually won.
    const txResult = store.recoverStepTargets(
      featureId,
      selected.map(target => ({ jobId: target.jobId, stepId: target.stepId })),
      {
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        notes: input.notes ?? null,
        acknowledgeUncertain: input.acknowledgeUncertain,
        cleanupAttested: input.cleanupAttested,
      },
    )
    switch (txResult) {
      case "uncertainty_prerequisites":
        return { ok: false, message: "Uncertain execution requires acknowledgeUncertain, expectedVersion, idempotencyKey, notes and confirmed cleanup or cleanupAttested." }
      case "not_found":
        return { ok: false, message: `unknown feature "${featureId}"` }
      case "duplicate":
        return { ok: true, duplicate: true, message: "Already recovered (idempotency key seen) — no new work armed." }
      case "not_escalated":
        return { ok: false, message: "feature is not escalated — recover only applies to escalated features" }
      case "stale_version":
        return { ok: false, stale: true, message: "feature changed since your view — refresh and retry" }
      case "recovered":
        break
    }

    for (const target of selected) {
      this.resetRetryEpisodeForRecover(featureId, target.jobId, target.stepId, target.step)
    }

    for (const { jobId, stepId, step } of selected) {
      log.log(`feature=${state.slug} recover: re-arming ${step.type} step "${jobId}/${stepId}"`)
      if (step.type === "agent") await this.executeAgent(featureId, snapshot, jobId, step)
      else if (step.type === "command") await this.executeCommand(featureId, snapshot, jobId, step)
      else await this.executeAction(featureId, snapshot, jobId, step)
    }
    const recovered = selected.map(target => ({ jobId: target.jobId, stepId: target.stepId }))
    const list = recovered.map(t => `"${t.jobId}/${t.stepId}"`).join(", ")
    return { ok: true, recovered, message: `Recovered. Step${recovered.length > 1 ? "s" : ""} ${list} re-armed.` }
  }

  // ------------------------------------------------------------ lifecycle

  async pause(featureId: string): Promise<void> {
    await this.dispatch(featureId, { kind: "human.paused" })
    await this.fenceActiveRunners(featureId, true)
  }

  private async fenceActiveRunners(featureId: string, interruptedOnly = false): Promise<void> {
    for (const run of this.deps.store.listRuns(featureId)) {
      if (run.status === "running" && this.deps.store.getRunnerBinding(run.id)?.transport === "acp") {
        if (interruptedOnly && !this.deps.store.listRunnerOperations(run.id).some(operation =>
          operation.phase === "sending" || operation.phase === "submitted" || operation.phase === "unknown")) continue
        await this.fenceOrFail(featureId, run.id, run.jobId, run.stepId, "cancellation_during_uncertain_write", "ACP interrupted without authoritative report")
      }
    }
  }

  async resume(featureId: string): Promise<void> {
    if (this.deps.store.hasBlockingRunnerFence(featureId)) throw new Error("Uncertain execution requires cleanup-aware recover, not resume")
    await this.dispatch(featureId, { kind: "human.resumed" })
  }

  async abandon(featureId: string): Promise<void> {
    for (const run of this.commandRuns.values()) {
      if (run.featureId === featureId) run.controller.abort()
    }
    await this.fenceActiveRunners(featureId)
    await this.dispatch(featureId, { kind: "human.abandoned" })
  }

  // ------------------------------------------------------------ reconciler

  /**
   * One reconcile pass. Called on an interval by the daemon and after
   * startup recovery. Idempotent: every action is guarded by stored
   * state. Per-feature errors are isolated — one feature's failure never
   * blocks another's reconciliation.
   */
  /** Adapter callbacks may call this after journaling. Never trusts callback payloads. */
  async observeRunnerOperation(operationId: string): Promise<void> {
    const { store } = this.deps
    const operation = store.getOperation(operationId)
    if (!operation) return
    const run = store.getRunById(operation.runId)
    if (!run || run.status !== "running") return
    if (operation.phase === "unknown") {
      await this.fenceOrFail(run.featureId, run.id, run.jobId, run.stepId,
        acpFenceReasonCode(operation), describeUnknownOperation(operation), operation.id)
    } else if (operation.kind === "answer" && operation.phase === "completed") {
      const delivery = store.listAnswerDeliveries(run.featureId).find(d => d.runId === run.id && d.deliveryToken === operation.logicalKey)
      if (delivery) store.confirmAnswerDelivered(delivery.id)
    }
  }

  async reconcile(): Promise<void> {
    for (const feature of this.deps.store.listFeatures({ activeOnly: true })) {
      for (const run of this.deps.store.listRuns(feature.id)) {
        if (run.status !== "running" || this.deps.store.getRunnerBinding(run.id)?.transport !== "acp") continue
        for (const operation of this.deps.store.listRunnerOperations(run.id)) await this.observeRunnerOperation(operation.id)
        if ((this.deps.store.getRunnerBinding(run.id)?.daemonGeneration ?? 0) < (this.deps.daemonGeneration ?? 0)) {
          await this.fenceOrFail(feature.id, run.id, run.jobId, run.stepId, "startup_recovery", "ACP ownership lost across restart")
        }
      }
    }
    for (const operation of this.deps.store.listStaleGenerationOperations(this.deps.daemonGeneration ?? 0)) {
      if (operation.phase === "prepared") continue
      const run = this.deps.store.getRunById(operation.runId)
      if (!run || this.deps.store.getRunnerBinding(run.id)?.transport !== "acp") continue
      this.deps.store.fenceRunnerExecution({
        runId: run.id, jobId: run.jobId, stepId: run.stepId,
        reasonCode: "startup_recovery", operationId: operation.id,
        diagnostic: "ACP execution ownership lost across daemon restart",
      }, projectDir => this.deps.workflows(projectDir) ?? undefined)
    }
    try {
      await this.classifyPendingFences()
    } catch (err) {
      this.deps.log.log(`reconcile: fence classification failed: ${boundDiagnostic(errorMessage(err))}`)
    }
    const { store, log } = this.deps
    const features = store.listFeatures({ activeOnly: true })
    for (const feature of features) {
      try {
        await this.reconcileFeature(feature)
      } catch (err) {
        // Secret-safe diagnostics: an uncaught reconcile error could
        // originate from a runner/process boundary carrying a credential.
        log.log(`reconcile ${feature.slug}: ${boundDiagnostic(errorMessage(err))}`)
      }
    }
  }

  private async reconcileFeature(input: FeatureState): Promise<void> {
    const { store, log, clock } = this.deps
    // Fence notifications need no workflow; drain them even while the
    // operator is repairing an unavailable project configuration.
    let fenceAction = store.getPendingRunAction(input.id)
    while (fenceAction && store.getFence(fenceAction.runId) && fenceAction.decisions.every(d => d.kind === "escalate" || d.kind === "noop")) {
      for (const decision of fenceAction.decisions) {
        if (decision.kind === "escalate") this.deps.notify?.(`Conductor: escalation — ${input.slug}`, decision.reason)
      }
      store.markRunActionHandled(fenceAction.runId)
      fenceAction = store.getPendingRunAction(input.id)
    }
    const snapshot = this.deps.workflows(input.projectDir)
    if (!snapshot) return

    if (input.status === "paused") return

    for (const wait of store.listResourceWaits(input.id)) {
      if (wait.status !== "claimed") continue
      if (input.jobs[wait.jobId]?.currentStep !== wait.stepId) store.closeResourceWait(wait.id, "target_advanced")
      else store.releaseResourceWaitWithoutRun(wait.id)
    }
    const waits = store.listResourceWaits(input.id).filter(wait => wait.status === "waiting")
    for (const wait of waits) {
      if (wait.deadlineAt <= clock.now()) {
        const claimed = store.claimResourceWait(wait.id, clock.now())
        if (!claimed) continue
        store.closeResourceWait(wait.id, "deadline_exhausted")
        await this.dispatch(input.id, {
          kind: "step.failed",
          jobId: wait.jobId,
          stepId: wait.stepId,
          reason: `${wait.reason} deadline exhausted: ${wait.diagnostic ?? "required resource unavailable"}`,
        })
        continue
      }
      if (this.deps.runnerAvailable?.() === true || routeNewDispatch(this.deps.runners, input.projectDir, input.worktree ?? input.projectDir).transport === "acp") {
        const claimed = store.claimResourceWait(wait.id, clock.now())
        if (!claimed) continue
        const step = findStep(snapshot.workflow, wait.jobId, wait.stepId)
        if (!step || step.type !== "agent") {
          store.closeResourceWait(wait.id, "invalid_target")
          await this.dispatch(input.id, {
            kind: "step.failed",
            jobId: wait.jobId,
            stepId: wait.stepId,
            reason: `resource wait target "${wait.jobId}/${wait.stepId}" is no longer an agent step`,
          })
          continue
        }
        await this.executeAgent(input.id, snapshot, wait.jobId, step)
        if (store.getResourceWait(wait.id)?.status === "claimed") store.closeResourceWait(wait.id, "resource_available")
        continue
      }
      if (wait.nextObservationAt !== null && wait.nextObservationAt > clock.now()) continue
      // Runner still absent but an observation is due: advance the wait with
      // the core policy's bounded exponential backoff so the reconciler
      // isn't spinning on every tick, and record the observation.
      const now = clock.now()
      const observed = decideResourceWaitRoute(
        wait.reason,
        this.resourceWaitPolicy(),
        { firstObservedAtMs: wait.firstObservedAt, observationCount: wait.observationCount },
        now,
        systemRandom,
      )
      if (observed.kind === "escalate") continue
      store.upsertResourceWait({
        featureId: input.id,
        jobId: wait.jobId,
        stepId: wait.stepId,
        reason: wait.reason,
        observedAt: now,
        nextObservationAt: observed.nextObservationAtMs,
        deadlineAt: wait.deadlineAt,
        diagnostic: wait.diagnostic ?? undefined,
      })
    }

    // Due durable retries: claim and dispatch the scheduled step. The
    // claim is atomic (one winner), and actDecision's duplicate-run guard
    // prevents a second dispatch if the run already exists.
    //
    // Defensive elapsed-budget re-check at claim time (retry-budget spec:
    // "the workflow reaches its configured terminal route at the
    // deadline without one extra attempt"): `next_attempt_at` was inside
    // the deadline when scheduled, but a daemon outage spanning the due
    // time can leave `now()` past the elapsed deadline by the time this
    // claim runs. Escalate instead of dispatching one attempt too many.
    for (const episode of store.listDueRetryEpisodes(clock.now())) {
      const claimed = store.claimRetryEpisode(episode.id, clock.now())
      if (!claimed) continue
      const now = clock.now()
      // Same snapshot-delta computation as `planFailureDisposition` —
      // NOT `claimed.pausedMs` (the stale per-episode fold that misses
      // pause spans during an executing attempt). The feature cannot be
      // paused here (`listDueRetryEpisodes`/`claimRetryEpisode` both
      // exclude a paused feature's episodes), so there is no in-progress
      // span to worry about at this call site specifically — but reusing
      // the same helper keeps the two call sites' arithmetic identical.
      const featurePausedMsNow = store.getFeaturePausedMsAsOf(input.id, now) ?? claimed.featurePausedMsAtStart
      const pausedMs = Math.max(0, featurePausedMsNow - claimed.featurePausedMsAtStart)
      const elapsed = Math.max(0, now - claimed.startedAt - pausedMs)
      if (elapsed > claimed.maxElapsedMs) {
        store.closeRetryEpisode(episode.id, "elapsed_budget_exhausted_at_claim")
        log.log(`reconcile ${input.slug}: due retry "${episode.jobId}/${episode.stepId}" claimed past its elapsed deadline (${elapsed}ms > ${claimed.maxElapsedMs}ms) — escalating instead of dispatching`)
        await this.dispatch(input.id, {
          kind: "step.budget_exhausted",
          jobId: episode.jobId,
          stepId: episode.stepId,
          reason: `"${episode.jobId}/${episode.stepId}" exceeded ${claimed.maxElapsedMs}ms elapsed retry budget (${elapsed}ms elapsed) before the scheduled attempt could be claimed: ${claimed.lastFailure?.diagnostic ?? "no diagnostic"}`,
        })
        continue
      }
      store.closeRetryEpisode(episode.id, "attempt_dispatched")
      log.log(`reconcile ${input.slug}: dispatching due retry "${episode.jobId}/${episode.stepId}"`)
      await this.actDecision(input.id, snapshot, { kind: "execute_step", jobId: episode.jobId, stepId: episode.stepId })
    }

    await this.healDueTargets(input.id, snapshot)

    // Restart/pause-resume/lease-expiry recovery for accepted-but-
    // undelivered answers: `listPendingAnswerDeliveries` already excludes
    // paused features (the pause barrier), and `input.status === "paused"`
    // above returns before reaching here anyway. Every branch of
    // `attemptAnswerDelivery` is a durable state transition or a no-op —
    // nothing here needs a caller-facing result.
    for (const delivery of store.listPendingAnswerDeliveries(clock.now())) {
      log.log(`reconcile ${input.slug}: attempting due answer delivery for run ${delivery.runId}`)
      await this.attemptAnswerDelivery(delivery.id)
    }

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

    // Replay durable recovery-dispatch intent: `recoverStepTargets`
    // commits the DAG repair (feature → running, recovered step armed)
    // BEFORE `Engine.recover` dispatches the run/wait that anchors it —
    // a crash in that gap leaves a `running` feature with no anchor at
    // all. Replayed here, BEFORE the invariant check below, so a crash
    // right after `recoverStepTargets` never reaches the invariant as a
    // stranded feature. `actDecision` supplies the active-run guard
    // `executeAgent`/`executeCommand`/`executeAction` do NOT have
    // themselves — calling it (rather than the execute* methods
    // directly) makes replay safe to run again on every unhandled row
    // until a durable anchor exists. Dispatch, THEN mark handled — same
    // at-least-once discipline as the completion outbox: a second crash
    // mid-replay leaves the row for the next pass, and re-dispatching a
    // target that already has a run or wait is a guarded no-op.
    for (const dispatch of store.getUnhandledRecoveryDispatches(input.id)) {
      const hasActive = store.getActiveRunForStep(input.id, dispatch.jobId, dispatch.stepId) !== null
      const hasWait = store.getOpenResourceWait(input.id, dispatch.jobId, dispatch.stepId) !== null
      if (!hasActive && !hasWait) {
        log.log(`reconcile ${input.slug}: replaying recovery dispatch for "${dispatch.jobId}/${dispatch.stepId}" (crash between recover's DAG repair and its own dispatch)`)
        await this.actDecision(input.id, snapshot, { kind: "execute_step", jobId: dispatch.jobId, stepId: dispatch.stepId })
      }
      store.markRecoveryDispatchHandled(dispatch.id)
    }

    const feature = store.getFeature(input.id) ?? input
    if (feature.status === "done" || feature.status === "abandoned") return

    // Defensive: an escalated feature with an active run means recovery
    // succeeded but the status wasn't cleared (e.g. crash between
    // executeAgent and setFeatureFields). Transition to running.
    //
    // F2 guard: an unresolved runner fence (D6 uncertainty) MUST NOT be
    // silently reset by this defensive path. A parallel DAG can have one
    // job fenced (uncertain, escalated) while an UNRELATED sibling job's
    // run is still legitimately active (propagate never touched it) —
    // that sibling's active run must not be read as "recovery already
    // happened", or this would erase the escalated status the fence
    // depends on (recover()/recoverStepTargets require status ===
    // "escalated" to ever apply operator acknowledgment to the fenced
    // target). With the fence still unresolved, the feature stays
    // escalated: the per-job loop below still reconciles the sibling's
    // active run (it only checks jobRuntime.status, not feature.status),
    // so the sibling continues; the fenced job waits for an explicit
    // targeted `recover()` naming it, never an implicit whole-feature
    // reset.
    if (feature.status === "escalated" && store.getActiveRun(feature.id) !== null
      && !store.hasBlockingRunnerFence(feature.id)) {
      log.log(`reconcile ${feature.slug}: escalated but has active run — transitioning to running`)
      store.setFeatureStatus(feature.id, "running")
      return
    }

    const invariant = checkActiveStateInvariant(feature, {
      hasActiveRun: store.getActiveRun(feature.id) !== null,
      hasDueRetry: store.listRetryEpisodes(feature.id).some(episode => episode.status === "scheduled"),
      hasResourceWait: store.listResourceWaits(feature.id).some(wait => wait.status === "waiting"),
      // The recovery-dispatch outbox above replays before this check
      // runs, but its own dispatch can still leave a row unhandled here
      // (e.g. the process crashed again mid-replay) — treated as the
      // SAME kind of anchor the completion outbox already is, so the
      // feature is not escalated out from under a recovery still in flight.
      hasUnhandledOutboxDecision: store.getPendingRunAction(feature.id) !== null
        || store.getUnhandledRecoveryDispatches(feature.id).length > 0,
      hasPreparingTarget: this.isPreparingAnyTargetFor(feature.id),
      hasPendingFence: store.hasPendingFence(feature.id),
    })
    if (invariant.kind === "stranded_legacy_failure" || invariant.kind === "stranded_no_anchor") {
      log.log(`reconcile ${feature.slug}: ${invariant.reason} — marking escalated`)
      store.markEscalated(feature.id, invariant.reason)
      return
    }

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

      // A step awaiting a resource or a durable retry is deliberately
      // run-less: the wait/retry loops above own it, and re-executing here
      // would bypass the schedule entirely.
      if (store.getOpenResourceWait(feature.id, jobId, stepId) ?? store.getOpenRetryEpisode(feature.id, jobId, stepId)) continue
      if (store.hasPendingFence(feature.id, jobId, stepId)) continue

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
        if (clock.now() - Math.max(active.timeLastActivity, active.timeStarted) > this.runTtlMs) {
          await this.reconcileTtl(feature, snapshot, active, false)
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
        await this.reconcileTtl(feature, snapshot, active, false)
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
    active: RunSummary,
  ): Promise<void> {
    const { log, store } = this.deps
    const binding = store.getRunnerBinding(active.id)
    const isAcp = binding?.transport === "acp"
    const sessionClient = isAcp ? this.deps.acpSessions : this.deps.sessions
    if (isAcp) {
      const unknown = store.listRunnerOperations(active.id).find(operation => operation.phase === "unknown")
      if (unknown) {
        await this.fenceOrFail(feature.id, active.id, active.jobId, active.stepId,
          acpFenceReasonCode(unknown), describeUnknownOperation(unknown), unknown.id)
        return
      }
    }

    // Waiting for a human answer is not being stuck: no idle nudging, no
    // idle reaping. The TTL below still bounds an abandoned question —
    // fenced (never reaped-as-retryable) for ACP, since a pending
    // question means a prompt may already be in flight to answer it.
    if (active.pendingQuestion != null) {
      this.idleCycles.delete(active.id)
      // A pause/resume cycle rewrites feature.status to `running` without
      // knowing about the pending question — re-park so the answering
      // surfaces reappear instead of the question silently aging out.
      if (feature.status === "running") {
        this.deps.store.setRunQuestion(active.id, active.pendingQuestion)
      }
      await this.reconcileTtl(feature, snapshot, active, isAcp)
      return
    }
    if (active.sessionId && sessionClient) {
      const status = await sessionClient.status(active.sessionId)
      // D4/D6: "unknown" is distinct from idle or missing — it SHALL NOT
      // trigger speculative nudges or missing-session failure. Only the
      // TTL bound below may act on it, and for ACP that action is a
      // fence, never a reap-as-retryable.
      if (status === "missing") {
        if (isAcp) {
          // ACP has no receiver-side session query (D4) — a
          // implementation reporting "missing" anyway is treated
          // exactly as conservatively as "unknown": TTL-bounded fence
          // only, never an immediate reap (which would look like proof
          // of no effects).
          await this.reconcileTtl(feature, snapshot, active, true)
          return
        }
        log.log(`reconcile ${feature.slug}: run ${active.id} session is gone — reaping immediately`)
        this.idleCycles.delete(active.id)
        await this.reap(feature, active, "session disappeared before reporting", "missing_session")
        return
      }
      const limits = this.runLimits(snapshot, active)
      const silence = this.deps.clock.now() - Math.max(active.timeLastActivity, active.timeStarted)
      if (silence > limits.ttlMs) {
        await this.reconcileTtl(feature, snapshot, active, isAcp)
        return
      }
      if (status === "unknown") {
        // Never nudge, never reap on missing information — the TTL
        // check above (and the next pass's) is the ONLY thing that can
        // act on a persistently unknown observation, and it fences.
        this.idleCycles.delete(active.id)
        return
      }
      if (status === "busy" || status === "retry") {
        this.idleCycles.delete(active.id)
        if (isAcp) {
          // D6: "For healthy ACP busy turns, do not enqueue native-style
          // busy nudges: only one prompt may be in flight." No nudge
          // path at all for ACP busy — TTL is the only bound.
          return
        }
        if (limits.ttlMs <= limits.busySilenceNudgeMs) {
          await this.reconcileTtl(feature, snapshot, active, false)
          return
        }
        if (silence > limits.busySilenceNudgeMs) {
          if (active.nudges < limits.maxNudges) {
            await this.nudgeAgentRun(feature, snapshot, active, limits.maxNudges)
          } else {
            await this.reap(feature, active, `${status} without activity after ${active.nudges} nudge(s)`)
          }
          return
        }
      } else {
        // status === "idle". For ACP this only follows an observed
        // end_turn with no report — D6: "end_turn without report
        // records idle and allows an explicitly journaled idle nudge
        // only while the same live connection still proves the turn
        // ended." Exhaustion still fences for ACP rather than reaping.
        //
        // Mirrors the busy/retry branch's early skip just above: when the
        // TTL is at or below the idle threshold, TTL always wins first
        // (identical to `silence > limits.ttlMs` firing before idle ever
        // gets a chance) — idle nudging is structurally dead for this
        // run/step. Skip straight to the TTL path WITHOUT touching
        // `idleCycles`: incrementing (and never clearing, since the
        // threshold this debounce exists for can never be reached) would
        // grow the map by one entry per reconcile cycle for the run's
        // entire lifetime — a slow, unbounded leak for any workflow using
        // a short `ttlMs` alongside the default idle threshold.
        if (limits.ttlMs <= limits.idleSilenceNudgeMs) {
          this.idleCycles.delete(active.id)
          await this.reconcileTtl(feature, snapshot, active, isAcp)
          return
        }
        const cycles = (this.idleCycles.get(active.id) ?? 0) + 1
        this.idleCycles.set(active.id, cycles)
        if (cycles >= this.nudgeIdleCycles && silence > limits.idleSilenceNudgeMs) {
          this.idleCycles.delete(active.id)
          if (active.nudges < limits.maxNudges) {
            await this.nudgeAgentRun(feature, snapshot, active, limits.maxNudges)
            return
          }
          if (isAcp) {
            log.log(`reconcile ${feature.slug}: run ${active.id} idle after ${limits.maxNudges} ACP nudge(s) — fencing (no-report timeout)`)
            await this.fenceOrFail(feature.id, active.id, active.jobId, active.stepId, "no_report_timeout", this.noReportReason(active.id, `idle without report after ${active.nudges} ACP nudge(s)`))
            return
          }
          log.log(`reconcile ${feature.slug}: run ${active.id} idle after ${limits.maxNudges} nudges — reaping`)
          await this.reap(feature, active, this.noReportReason(active.id, `idle without report after ${active.nudges} nudge(s)`))
          return
        }
      }
    }
    await this.reconcileTtl(feature, snapshot, active, isAcp)
  }

  private runLimits(snapshot: WorkflowSnapshot, active: { jobId: string; stepId: string }) {
    const candidate = findStep(snapshot.workflow, active.jobId, active.stepId)
    const step = candidate?.type === "agent" ? candidate : undefined
    return {
      ttlMs: step?.ttlMs ?? this.runTtlMs,
      idleSilenceNudgeMs: step?.idleSilenceNudgeMs ?? this.idleSilenceNudgeMs,
      busySilenceNudgeMs: step?.busySilenceNudgeMs ?? this.busySilenceNudgeMs,
      maxNudges: step?.maxNudges ?? this.maxNudges,
    }
  }

  /** Reports the daemon refused for this run (count + most recent message). */
  private reportRejections(runId: string): { count: number; last: string } | undefined {
    let count = 0
    let last = ""
    let afterSeq = 0
    for (;;) {
      const page = this.deps.store.getRunLog(runId, { afterSeq })
      for (const line of page.lines) {
        if (line.source !== "step" || !line.text.startsWith(REPORT_REJECTED_PREFIX)) continue
        count++
        last = line.text.slice(REPORT_REJECTED_PREFIX.length)
      }
      if (!page.truncated) return count > 0 ? { count, last } : undefined
      afterSeq = page.nextSeq
    }
  }

  /** An agent that kept getting 400s is not "idle" — name the real cause. */
  private noReportReason(runId: string, fallback: string): string {
    const rejections = this.reportRejections(runId)
    if (rejections === undefined) return fallback
    return boundDiagnostic(`${fallback}; ${rejections.count} report(s) rejected, last: ${rejections.last}`)
  }

  private async nudgeAgentRun(feature: FeatureState, snapshot: WorkflowSnapshot, active: RunSummary, maxNudges: number): Promise<void> {
    if (!active.sessionId) return
    const isAcp = this.deps.store.getRunnerBinding(active.id)?.transport === "acp"
    const sessionClient = isAcp ? this.deps.acpSessions : this.deps.sessions
    if (!sessionClient) return
    const nudgeNo = this.deps.store.incrementNudges(active.id)
    this.deps.log.log(`reconcile ${feature.slug}: run ${active.id} without report — nudge ${nudgeNo}/${maxNudges}`)
    const step = findStep(snapshot.workflow, active.jobId, active.stepId)
    const role = step?.type === "agent" ? snapshot.workflow.roles[step.role] : undefined
    const rejection = this.reportRejections(active.id)?.last
    try {
      await sessionClient.prompt({
        sessionID: active.sessionId,
        text: rejection !== undefined
          ? `[conductor] No report has been accepted for step "${active.stepId}" yet. Your last report was rejected: ` +
            `${rejection}\nThe tool is working; the payload was invalid. Fix exactly that field and call the report ` +
            `tool again for run_id="${active.id}". A report written as chat text is lost — the step only concludes ` +
            `when the report tool succeeds.`
          : `[conductor] Your previous turn appears to have been interrupted (no report received). ` +
            `The work state is in your context. Finish step "${active.stepId}" and report ` +
            `run_id="${active.id}" with the appropriate outcome.`,
        ...(role ? { agent: role.agent, ...(role.model !== undefined ? { model: role.model } : {}) } : {}),
        ...(isAcp
          ? { operationId: deriveOperationLogicalKey("nudge", { runId: active.id, nudgeOrdinal: nudgeNo }), purpose: "nudge" as const }
          : {}),
      })
    } catch (err) {
      if (isAcp && (!(err instanceof RunnerOperationError) || err.delivery === "unknown")) {
        // D6: an uncertain nudge delivery is exactly the same durable
        // uncertainty as a lost prompt — fence, never treat the failed
        // nudge as proof of anything, never keep silently retrying.
        await this.fenceOrFail(feature.id, active.id, active.jobId, active.stepId, "lost_prompt_response", `ACP nudge delivery uncertain: ${err instanceof RunnerOperationError ? err.diagnostic : "unknown boundary failure"}`)
        return
      }
      this.deps.log.log(`nudge failed: ${boundDiagnostic(errorMessage(err))}`)
    }
  }

  /**
   * TTL measures SILENCE, not age: the clock anchors on the run's last
   * observed activity (log appends, question flow, nudges — dispatch as
   * the floor), so a run that demonstrably makes progress is never
   * reaped by wall-clock while a run gone dark is. An agent step's own
   * `ttlMs` overrides the engine default for its runs.
   *
   * For an ACP-bound run (`isAcp: true`), TTL exhaustion NEVER reaps as
   * a retryable failure (D6: "Exhaustion/TTL without report fences
   * rather than automatic retry" — potentially-executed work with no
   * authoritative report cannot be proven safe to replace).
   */
  private async reconcileTtl(
    feature: FeatureState,
    snapshot: WorkflowSnapshot,
    active: { id: string; jobId: string; stepId: string; sessionId?: string | null; timeStarted: number; timeLastActivity?: number },
    isAcp: boolean,
  ): Promise<void> {
    const { ttlMs } = this.runLimits(snapshot, active)
    const lastActivity = Math.max(active.timeLastActivity ?? active.timeStarted, active.timeStarted)
    const silence = this.deps.clock.now() - lastActivity
    if (silence > ttlMs) {
      this.idleCycles.delete(active.id)
      if (isAcp) {
        this.deps.log.log(`reconcile ${feature.slug}: run ${active.id} (step ${active.stepId}) exceeded TTL — fencing (no-report timeout)`)
        await this.fenceOrFail(feature.id, active.id, active.jobId, active.stepId, "no_report_timeout", `ACP run exceeded ${Math.round(silence / 60000)} min without a report`)
        return
      }
      this.deps.log.log(`reconcile ${feature.slug}: run ${active.id} (step ${active.stepId}) exceeded TTL — reaping`)
      await this.reap(feature, active, `run reaped after ${Math.round(silence / 60000)} min without activity`)
    }
  }

  private async reap(
    feature: FeatureState,
    active: { id: string; jobId: string; stepId: string; sessionId?: string | null },
    reason: string,
    failureClass: FailureClass = "timeout",
  ): Promise<void> {
    // Abort BEFORE concluding: if the daemon dies in between, reconcile
    // re-reaps the still-active run; conclude-first would leave the
    // session an orphan burning tokens against a closed run — exactly
    // the failure this exists to prevent. Best-effort by contract: a
    // runner that cannot abort must never block the conclusion.
    this.commandRuns.get(active.id)?.controller.abort()
    if (active.sessionId) {
      try {
        await this.deps.sessions.abort(active.sessionId)
      } catch (err) {
        this.deps.log.log(`session abort failed for run ${active.id}: ${boundDiagnostic(errorMessage(err))}`)
      }
    }
    await this.concludeAndDispatch(
      feature.id,
      active.id,
      "reaped",
      { reason, failure: makeFailureEnvelope({ class: failureClass, diagnostic: reason, source: "reaper" }) },
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

/** Nonsecret digest of the resolved ACP profile config — D5:
 *  "runner_binding: ... config_digest (nonsecret)". Never includes env
 *  values (only their key names) so a rotated secret does not change
 *  the digest and no credential can leak through it. */
function acpConfigDigest(profile: import("./acp/config.ts").AcpProfileConfig): string {
  const shape = {
    command: profile.command,
    args: profile.args,
    allowedRoots: profile.allowedRoots,
    envKeys: Object.keys(profile.env ?? {}).sort(),
    inheritEnv: profile.inheritEnv ?? [],
    maxConcurrent: profile.maxConcurrent,
    bindings: Object.keys(profile.bindings).sort(),
  }
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex")
}

/**
 * Coarse execution-boundary classification for command/action/prompt
 * failures — pattern-matching on transport-level symptoms only (exit
 * codes and error shapes the engine itself produced), NEVER on an
 * agent's or tool's human diagnostic prose. Anything unrecognized is
 * `deterministic_failure` for process exits (a failing build stays
 * failed) and `internal` for thrown boundaries.
 */
function classifyProcessExit(code: number): FailureClass {
  if (code === 124 || code === 137) return "timeout"
  if (code === 127) return "invalid_config"
  return "deterministic_failure"
}

function classifyThrownBoundary(error: unknown): FailureClass {
  const message = errorMessage(error)
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network|unable to connect|connectionrefused|connection closed|connection error/i.test(message)) return "transient_transport"
  if (/429|rate limit|overloaded|capacity/i.test(message)) return "capacity"
  if (/502|503|504|bad gateway|service unavailable|gateway timeout/i.test(message)) return "transient_upstream"
  if (/timeout|timed out/i.test(message)) return "timeout"
  return "internal"
}

/**
 * Maps an unknown-phase `RunnerOperation`'s durable `diagnosticCode`
 * (D5 `runner_operation.diagnostic_code`, set by `ManagedSessions`'
 * `markUnknown`) to the SPECIFIC `RunnerFenceReasonCode` it actually
 * represents, rather than collapsing every unknown-outcome cause into
 * the generic `lost_prompt_response`/`lost_answer_response` pair. Purely
 * descriptive/audit — review fix: `turn_deadline_exceeded` and
 * `lost_create_response` existed as reason-code union members but were
 * never actually produced by any call site; every unknown observation
 * silently reported the wrong specific reason. Falls back to the
 * pre-existing generic mapping when no code is present (e.g. an
 * operation observed unknown for a reason this adapter never recorded
 * a code for, or a future adapter that never sets one at all).
 */
function acpFenceReasonCode(operation: Pick<RunnerOperationRecord, "kind" | "diagnosticCode">): RunnerFenceReasonCode {
  switch (operation.diagnosticCode) {
    case "create_response_lost": return "lost_create_response"
    case "turn_deadline_exceeded": return "turn_deadline_exceeded"
    case "write_timeout":
    case "response_lost":
      return operation.kind === "answer" ? "lost_answer_response" : "lost_prompt_response"
    default:
      return operation.kind === "answer" ? "lost_answer_response" : "lost_prompt_response"
  }
}

function describeUnknownOperation(operation: Pick<RunnerOperationRecord, "kind" | "diagnosticCode" | "diagnostic">): string {
  const code = operation.diagnosticCode ? ` [${operation.diagnosticCode}]` : ""
  const detail = operation.diagnostic ? `: ${operation.diagnostic}` : ""
  return `ACP ${operation.kind} outcome unknown${code}${detail}`
}

/** A `RunnerOperationError` with an explicit `failureClass` (e.g. an
 *  unsupported/unadvertised ACP mode or model selection — a
 *  configuration defect, not weather) is ALWAYS a more reliable
 *  classification than `classifyThrownBoundary`'s message-text
 *  heuristic, which would otherwise fall through to "internal" (a
 *  budgeted, RETRYABLE class) for a defect that can never succeed on
 *  retry. Only consulted for `delivery: "not_sent"` errors — the
 *  caller has already routed `delivery: "unknown"` to fenceOrFail
 *  before reaching this classification. */
function acpFailureClass(error: unknown): FailureClass {
  if (error instanceof RunnerOperationError && error.failureClass !== undefined) return error.failureClass
  return classifyThrownBoundary(error)
}

/** Transient weather classes keep an answer delivery pending for bounded
 *  reconciliation instead of terminally failing the step — the same
 *  transient/terminal split retry-policy's class-default budgets encode. */
function isTransientFailureClass(failureClass: FailureClass): boolean {
  return failureClass === "transient_upstream" || failureClass === "transient_transport"
    || failureClass === "capacity" || failureClass === "timeout"
}
