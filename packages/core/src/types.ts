/**
 * Pipeline definitions — the data model of opencode-conductor.
 *
 * The engine ships NO hardcoded pipeline. A pipeline is data: an ordered
 * list of steps loaded from config (project `.opencode/conductor.json`,
 * merged over the global config, optionally extending a shipped preset).
 *
 * Three step types:
 *  - `builtin`  — deterministic actions implemented in the plugin (git/PR
 *                 mechanics). No LLM involved, fully repeatable.
 *  - `command`  — arbitrary project shell command (quality gate, codegen).
 *                 No LLM involved. Outcome = exit code + captured output.
 *  - `agent`    — spawns/wakes an opencode session under a configured role
 *                 (agent + model). The only step type that touches an LLM.
 */

/** Where a step can send the flow after it finishes. */
export interface OnFail {
  /** Step id to jump to on failure (e.g. a fixer step). */
  readonly goto?: string
  /** Max failures of THIS step before the feature escalates (default 1). */
  readonly max_attempts?: number
  /** Escalate immediately on failure (overrides goto). */
  readonly escalate?: boolean
}

/** Verdict routing for agent steps that produce a review-like outcome. */
export interface OnVerdict {
  readonly [verdict: string]: { readonly goto?: string; readonly next?: boolean }
}

interface StepBase {
  /** Unique step id within the pipeline. */
  readonly id: string
  /** Skippable per-feature via `skipStates` or feature-level overrides. */
  readonly optional?: boolean
  /** Explicit next step id. Defaults to the next step in the list. */
  readonly then?: string
  /** Failure routing. */
  readonly on_fail?: OnFail
  /**
   * Pause before executing this step until a human approves via the
   * dashboard or the conductor_approve tool (e.g. merge).
   */
  readonly requires_human?: boolean
  /**
   * Where to send the flow when a human REJECTS at a requires_human gate
   * (dashboard "request changes" or the conductor_request_changes tool).
   * The human's notes are stored as this step's output, so the target
   * step's prompt can reference {{steps.<gate-id>.output}}.
   * Without on_reject, a rejection escalates.
   */
  readonly on_reject?: { readonly goto: string }
}

/** Deterministic built-in actions. Implemented in src/steps/builtins/. */
export type BuiltinAction =
  | "worktree.create"
  | "worktree.remove"
  | "git.push"
  | "pr.create"
  | "pr.await_checks"
  | "pr.merge"
  | "threads.check_resolved"
  | "findings.sync"
  | "findings.check"

export interface BuiltinStep extends StepBase {
  readonly type: "builtin"
  readonly action: BuiltinAction
  /** Action-specific parameters; values support {{template}} rendering. */
  readonly params?: Readonly<Record<string, string>>
}

export interface CommandStep extends StepBase {
  readonly type: "command"
  /** Shell commands run sequentially; first non-zero exit fails the step. */
  readonly run: readonly string[]
  /** Working directory (template-rendered). Defaults to feature worktree. */
  readonly cwd?: string
  /** Per-command timeout in ms (default 30 min). */
  readonly timeout_ms?: number
}

/**
 * How a review step's findings are projected onto the PR after the agent
 * reports. The conductor-side output ({{steps.<id>.output}}) is ALWAYS the
 * source of truth for downstream steps — publishing is a human-facing
 * projection and never blocks the pipeline.
 */
export interface PublishDef {
  /**
   * - "github-review": one atomic POST /pulls/<pr>/reviews call — verdict
   *   (APPROVE / REQUEST_CHANGES), body, and inline comments together.
   * - "comment-only": a plain PR comment carrying the findings; no formal
   *   review verdict (for repos where the bot must not gate merges).
   * - "none": conductor-internal only (e.g. pre-push internal review).
   */
  readonly mode: "github-review" | "comment-only" | "none"
  /**
   * Shell command printing a short-lived token to stdout (e.g. a GitHub
   * App installation token minter). The publish call runs with GH_TOKEN
   * set to its output, so the review lands under the bot identity.
   * Omitted → the default gh identity. Falls back to
   * config.reviewPublish.tokenCommand when unset here.
   */
  readonly tokenCommand?: string
}

export interface AgentStep extends StepBase {
  readonly type: "agent"
  /** Role key — resolved to { agent, model } via the `roles` config map. */
  readonly role: string
  /** Prompt template with {{feature.*}} / {{steps.<id>.*}} variables. */
  readonly prompt?: string
  /** Verdict routing (reviews). Verdict is reported via conductor_report. */
  readonly on_verdict?: OnVerdict
  /** Publish the reported findings to the PR (reviews). Default: none. */
  readonly publish?: PublishDef
  /**
   * Review-loop shorthand: this step and the named fix step alternate;
   * each pass through this step counts as one round.
   */
  readonly rounds_with?: string
  /** Max rounds for a rounds_with loop before escalation (default 3). */
  readonly max_rounds?: number
}

export type StepDef = BuiltinStep | CommandStep | AgentStep

/** Role → concrete opencode agent + model. */
export interface RoleDef {
  readonly agent: string
  readonly model?: string
  /** Optional model variant (reasoning effort etc.). */
  readonly variant?: string
  /**
   * Session isolation for steps run under this role.
   * - "fresh" (default): each step run gets a new child session under the
   *   feature's parent session — clean context, subagent-style. Reviews stay
   *   independent, implementation context never leaks into them.
   * - "feature": prompt the feature's long-lived session directly — context
   *   carries across steps. Use only when continuity is deliberately wanted.
   */
  readonly session?: "fresh" | "feature"
}

export interface PipelineDef {
  readonly pipeline: readonly StepDef[]
  readonly roles: Readonly<Record<string, RoleDef>>
}

/** Full per-project conductor configuration. */
export interface ConductorConfig extends PipelineDef {
  /**
   * Named alternative pipelines (e.g. "bugfix", "hotfix"). `pipeline` is
   * the default workflow; a feature started with workflow "x" runs
   * workflows["x"] instead. Roles are shared across all workflows.
   * Each entry may inline a step list or extend a preset by name.
   */
  readonly workflows?: Readonly<Record<string, {
    readonly extends?: string
    readonly pipeline?: readonly StepDef[]
  }>>
  /** `owner/repo` for gh operations. */
  readonly repo?: string
  readonly baseBranch?: string
  /**
   * Directory for feature worktrees. Absolute, or relative to the project
   * dir; "{project}" expands to the project basename. Default ".." keeps
   * the historical layout: ../<project>-<slug>. Any other value places
   * worktrees INSIDE it as <worktreeDir>/<slug>
   * (e.g. "../gloam-worktrees/{project}" → ../gloam-worktrees/gloam-idle/<slug>).
   */
  readonly worktreeDir?: string
  /**
   * Project-wide defaults for review publishing; per-step `publish`
   * fields win. Lets a project set tokenCommand once.
   */
  readonly reviewPublish?: Partial<PublishDef>
  /** Preset to extend: "conductor:<name>" or a path. */
  readonly extends?: string
  /** Step ids skipped for every feature in this project. */
  readonly skipSteps?: readonly string[]
  /** Reconciler poll interval. */
  readonly pollIntervalMs?: number
  /** TTL after which a running step with no observed effect is reaped. */
  readonly runTtlMs?: number
  /**
   * Consecutive reconcile cycles an agent run's session must be idle
   * (without reporting) before it is considered a dead turn. Default 2.
   */
  readonly nudgeIdleCycles?: number
  /**
   * Max "finish your step and report" nudges per run before it is reaped.
   * 0 disables idle-nudging entirely. Default 2.
   */
  readonly maxNudges?: number
  readonly dashboardPort?: number
  /** Dashboard bind address. Default 127.0.0.1; set "0.0.0.0" to expose on the LAN. */
  readonly dashboardHost?: string
  /** Optional notification webhook (ntfy-style POST). */
  readonly notify?: { readonly url?: string }
}

// ---------------------------------------------------------------------------
// Runtime state (persisted in SQLite, mirrored here as plain types)
// ---------------------------------------------------------------------------

export type FeatureStatus =
  | "running"      // engine may act on it
  | "paused"       // human paused via dashboard/tool
  | "waiting_human"// requires_human step reached, awaiting approval
  | "escalated"    // attempt/round budget exhausted — needs a human
  | "done"
  | "abandoned"

export interface FeatureState {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly projectDir: string
  /** Workflow name this feature runs under; null = the default pipeline. */
  readonly workflow: string | null
  /** Full feature description — the spec handed to intake/design steps; null = title-only. */
  readonly description: string | null
  readonly status: FeatureStatus
  /** Current step id, or null before the first step starts. */
  readonly currentStep: string | null
  /** Latest known session id of the feature's orchestrator session. */
  readonly sessionId: string | null
  readonly worktree: string | null
  readonly branch: string | null
  readonly pr: number | null
  /** attempts[stepId] = failures observed for that step. */
  readonly attempts: Readonly<Record<string, number>>
  /** rounds[stepId] = completed review rounds for a rounds_with step. */
  readonly rounds: Readonly<Record<string, number>>
}

/** Events fed to the interpreter — everything that can advance a feature. */
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

/** What the engine should do next — the interpreter's only output. */
export type Decision =
  | { readonly kind: "execute"; readonly stepId: string }
  | { readonly kind: "wait_human"; readonly stepId: string }
  | { readonly kind: "escalate"; readonly reason: string }
  | { readonly kind: "finish" }
  | { readonly kind: "pause" }
  | { readonly kind: "abandon" }
  | { readonly kind: "noop"; readonly reason: string }

/** Interpreter result: decision + state patch to persist atomically. */
export interface Transition {
  readonly decision: Decision
  readonly patch: Partial<{
    status: FeatureStatus
    currentStep: string | null
    attempts: Readonly<Record<string, number>>
    rounds: Readonly<Record<string, number>>
  }>
}
