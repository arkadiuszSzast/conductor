/**
 * Pipeline definitions — the seed's (opencode-conductor) data model.
 *
 * This is DELIBERATELY separate from `@conductor/core`'s workflow IR
 * (`WorkflowDef`/`JobDef`/graph steps). The seed's runtime state is a
 * single explicit `current_step` string with `attempts`/`rounds` maps —
 * not the new graph model — and this module must not be conflated with
 * it. It exists so `@conductor/server` can host the seed-compatible
 * pipeline engine over the existing SQLite schema (see `../store.ts`)
 * while the graph engine is built out separately (workflow-format tasks).
 *
 * Three step types, no LLM in two of them:
 *  - `builtin`  — deterministic actions (git/PR mechanics), no LLM.
 *  - `command`  — arbitrary project shell command, no LLM.
 *  - `agent`    — spawns/wakes a runner session under a configured role.
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
  /** Skippable per-feature via `skipSteps` or feature-level overrides. */
  readonly optional?: boolean
  /** Explicit next step id. Defaults to the next step in the list. */
  readonly then?: string
  /** Failure routing. */
  readonly on_fail?: OnFail
  /**
   * Pause before executing this step until a human approves via
   * `Engine.approve`/`requestChanges`.
   */
  readonly requires_human?: boolean
  /**
   * Where to send the flow when a human REJECTS at a requires_human gate.
   * The human's notes are stored as this step's output, so the target
   * step's prompt can reference {{steps.<gate-id>.output}}.
   * Without on_reject, a rejection escalates.
   */
  readonly on_reject?: { readonly goto: string }
}

/** Deterministic built-in actions. Implemented in `builtins.ts`. */
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
  /**
   * Shell commands run sequentially; first non-zero exit fails the step.
   * Rendered with raw string substitution (no shell-escaping) and passed
   * straight to `bash -lc` — this is the one step type that legitimately
   * renders a shell string.
   *
   * WARNING: the template context includes text that is NOT purely
   * project-config-controlled — `{{human.<step>}}` (free-text human gate
   * notes), `{{steps.<id>.output}}` (agent-reported text, itself capable
   * of echoing untrusted repo/PR content via prompt injection), and
   * `{{findings.*}}` (finding bodies extracted from a PR diff/comment).
   * Interpolating any of these into shell syntax here (e.g.
   * `echo "{{steps.review.output}}" | some-tool`) lets a crafted finding
   * body, human note, or agent note become command injection. Do not
   * interpolate untrusted values into shell syntax in `run:`; prefer a
   * deterministic `builtin` argv action, or pass the value via env var /
   * file rather than inline shell text.
   */
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
   * - "github-review": one atomic review call — verdict (APPROVE /
   *   REQUEST_CHANGES), body, and inline comments together.
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
  /** Verdict routing (reviews). Verdict is reported via the report port. */
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

/** Role → concrete runner agent + model. */
export interface RoleDef {
  readonly agent: string
  readonly model?: string
  /** Optional model variant (reasoning effort etc.). */
  readonly variant?: string
  /**
   * Session isolation for steps run under this role.
   * - "fresh" (default): each step run gets a new child session under the
   *   feature's parent session — clean context, subagent-style.
   * - "feature": prompt the feature's long-lived session directly —
   *   context carries across steps. Use only when continuity is wanted.
   */
  readonly session?: "fresh" | "feature"
}

export interface PipelineDef {
  readonly pipeline: readonly StepDef[]
  readonly roles: Readonly<Record<string, RoleDef>>
}

/**
 * Fully-resolved per-project configuration the engine runs under.
 * Loading/merging config files is the daemon's job (config registry,
 * standalone-daemon-extraction task 3) — this is the shape the engine
 * consumes, injected via `ConfigResolver`.
 */
export interface EngineConfig extends PipelineDef {
  /** Named alternative pipelines; `pipeline` is the default workflow. */
  readonly workflows?: Readonly<Record<string, {
    readonly extends?: string
    readonly pipeline?: readonly StepDef[]
  }>>
  /** Named workflows resolved to concrete step lists (extends applied). */
  readonly resolvedWorkflows: Readonly<Record<string, readonly StepDef[]>>
  /** `owner/repo` for GitHub operations. */
  readonly repo?: string
  readonly baseBranch: string
  /**
   * Directory for feature worktrees. Absolute, or relative to the project
   * dir; "{project}" expands to the project basename. Default ".." keeps
   * the historical layout: ../<project>-<slug>.
   */
  readonly worktreeDir?: string
  /** Project-wide defaults for review publishing; per-step wins. */
  readonly reviewPublish?: Partial<PublishDef>
  /** Step ids skipped for every feature in this project. */
  readonly skipSteps?: readonly string[]
  /** TTL after which a running step with no observed effect is reaped. */
  readonly runTtlMs: number
  /**
   * Consecutive reconcile cycles an agent run's session must be idle
   * (without reporting) before it is considered a dead turn.
   */
  readonly nudgeIdleCycles: number
  /** Max "finish your step and report" nudges per run before it is reaped. */
  readonly maxNudges: number
}

/**
 * The step list a feature runs under: its named workflow, or the default
 * pipeline. Unknown workflow name → null (caller escalates, never guesses).
 */
export function pipelineForWorkflow(
  config: EngineConfig,
  workflow: string | null,
): readonly StepDef[] | null {
  if (workflow === null) return config.pipeline
  return config.resolvedWorkflows[workflow] ?? null
}
