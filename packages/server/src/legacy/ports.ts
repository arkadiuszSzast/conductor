/**
 * Explicit dependency interfaces for the legacy compatibility engine.
 *
 * Nothing in `legacy/` reaches for an opencode SDK import, a process-wide
 * global, `Date.now()`, `process.cwd()`, or a hardcoded model gateway —
 * every side effect the engine or its builtins need crosses one of these
 * ports, injected by the caller (daemon wiring or tests). This is what
 * lets the legacy engine be tested with fakes and later re-hosted behind
 * a real daemon without touching engine/builtin code.
 */

import type { LegacyDecision, LegacyFeatureState, LegacyPipelineEvent, LegacyTransition } from "../store.ts"
import type { LegacyConfig } from "./types.ts"

// --------------------------------------------------------------- clock

/** Recovers `Date.now()` as an injectable port — deterministic in tests. */
export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

// -------------------------------------------------------------- logger

export interface Logger {
  log(message: string): void
}

// ------------------------------------------------------------ process

export interface ProcessExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /**
   * stdout and stderr chronologically interleaved as the child emitted
   * them, matching the seed's `runShell` (a single capture buffer).
   * Command-step and git-builtin failure output must preserve arrival
   * order — concatenating `stdout` then `stderr` would silently reorder
   * interleaved output and lose fidelity with the seed's observed
   * behaviour.
   */
  readonly output: string
}

export interface ProcessExecOptions {
  readonly cwd: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  /** Piped to the child's stdin, then closed. Avoids shell heredoc construction for untrusted content. */
  readonly stdin?: string
}

/**
 * Runtime-neutral process/filesystem/git execution effect. Builtins and
 * the GitHub client run every external command through this port —
 * never a global `runShell`, never a bare `spawn`, never `process.cwd()`
 * as an implicit default.
 */
export interface ProcessRunner {
  exec(command: readonly string[], options: ProcessExecOptions): Promise<ProcessExecResult>
  /** Run a shell command line (bash -lc) — used by `command` pipeline steps. */
  shell(command: string, options: ProcessExecOptions): Promise<ProcessExecResult>
}

// ------------------------------------------------------------ sessions

/**
 * Minimal, runtime-agnostic surface the legacy engine needs from an
 * agent runner. No opencode SDK types leak through this port — runners
 * (opencode today, others later) implement it against their own client.
 */
export interface LegacySessionClient {
  createSession(input: { title: string; directory: string; parentID?: string }): Promise<{ id: string }>
  prompt(input: {
    sessionID: string
    text: string
    agent?: string
    model?: string
  }): Promise<void>
  sessionExists(sessionID: string): Promise<boolean>
  /**
   * Live status of a session. "retry" (provider retrying) is reported
   * distinctly but treated like busy by callers. "missing" = the session
   * is gone (server restart / deleted).
   */
  status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing">
  /**
   * Append an informational message to a session WITHOUT triggering
   * inference (noReply). Used to keep the feature's parent session a
   * readable timeline of what each step/agent did.
   */
  note(input: { sessionID: string; text: string }): Promise<void>
}

// ----------------------------------------------------------------- gh

export interface LegacyCheckSummary {
  readonly allConcluded: boolean
  readonly anyFailed: boolean
  readonly failedNames: readonly string[]
}

export interface LegacyReviewThread {
  /** GraphQL node id — the handle for resolveReviewThread. */
  readonly id: string
  /** Login of the FIRST comment's author (the reviewer who opened it). */
  readonly openedBy: string
  /** Body of the FIRST comment (carries the [F<n>] finding marker). */
  readonly firstCommentBody: string
  /** Login of the LAST comment's author. */
  readonly lastReplyBy: string
  /** Body of the last comment (for the audit trail). */
  readonly lastReplyBody: string
  readonly path: string
}

export interface LegacyPrView {
  readonly number: number
  readonly headSha: string
  readonly state: "OPEN" | "MERGED" | "CLOSED"
  readonly mergeable: string
}

/**
 * GitHub operations behind an injected interface. `RealGh` (`gh.ts`)
 * implements it over an injected `ProcessRunner` — no bare `spawn`, no
 * `process.cwd()` fallback.
 */
export interface LegacyGh {
  prChecks(repo: string, pr: number): Promise<LegacyCheckSummary>
  prView(repo: string, pr: number): Promise<LegacyPrView>
  prCreate(repo: string, opts: {
    title: string
    body: string
    base: string
    head: string
    cwd: string
  }): Promise<number>
  prMerge(repo: string, pr: number): Promise<void>
  unresolvedThreadCount(repo: string, pr: number): Promise<number>
  /** Unresolved review threads with enough detail to decide auto-resolution. */
  unresolvedThreads(repo: string, pr: number): Promise<readonly LegacyReviewThread[]>
  /** Resolve a review thread (GraphQL resolveReviewThread mutation). */
  resolveThread(threadId: string): Promise<void>
  /** Reply inside a review thread (before resolving it). */
  replyToThread(threadId: string, body: string): Promise<void>
  /** Comments + reviews on a PR authored after a given time (effect check). */
  reviewActivitySince(repo: string, pr: number, sinceMs: number): Promise<number>
  /**
   * Post a plain PR comment. `token` overrides the ambient GitHub identity
   * for this call only (bot-identity publishing) — never embedded in a
   * shell string, passed as an env var to the underlying process.
   */
  postComment(repo: string, pr: number, body: string, opts: { cwd: string; token?: string }): Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * Post an atomic PR review (verdict + body + inline comments) via the
   * REST reviews endpoint. Returns the raw failure text on error so
   * callers can apply the seed's degrade-and-retry heuristics.
   */
  postReview(repo: string, pr: number, payload: LegacyReviewPayload, opts: { cwd: string; token?: string }): Promise<{ ok: true } | { ok: false; error: string }>
}

export interface LegacyReviewComment {
  readonly path: string
  readonly line: number
  readonly side: "LEFT" | "RIGHT"
  readonly body: string
}

export interface LegacyReviewPayload {
  readonly event: string
  readonly body: string
  readonly comments?: readonly LegacyReviewComment[]
}

// -------------------------------------------------------------- store

/**
 * Store port the legacy engine depends on. `Store` (`../store.ts`)
 * satisfies this structurally; the engine and builtins are written
 * against the interface, not the concrete class, so a different backing
 * store can be substituted in tests or a future migration.
 */
export interface LegacyStorePort {
  getFeature(id: string): LegacyFeatureState | null
  listFeatures(filter?: { activeOnly?: boolean; projectDir?: string }): LegacyFeatureState[]
  findFeatureByPr(pr: number): LegacyFeatureState | null
  applyTransition(featureId: string, event: LegacyPipelineEvent, transition: LegacyTransition): void
  setFeatureFields(id: string, fields: Partial<{
    sessionId: string | null
    worktree: string | null
    branch: string | null
    pr: number | null
  }>): void
  startRun(input: {
    featureId: string
    stepId: string
    stepType: "builtin" | "command" | "agent"
    attempt: number
    role?: string
    model?: string
    sessionId?: string
  }): string
  finishRun(runId: string, status: "succeeded" | "failed" | "reaped", detail?: { output?: string; reason?: string }): void
  setRunSession(runId: string, sessionId: string, featureSessionId?: string): boolean
  concludeRun(
    runId: string,
    status: "succeeded" | "failed" | "reaped",
    detail: { output?: string; reason?: string } | undefined,
    event: LegacyPipelineEvent,
    transition: LegacyTransition,
  ): boolean
  getPendingRunAction(featureId: string): { runId: string; decision: LegacyDecision } | null
  markRunActionHandled(runId: string): boolean
  getActiveRun(featureId: string): {
    id: string
    stepId: string
    stepType: string
    attempt: number
    sessionId: string | null
    timeStarted: number
    nudges: number
  } | null
  incrementNudges(runId: string): number
  getRunById(runId: string): {
    featureId: string
    stepId: string
    status: string
    role: string | null
    attempt: number
    output: string | null
    reason: string | null
    completionEvent: string | null
  } | null
  getLastHumanNotes(featureId: string, stepId: string): string | null
  getLastOutput(featureId: string, stepId: string): string | null
  insertFindings(featureId: string, stepId: string, findings: ReadonlyArray<{
    path: string
    line: number
    severity: string
    tags: readonly string[]
    body: string
  }>): string[]
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
  }>
  setFindingStatus(featureId: string, shortId: string, status: "new" | "fixed" | "dismissed" | "reopened", resolution?: string): boolean
  setFindingThread(featureId: string, shortId: string, threadId: string): void
  markFindingSynced(featureId: string, shortId: string): void
  upsertThread(input: {
    threadId: string
    featureId: string
    pr: number
    path: string
    openedBy: string
    lastReplyBy: string
    lastReply: string
  }): "open" | "auto_resolved" | "reopened"
  markThreadResolved(threadId: string): void
  upsertPrHead(featureId: string, pr: number, headSha: string, status: string): void
  supersedeOldHeads(pr: number, currentSha: string): number
  getPrHead(pr: number, headSha: string): { status: string } | null
  getTransitions(featureId: string, limit?: number): Array<{ event: string; decision: string; detail: string | null; time: number }>
}

// --------------------------------------------------------- config resolver

/**
 * Resolves the legacy config for a project directory. ONE engine serves
 * every project sharing the DB; each feature is interpreted under ITS
 * OWN project's pipeline/roles/limits. Returns null when the project has
 * no (valid) config — its features are skipped, never guessed at.
 */
export type LegacyConfigResolver = (projectDir: string) => LegacyConfig | null

// -------------------------------------------------------------- publish

export interface LegacyPublishInput {
  readonly repo: string
  readonly pr: number
  readonly verdict: string
  readonly notes: string
  readonly publish: import("./types.ts").LegacyPublishDef
  readonly cwd: string
  /**
   * Stable finding ids (same order as the parsed findings). Embedded in
   * each inline comment as a [F<n>] marker so findings.sync can map
   * GitHub threads back to DB rows.
   */
  readonly findingIds?: readonly string[]
}

/** Review-projection port: publish a reported review to the PR. */
export type LegacyPublishReview = (input: LegacyPublishInput) => Promise<string>
