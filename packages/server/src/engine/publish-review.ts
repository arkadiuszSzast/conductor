/**
 * Review publishing — the transport half of a review step.
 *
 * The agent reports STRUCTURED findings via the report port (notes as
 * JSON); the conductor-side output ({{steps.<id>.output}}) is ALWAYS the
 * source of truth for downstream steps. This module PROJECTS those
 * findings onto the PR through the injected `GhClient` port — never a
 * hand-built shell command — optionally under a bot identity minted by
 * `tokenCommand` (run through the injected `ProcessRunner`, never the
 * engine's ambient shell).
 *
 * Publishing is best-effort by contract: any failure degrades (inline
 * comments → body-only → comment) and is reported as a warning string,
 * never as a pipeline failure. A review that exists in the conductor but
 * not on the PR is an inconvenience; a pipeline blocked on a projection
 * is a bug.
 */

import type { GhClient, PublishInput, ReviewComment, ProcessRunner } from "./ports.ts"

/**
 * Finding severity. Optional in agent output; unknown or missing values
 * default to "major" — an unclassified finding must never silently
 * become ignorable.
 */
export type Severity = "blocker" | "major" | "minor" | "nit"

const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor", "nit"]
export const DEFAULT_SEVERITY: Severity = "major"

export interface Finding {
  readonly path: string
  readonly line: number
  readonly side?: "LEFT" | "RIGHT"
  readonly severity: Severity
  /** Free-form labels (e.g. correctness, tests, style, security, scope). */
  readonly tags: readonly string[]
  readonly body: string
}

/** Structured review payload expected in report notes. */
export interface ReviewFindings {
  readonly summary: string
  readonly findings: readonly Finding[]
}

function toSeverity(value: unknown): Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
    ? (value as Severity)
    : DEFAULT_SEVERITY
}

function toTags(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : []
}

/**
 * Parse the agent's notes into structured findings. Tolerant by design:
 * plain-text notes (no JSON, broken JSON, wrong shape) degrade to a
 * summary-only review — the text still reaches the PR body.
 */
export function parseFindings(notes: string): ReviewFindings {
  const trimmed = notes.trim()
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(trimmed)
  const candidate = fenced?.[1] ?? (trimmed.startsWith("{") ? trimmed : null)
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as { summary?: unknown; findings?: unknown }
      const summary = typeof parsed.summary === "string" ? parsed.summary : trimmed
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings
            .filter(
              (f): f is Record<string, unknown> =>
                typeof f === "object" &&
                f !== null &&
                typeof (f as { path?: unknown }).path === "string" &&
                typeof (f as { line?: unknown }).line === "number" &&
                typeof (f as { body?: unknown }).body === "string",
            )
            .map((f): Finding => ({
              path: f.path as string,
              line: f.line as number,
              ...(f.side === "LEFT" || f.side === "RIGHT" ? { side: f.side } : {}),
              severity: toSeverity(f.severity),
              tags: toTags(f.tags),
              body: f.body as string,
            }))
        : []
      return { summary, findings }
    } catch {
      // fall through to plain text
    }
  }
  return { summary: trimmed, findings: [] }
}

/**
 * Aggregate severity counts, ordered blocker → nit, zero-counts omitted.
 * "1 blocker, 2 minor" — for timeline notes and dashboards.
 */
export function severitySummary(findings: readonly Finding[]): string {
  const counts = new Map<Severity, number>()
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1)
  const parts = SEVERITIES.filter(s => counts.has(s)).map(
    s => `${counts.get(s)} ${s}${(counts.get(s) ?? 0) > 1 && s !== "nit" ? "s" : ""}`,
  )
  return parts.join(", ")
}

/** Inline-comment body: id marker + severity prefix + tag badges + text. */
function findingBody(f: Finding, id?: string): string {
  const marker = id !== undefined ? `\`${id}\` ` : ""
  const tags = f.tags.length > 0 ? " " + f.tags.map(t => `\`${t}\``).join(" ") : ""
  return `${marker}**[${f.severity}]**${tags} ${f.body}`
}

/** A fixer's disposition of one finding, reported via the report port. */
export interface Resolution {
  readonly id: string
  readonly status: "fixed" | "dismissed" | "reopened"
  readonly note?: string
}

/**
 * Parse fixer notes for finding resolutions. Same tolerance as
 * `parseFindings`: bare JSON or fenced; anything else → no
 * resolutions.
 */
export function parseResolutions(notes: string): readonly Resolution[] {
  const trimmed = notes.trim()
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(trimmed)
  const candidate = fenced?.[1] ?? (trimmed.startsWith("{") ? trimmed : null)
  if (!candidate) return []
  try {
    const parsed = JSON.parse(candidate) as { resolutions?: unknown }
    if (!Array.isArray(parsed.resolutions)) return []
    return parsed.resolutions.filter(
      (r): r is Resolution =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as { id?: unknown }).id === "string" &&
        ["fixed", "dismissed", "reopened"].includes((r as { status?: unknown }).status as string),
    )
  } catch {
    return []
  }
}

const VERDICT_EVENT: Record<string, string> = {
  approved: "APPROVE",
  changes_requested: "REQUEST_CHANGES",
}

/** Render findings as a markdown list (body-only fallback / comment mode). */
function findingsAsMarkdown(review: ReviewFindings, ids?: readonly string[]): string {
  if (review.findings.length === 0) return review.summary
  const list = review.findings
    .map((f, i) => `${i + 1}. \`${f.path}:${f.line}\` — ${findingBody(f, ids?.[i])}`)
    .join("\n")
  return `${review.summary}\n\n${list}`
}

/**
 * Mint a bot-identity token by running `tokenCommand` through the
 * injected `ProcessRunner` (never the ambient shell) and capturing
 * stdout. Undefined tokenCommand → no override (default gh identity).
 *
 * On failure the error carries ONLY the exit code — never stdout/stderr,
 * which may contain a partially-minted token or other credential
 * material. This error text can end up in the timeline note and the
 * daemon log, both of which are not a secret store.
 */
async function mintToken(
  tokenCommand: string | undefined,
  process: ProcessRunner,
  cwd: string,
): Promise<string | undefined> {
  if (tokenCommand === undefined) return undefined
  const result = await process.shell(tokenCommand, { cwd, timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(`tokenCommand exited ${result.code}`)
  return result.stdout.trim()
}

/**
 * Publish a reported review to the PR through the injected `GhClient`
 * port. Returns a human-readable status line (for the timeline note);
 * never throws — every failure path degrades to a returned status.
 */
export function makePublishReview(gh: GhClient, process: ProcessRunner) {
  return async function publishReview(input: PublishInput): Promise<string> {
    const { publish } = input
    if (publish.mode === "none") return "publish: none"

    const review = parseFindings(input.notes)
    let token: string | undefined
    try {
      token = await mintToken(publish.tokenCommand, process, input.cwd)
    } catch (err) {
      return `publish FAILED (token): ${err instanceof Error ? err.message : String(err)}`
    }

    if (publish.mode === "comment-only") {
      const body = findingsAsMarkdown(review)
      const result = await gh.postComment(input.repo, input.pr, body, { cwd: input.cwd, ...(token !== undefined ? { token } : {}) })
      return result.ok ? "publish: comment posted" : `publish FAILED (comment): ${result.error}`
    }

    // github-review: one atomic reviews API call.
    const event = VERDICT_EVENT[input.verdict]
    if (!event) return `publish skipped: verdict "${input.verdict}" has no GitHub review event`

    const comments: ReviewComment[] = review.findings.map((f, i) => ({
      path: f.path,
      line: f.line,
      side: f.side ?? "RIGHT",
      body: findingBody(f, input.findingIds?.[i]),
    }))
    const first = await gh.postReview(
      input.repo,
      input.pr,
      { event, body: review.summary, ...(comments.length > 0 ? { comments } : {}) },
      { cwd: input.cwd, ...(token !== undefined ? { token } : {}) },
    )
    if (first.ok) {
      return review.findings.length > 0
        ? `publish: review posted (${severitySummary(review.findings)})`
        : "publish: review posted"
    }

    // Identity degradation: GitHub forbids a formal REQUEST_CHANGES/APPROVE
    // on your OWN pull request (422). This happens when no tokenCommand is
    // configured and the default gh identity is also the PR author. The
    // findings still matter — post them as a plain comment (allowed on own
    // PRs) instead of dropping the review on the floor.
    if (first.error.includes("your own pull request")) {
      const body = `**Review verdict: \`${input.verdict}\`** _(posted as a comment — the publishing identity is the PR author, so a formal review is not allowed; configure reviewPublish.tokenCommand for a bot identity)_\n\n${findingsAsMarkdown(review, input.findingIds)}`
      const comment = await gh.postComment(input.repo, input.pr, body, { cwd: input.cwd, ...(token !== undefined ? { token } : {}) })
      if (comment.ok) {
        return "publish: degraded to comment — own-PR identity cannot post a formal review (set reviewPublish.tokenCommand)"
      }
    }

    // Degrade: inline comments are the usual failure cause (stale line
    // numbers after a force-push). Retry body-only with findings inlined.
    if (review.findings.length > 0) {
      const retry = await gh.postReview(
        input.repo,
        input.pr,
        { event, body: findingsAsMarkdown(review, input.findingIds) },
        { cwd: input.cwd, ...(token !== undefined ? { token } : {}) },
      )
      if (retry.ok) return "publish: review posted (inline comments degraded to body — line mapping failed)"
    }
    return `publish FAILED (review): ${first.error}`
  }
}
