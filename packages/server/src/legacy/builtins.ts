/**
 * Built-in deterministic actions. Zero LLM involvement — plain code,
 * fully repeatable, testable with a fake `LegacyGh` + fake
 * `ProcessRunner`. Ported from opencode-conductor's
 * `src/steps/builtins.ts`; two behavioural changes from the seed:
 *  - git/shell execution crosses the injected `ProcessRunner` port
 *    instead of a module-global `runShell` — builtins never call a
 *    global shell function.
 *  - git subcommands run as argv via `ProcessRunner.exec` (no shell
 *    interpolation), and branch/base refs are validated with
 *    `git check-ref-format` before they ever reach an argv position —
 *    `ctx.feature.branch`/`ctx.params.branch`/`ctx.config.baseBranch`
 *    are config/DB-controlled, not literal shell text.
 *
 * Every builtin returns a `LegacyStepOutcome`; the engine converts it into
 * a pipeline event (step.succeeded / step.failed) and feeds the
 * interpreter. `pending` means "not finished yet — check again next
 * reconcile cycle" (used by pr.await_checks): the step stays running
 * without burning an attempt.
 */

import path from "node:path"
import type { LegacyFeatureState } from "../store.ts"
import type { LegacyGh, LegacyStorePort, ProcessRunner } from "./ports.ts"
import type { LegacyConfig } from "./types.ts"

/**
 * Validate a git ref (branch name) via `git check-ref-format
 * --allow-onelevel`, run through the injected `ProcessRunner` — never a
 * regex reimplementation of git's own ref grammar. Rejects anything that
 * could be mistaken for an option (leading `-`) or is otherwise not a
 * well-formed one-level ref, before it is ever placed in argv.
 */
async function validateRef(process: ProcessRunner, cwd: string, ref: string): Promise<string | null> {
  if (ref.length === 0 || ref.startsWith("-")) return `ref "${ref}" is empty or option-like`
  const result = await process.exec(["git", "check-ref-format", "--allow-onelevel", ref], { cwd })
  return result.code === 0 ? null : `ref "${ref}" is not a valid git ref`
}

/**
 * Resolve the worktree path for a feature and confirm it stays under the
 * configured worktree root — a feature slug is DB-controlled, not
 * necessarily trustworthy input, and must never be able to walk the
 * computed path outside the directory worktrees are supposed to live in.
 */
function resolveWorktreePath(feature: LegacyFeatureState, config: LegacyConfig): { path: string; root: string } | { error: string } {
  const template = config.worktreeDir ?? ".."
  const root = path.resolve(feature.projectDir, template.replace("{project}", path.basename(feature.projectDir)))
  const worktreePath = path.join(
    root,
    template === ".." ? `${path.basename(feature.projectDir)}-${feature.slug}` : feature.slug,
  )
  const relative = path.relative(root, worktreePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { error: `resolved worktree path "${worktreePath}" escapes worktree root "${root}"` }
  }
  return { path: worktreePath, root }
}

export type LegacyStepOutcome =
  | { readonly kind: "succeeded"; readonly output?: string }
  | { readonly kind: "failed"; readonly reason: string; readonly output?: string }
  | { readonly kind: "pending" }

export interface LegacyBuiltinContext {
  readonly feature: LegacyFeatureState
  /** Id of the pipeline step this builtin runs as (attempt-counter key). */
  readonly stepId: string
  readonly config: LegacyConfig
  readonly store: LegacyStorePort
  readonly gh: LegacyGh
  readonly process: ProcessRunner
  readonly params: Readonly<Record<string, string>>
}

type LegacyBuiltinFn = (ctx: LegacyBuiltinContext) => Promise<LegacyStepOutcome>

export const legacyBuiltins: Record<string, LegacyBuiltinFn> = {
  "worktree.create": async ctx => {
    const branch = ctx.params.branch ?? `feat/${ctx.feature.slug}`
    const base = ctx.config.baseBranch
    const branchInvalid = await validateRef(ctx.process, ctx.feature.projectDir, branch)
    if (branchInvalid) return { kind: "failed", reason: branchInvalid }
    const baseInvalid = await validateRef(ctx.process, ctx.feature.projectDir, base)
    if (baseInvalid) return { kind: "failed", reason: baseInvalid }

    // Where worktrees live: config.worktreeDir (absolute, or relative to
    // the project dir; {project} placeholder = project basename) — default
    // is the historical sibling-of-project layout. The resolved path must
    // stay under the resolved worktree root — a feature slug is
    // DB-controlled and must never walk the path outside it.
    const resolved = resolveWorktreePath(ctx.feature, ctx.config)
    if ("error" in resolved) return { kind: "failed", reason: resolved.error }
    const worktreePath = resolved.path

    // Branch from origin/<base>, not from the local clone's HEAD: the local
    // base branch is never fast-forwarded by the pipeline (merges happen on
    // GitHub via gh), so HEAD goes stale and every feature born from it
    // starts life in conflict. origin/<base> is what PRs actually merge
    // into. The local base branch is left untouched — nothing to discard,
    // no human decision needed.
    const fetch = await ctx.process.exec(["git", "fetch", "origin", base], {
      cwd: ctx.feature.projectDir,
      timeoutMs: 120_000,
    })
    const startPoint = fetch.code === 0 ? [`origin/${base}`] : []
    const notes: string[] = []
    if (fetch.code !== 0) {
      notes.push(`warning: git fetch failed (offline?) — branching from local HEAD instead of origin/${base}`)
    } else {
      // Divergence heads-up: local base != origin/base means someone has
      // local-only work there. It is NOT included (push it to origin if it
      // should be) — surface the fact instead of silently building on it.
      const localRef = await ctx.process.exec(["git", "rev-parse", "--quiet", "--verify", "--end-of-options", base], { cwd: ctx.feature.projectDir })
      const remoteRef = await ctx.process.exec(["git", "rev-parse", "--quiet", "--verify", "--end-of-options", `origin/${base}`], { cwd: ctx.feature.projectDir })
      if (localRef.code === 0 && remoteRef.code === 0 && localRef.stdout.trim() !== remoteRef.stdout.trim()) {
        notes.push(`note: local ${base} differs from origin/${base} — the feature branches from origin/${base}; local-only commits are not included`)
      }
    }
    const result = await ctx.process.exec(
      ["git", "worktree", "add", worktreePath, "-b", branch, "--", ...startPoint],
      { cwd: ctx.feature.projectDir },
    )
    if (result.code !== 0) {
      // Worktree may already exist from a previous attempt — treat an
      // existing checkout of the same branch as success (idempotency).
      const existing = await ctx.process.exec(["git", "worktree", "list", "--porcelain"], { cwd: ctx.feature.projectDir })
      if (existing.stdout.includes(worktreePath)) {
        ctx.store.setFeatureFields(ctx.feature.id, { worktree: worktreePath, branch })
        return { kind: "succeeded", output: `reusing existing worktree ${worktreePath}` }
      }
      return { kind: "failed", reason: `git worktree add exited ${result.code}`, output: result.output }
    }
    ctx.store.setFeatureFields(ctx.feature.id, { worktree: worktreePath, branch })
    return { kind: "succeeded", output: [worktreePath, ...notes].join("\n") }
  },

  "worktree.remove": async ctx => {
    const notes: string[] = []
    if (ctx.feature.worktree) {
      const result = await ctx.process.exec(
        ["git", "worktree", "remove", "--force", "--", ctx.feature.worktree],
        { cwd: ctx.feature.projectDir },
      )
      if (result.code !== 0) {
        return { kind: "failed", reason: `git worktree remove exited ${result.code}`, output: result.output }
      }
      ctx.store.setFeatureFields(ctx.feature.id, { worktree: null })
      notes.push(`removed worktree ${ctx.feature.worktree}`)
    } else {
      notes.push("no worktree to remove")
    }
    // Optional branch cleanup (params.delete_branch === "true"): local +
    // remote, both best-effort — the branch may already be gone (GitHub
    // auto-delete on merge, manual cleanup, previous attempt).
    if (ctx.params.delete_branch === "true" && ctx.feature.branch) {
      const branch = ctx.feature.branch
      const branchInvalid = await validateRef(ctx.process, ctx.feature.projectDir, branch)
      if (branchInvalid) return { kind: "failed", reason: branchInvalid }
      const local = await ctx.process.exec(["git", "branch", "-D", "--", branch], { cwd: ctx.feature.projectDir })
      notes.push(local.code === 0 ? `deleted local branch ${branch}` : `local branch ${branch} already gone`)
      const remote = await ctx.process.exec(["git", "push", "origin", "--delete", "--", branch], { cwd: ctx.feature.projectDir })
      notes.push(remote.code === 0 ? `deleted remote branch ${branch}` : `remote branch ${branch} already gone`)
    }
    return { kind: "succeeded", output: notes.join("; ") }
  },

  "git.push": async ctx => {
    const cwd = ctx.feature.worktree ?? ctx.feature.projectDir
    const branch = ctx.feature.branch
    if (!branch) return { kind: "failed", reason: "feature has no branch to push" }
    const branchInvalid = await validateRef(ctx.process, cwd, branch)
    if (branchInvalid) return { kind: "failed", reason: branchInvalid }
    const result = await ctx.process.exec(["git", "push", "-u", "origin", "--", branch], { cwd })
    if (result.code !== 0) {
      return { kind: "failed", reason: `git push exited ${result.code}`, output: result.output }
    }
    return { kind: "succeeded" }
  },

  "pr.create": async ctx => {
    const repo = ctx.config.repo
    if (!repo) return { kind: "failed", reason: "config.repo is not set" }
    if (!ctx.feature.branch) return { kind: "failed", reason: "feature has no branch" }
    const cwd = ctx.feature.worktree ?? ctx.feature.projectDir
    const title = ctx.params.title ?? ctx.feature.title
    const body = ctx.params.body ?? `Automated PR for: ${ctx.feature.title}\n\nDriven by conductor.`
    try {
      const pr = await ctx.gh.prCreate(repo, { title, body, base: ctx.config.baseBranch, head: ctx.feature.branch, cwd })
      ctx.store.setFeatureFields(ctx.feature.id, { pr })
      return { kind: "succeeded", output: `PR #${pr}` }
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) }
    }
  },

  "pr.await_checks": async ctx => {
    const repo = ctx.config.repo
    if (!repo) return { kind: "failed", reason: "config.repo is not set" }
    if (ctx.feature.pr === null) return { kind: "failed", reason: "feature has no PR" }
    try {
      const view = await ctx.gh.prView(repo, ctx.feature.pr)
      if (view.state === "MERGED") return { kind: "succeeded", output: "already merged" }
      if (view.state === "CLOSED") return { kind: "failed", reason: "PR was closed" }

      // A conflicting branch never gets CI: GitHub skips the merge-commit
      // workflow entirely, checks stay empty, and "pending" would poll
      // forever (observed deadlock). Fail loudly instead — on_fail routing
      // sends a fixer to rebase. UNKNOWN means GitHub is still computing
      // mergeability: that IS a pending state.
      if (view.mergeable === "CONFLICTING") {
        return {
          kind: "failed",
          reason: "branch has merge conflicts with the base branch",
          output:
            `PR #${ctx.feature.pr} is CONFLICTING with ${ctx.config.baseBranch} — CI will not run until this is resolved. ` +
            `Rebase the branch onto ${ctx.config.baseBranch} (git fetch origin && git rebase origin/${ctx.config.baseBranch}), ` +
            `resolve conflicts, and force-push with --force-with-lease.`,
        }
      }

      // Track head SHA; supersede stale heads on push-during-review.
      ctx.store.supersedeOldHeads(ctx.feature.pr, view.headSha)
      const known = ctx.store.getPrHead(ctx.feature.pr, view.headSha)
      if (!known) {
        ctx.store.upsertPrHead(ctx.feature.id, ctx.feature.pr, view.headSha, "awaiting_ci")
      }

      const checks = await ctx.gh.prChecks(repo, ctx.feature.pr)
      if (!checks.allConcluded) return { kind: "pending" }
      if (checks.anyFailed) {
        ctx.store.upsertPrHead(ctx.feature.id, ctx.feature.pr, view.headSha, "ci_failed")
        return { kind: "failed", reason: "CI failed", output: checks.failedNames.join(", ") }
      }
      ctx.store.upsertPrHead(ctx.feature.id, ctx.feature.pr, view.headSha, "ci_green")
      return { kind: "succeeded", output: view.headSha }
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) }
    }
  },

  /**
   * Project finding state (DB = source of truth) onto GitHub threads:
   *  1. map unmapped findings to threads via the [F<n>] marker embedded in
   *     each published inline comment
   *  2. for findings marked fixed/dismissed and not yet synced: reply with
   *     the fixer's resolution note and resolve the thread
   * Deterministic, no LLM. Failures on individual threads degrade to a
   * warning — sync retries next round (synced flag stays 0).
   */
  "findings.sync": async ctx => {
    const repo = ctx.config.repo
    if (!repo) return { kind: "failed", reason: "config.repo is not set" }
    if (ctx.feature.pr === null) return { kind: "succeeded", output: "no PR — nothing to sync" }
    try {
      const findings = ctx.store.listFindings(ctx.feature.id)
      if (findings.length === 0) return { kind: "succeeded", output: "no findings recorded" }

      // Map DB findings ↔ GitHub threads via the id marker.
      const threads = await ctx.gh.unresolvedThreads(repo, ctx.feature.pr)
      for (const thread of threads) {
        const marker = /`(F\d+)`/.exec(thread.firstCommentBody)
        if (!marker?.[1]) continue
        const finding = findings.find(f => f.id === marker[1] && f.threadId === null)
        if (finding) ctx.store.setFindingThread(ctx.feature.id, finding.id, thread.id)
      }

      const fresh = ctx.store.listFindings(ctx.feature.id)
      const synced: string[] = []
      const warnings: string[] = []
      for (const f of fresh) {
        if (f.synced || f.threadId === null) continue
        if (f.status !== "fixed" && f.status !== "dismissed") continue
        try {
          const note = f.resolution ?? (f.status === "fixed" ? "Fixed." : "Dismissed.")
          await ctx.gh.replyToThread(f.threadId, `**${f.id} ${f.status}** — ${note}`)
          await ctx.gh.resolveThread(f.threadId)
          ctx.store.markFindingSynced(ctx.feature.id, f.id)
          synced.push(`${f.id}(${f.status})`)
        } catch (err) {
          warnings.push(`${f.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const parts = [
        synced.length > 0 ? `synced: ${synced.join(", ")}` : "nothing to sync",
        ...(warnings.length > 0 ? [`warnings: ${warnings.join("; ")}`] : []),
      ]
      return { kind: "succeeded", output: parts.join("\n") }
    } catch (err) {
      // Sync is a projection — never block the pipeline on it.
      return { kind: "succeeded", output: `sync skipped: ${err instanceof Error ? err.message : String(err)}` }
    }
  },

  /**
   * The merge-readiness gate over the DB (not GitHub).
   *
   * Two regimes, switched by how many times THIS step has failed:
   *  - polish rounds (attempts < params.polish, default 1): ANY open
   *    finding fails the gate — every finding gets at least one fixer
   *    round (fix or dismiss with justification), so approved-with-nits
   *    does not merge with silently ignored comments.
   *  - after polish: only new/reopened findings in params.block_severities
   *    (default blocker,major) block. Leftover minor/nit stay tracked in
   *    the DB but cannot spin the loop (fresh round-2 nits don't recycle).
   */
  "findings.check": async ctx => {
    const blockList = (ctx.params.block_severities ?? "blocker,major")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
    const polish = Number.parseInt(ctx.params.polish ?? "1", 10)
    const attempts = ctx.feature.attempts[ctx.stepId] ?? 0
    const inPolish = attempts < polish

    // Optional scoping: only findings raised by the named review step(s)
    // count. Lets one pipeline run several independent findings loops
    // (design review vs code review) without cross-blocking.
    const stepFilter = (ctx.params.steps ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)

    const findings = ctx.store.listFindings(ctx.feature.id)
      .filter(f => stepFilter.length === 0 || stepFilter.includes(f.stepId))
    const open = findings.filter(f => f.status === "new" || f.status === "reopened")
    const blocking = inPolish ? open : open.filter(f => blockList.includes(f.severity))

    if (blocking.length > 0) {
      const lines = blocking.map(f => `${f.id} [${f.severity}] ${f.path}:${f.line} (${f.status}) — ${f.body.slice(0, 120)}`)
      return {
        kind: "failed",
        reason: inPolish
          ? `polish round: ${blocking.length} open finding(s) need a fix-or-dismiss pass`
          : `${blocking.length} unresolved ${blockList.join("/")} finding(s)`,
        output: lines.join("\n"),
      }
    }
    return {
      kind: "succeeded",
      output: open.length > 0
        ? `no blocking findings (${open.length} open ${open.map(f => f.severity).join(", ")} tracked in DB)`
        : "all findings resolved",
    }
  },

  "threads.check_resolved": async ctx => {
    const repo = ctx.config.repo
    if (!repo) return { kind: "failed", reason: "config.repo is not set" }
    if (ctx.feature.pr === null) return { kind: "failed", reason: "feature has no PR" }
    try {
      const threads = await ctx.gh.unresolvedThreads(repo, ctx.feature.pr)
      if (threads.length === 0) return { kind: "succeeded" }

      // Auto-resolve threads the PR side has answered: replying is the
      // fixer's job, RESOLVING is mechanics (params.auto_resolve="false"
      // opts out). Heuristic: the thread is addressed when the LAST voice
      // is not the reviewer who opened it; when the reviewer spoke last,
      // the ball is back in our court and the thread stays open. The
      // merit backstop is the review loop itself — after fix_review the
      // flow re-enters external_review on the new SHA, so a dismissive
      // reply still gets re-judged by the reviewer.
      const autoResolve = ctx.params.auto_resolve !== "false"
      const stillOpen: string[] = []
      const resolvedNow: string[] = []
      for (const thread of threads) {
        const status = ctx.store.upsertThread({
          threadId: thread.id,
          featureId: ctx.feature.id,
          pr: ctx.feature.pr,
          path: thread.path,
          openedBy: thread.openedBy,
          lastReplyBy: thread.lastReplyBy,
          lastReply: thread.lastReplyBody,
        })
        const answered = thread.lastReplyBy !== "" && thread.lastReplyBy !== thread.openedBy
        // "reopened" = we auto-resolved it before and it is unresolved
        // again (human reopened / reviewer followed up). Never re-resolve
        // those automatically — a human explicitly disagreed.
        if (autoResolve && answered && status !== "reopened") {
          try {
            await ctx.gh.resolveThread(thread.id)
            ctx.store.markThreadResolved(thread.id)
            resolvedNow.push(`${thread.path} (answered by ${thread.lastReplyBy})`)
            continue
          } catch {
            // fall through — counts as still open
          }
        }
        stillOpen.push(`${thread.path}: last comment by ${thread.lastReplyBy || "?"}${status === "reopened" ? " [reopened]" : ""}`)
      }

      const resolvedNote = resolvedNow.length > 0 ? `auto-resolved ${resolvedNow.length} answered thread(s)\n` : ""
      if (stillOpen.length > 0) {
        return {
          kind: "failed",
          reason: `${stillOpen.length} unresolved review thread(s)`,
          output: `${resolvedNote}Still open:\n${stillOpen.join("\n")}`,
        }
      }
      return { kind: "succeeded", output: resolvedNote.trim() }
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) }
    }
  },

  "pr.merge": async ctx => {
    const repo = ctx.config.repo
    if (!repo) return { kind: "failed", reason: "config.repo is not set" }
    if (ctx.feature.pr === null) return { kind: "failed", reason: "feature has no PR" }
    try {
      const view = await ctx.gh.prView(repo, ctx.feature.pr)
      if (view.state === "MERGED") return { kind: "succeeded", output: "already merged" }
      await ctx.gh.prMerge(repo, ctx.feature.pr)
      return { kind: "succeeded", output: `merged PR #${ctx.feature.pr}` }
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) }
    }
  },
}
