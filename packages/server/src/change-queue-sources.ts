/**
 * Readers behind the change queue (design D2): which OpenSpec changes exist
 * in a project, what each one `depends_on`, and which are merged on the
 * remote default branch. Everything crosses a small port (file access via
 * `OpenSpecFiles`, git via `ProcessRunner`) so tests use a temp git
 * repository or fakes, and the scheduler stays free of I/O details.
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseYamlObject, validateQueueEntry } from "@conductor/core"
import type { QueueDiagnostic } from "@conductor/core"
import { parseDependsOn, resolveChangeInput } from "../../../plugins/openspec/change-start.ts"
import type { ParseYaml } from "../../../plugins/openspec/change-start.ts"
import type { Logger, ProcessRunner } from "./ports.ts"

/** Read-only view of the OpenSpec tree on disk. */
export interface OpenSpecFiles {
  /** Names of the sub-directories of `dir`; empty when `dir` does not exist. */
  listDirectories(dir: string): Promise<readonly string[]>
  /** Contents of the file, or null when it does not exist. */
  readText(path: string): Promise<string | null>
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

export const nodeOpenSpecFiles: OpenSpecFiles = {
  async listDirectories(dir) {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  },
}

/** What the project's working tree says about its changes. */
export interface LocalChanges {
  /** `openspec/changes/<name>/` directories, excluding `archive`. */
  readonly active: ReadonlySet<string>
  /** Names of `openspec/changes/archive/<date>-<name>/` directories in the working tree. */
  readonly archived: ReadonlySet<string>
  /** `depends_on` of every active change whose `.openspec.yaml` could be read (absent file or key means no dependencies). */
  readonly graph: ReadonlyMap<string, readonly string[]>
  /** Active changes whose `.openspec.yaml` could not be read or parsed, with the reason. They are absent from `graph`. */
  readonly unreadable: ReadonlyMap<string, string>
  /** Active changes that have a `proposal.md`. */
  readonly proposals: ReadonlySet<string>
}

/**
 * Names archived on `origin/<default>`.
 *
 * Fetch-failure policy (a decision, not an accident): a failed or timed-out
 * `git fetch`, or a failed `ls-tree`, never crashes a pass. The failure is
 * logged and the project's last known merged set is used if one exists
 * (`stale: true`); "merged" only ever grows, so a stale set can delay a
 * start but never cause a wrong one. With no last known set the answer is
 * `unknown`, and the scheduler starts nothing for that project this pass.
 */
export type MergedChanges =
  | {
      readonly kind: "known"
      readonly names: ReadonlySet<string>
      readonly defaultBranch: string
      /** True when this is the set from an earlier pass because the fetch (or listing) failed now. */
      readonly stale: boolean
    }
  | { readonly kind: "unknown"; readonly reason: string }

/** The source operations the scheduler needs. */
export interface ChangeQueueSourcePort {
  readLocal(projectDir: string): Promise<LocalChanges>
  readMerged(projectDir: string): Promise<MergedChanges>
  /** The `proposal.md` text of an active change, or null. */
  readProposal(projectDir: string, change: string): Promise<string | null>
}

export interface ReadMergedOptions {
  /** Total time budget for the whole read (default/symbolic-ref, fetch and listing together); the per-command bounds still apply. */
  readonly budgetMs?: number
}

/** The source operations the HTTP API needs. Reads use the working tree and the last known merged set; only `readMerged` fetches. */
export interface ChangeQueueReadPort {
  readLocal(projectDir: string): Promise<LocalChanges>
  /** The merged set of the last successful read; null when there has been none. */
  lastKnownMerged(projectDir: string): ReadonlySet<string> | null
  readMerged(projectDir: string, options?: ReadMergedOptions): Promise<MergedChanges>
}

/** Budget of the fetch the HTTP API may trigger while queueing a change (the scheduler's own fetch keeps the 30 s default). */
export const API_READ_MERGED_BUDGET_MS = 10_000

export interface ChangeQueueSourcesDeps {
  readonly process: ProcessRunner
  readonly log: Logger
  readonly files?: OpenSpecFiles
  readonly parseYaml?: ParseYaml
  /** Bound on `git fetch`. Default 30 s. */
  readonly fetchTimeoutMs?: number
  /** Bound on the local git commands (`symbolic-ref`, `ls-tree`). Default 10 s. */
  readonly gitTimeoutMs?: number
}

const CHANGES_DIR = "openspec/changes"
const ARCHIVE_DIR = `${CHANGES_DIR}/archive`
const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}-(.+)$/
const DEFAULT_BRANCH_FALLBACK = "main"
const ORIGIN_REF_PREFIX = "refs/remotes/origin/"
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const DEFAULT_GIT_TIMEOUT_MS = 10_000
/** Never let git block on a credential prompt inside the daemon. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" } as const

/** `2026-01-31-quest-outcomes` becomes `quest-outcomes`; null when the name has no date prefix. */
export function archivedChangeName(entry: string): string | null {
  return ARCHIVE_NAME.exec(entry)?.[1] ?? null
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? ""
}

export class ChangeQueueSources implements ChangeQueueSourcePort, ChangeQueueReadPort {
  private readonly process: ProcessRunner
  private readonly log: Logger
  private readonly files: OpenSpecFiles
  private readonly parseYaml: ParseYaml
  private readonly fetchTimeoutMs: number
  private readonly gitTimeoutMs: number
  private readonly lastMerged = new Map<string, ReadonlySet<string>>()

  constructor(deps: ChangeQueueSourcesDeps) {
    this.process = deps.process
    this.log = deps.log
    this.files = deps.files ?? nodeOpenSpecFiles
    this.parseYaml = deps.parseYaml ?? parseYamlObject
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.gitTimeoutMs = deps.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  }

  async readLocal(projectDir: string): Promise<LocalChanges> {
    const changesDir = join(projectDir, CHANGES_DIR)
    const active = new Set(
      (await this.files.listDirectories(changesDir)).filter(name => name !== "archive" && !name.startsWith(".")),
    )
    const archived = new Set<string>()
    for (const entry of await this.files.listDirectories(join(projectDir, ARCHIVE_DIR))) {
      const name = archivedChangeName(entry)
      if (name !== null) archived.add(name)
    }

    const graph = new Map<string, readonly string[]>()
    const unreadable = new Map<string, string>()
    const proposals = new Set<string>()
    for (const change of [...active].sort()) {
      try {
        const source = await this.files.readText(join(changesDir, change, ".openspec.yaml"))
        if (source === null) {
          graph.set(change, [])
        } else {
          const parsed = parseDependsOn(source, this.parseYaml)
          if (parsed.ok) graph.set(change, parsed.dependsOn)
          else unreadable.set(change, parsed.error.message)
        }
        if ((await this.files.readText(join(changesDir, change, "proposal.md"))) !== null) proposals.add(change)
      } catch (error) {
        unreadable.set(change, error instanceof Error ? error.message : String(error))
      }
    }
    return { active, archived, graph, unreadable, proposals }
  }

  readProposal(projectDir: string, change: string): Promise<string | null> {
    return this.files.readText(join(projectDir, CHANGES_DIR, change, "proposal.md"))
  }

  lastKnownMerged(projectDir: string): ReadonlySet<string> | null {
    return this.lastMerged.get(projectDir) ?? null
  }

  async readMerged(projectDir: string, options: ReadMergedOptions = {}): Promise<MergedChanges> {
    const deadline = options.budgetMs !== undefined ? Date.now() + options.budgetMs : undefined
    const defaultBranch = await this.defaultBranch(projectDir, deadline)
    const fetched = await this.git(projectDir, ["fetch", "--quiet", "origin", defaultBranch], this.fetchTimeoutMs, deadline)
    if (fetched.code !== 0) {
      return this.fallback(
        projectDir,
        defaultBranch,
        `git fetch origin ${defaultBranch} failed (exit ${fetched.code}): ${firstLine(fetched.stderr)}`,
      )
    }
    const listed = await this.git(
      projectDir,
      ["ls-tree", "--name-only", `origin/${defaultBranch}`, `${ARCHIVE_DIR}/`],
      this.gitTimeoutMs,
      deadline,
    )
    if (listed.code !== 0) {
      return this.fallback(
        projectDir,
        defaultBranch,
        `git ls-tree origin/${defaultBranch} failed (exit ${listed.code}): ${firstLine(listed.stderr)}`,
      )
    }
    const names = new Set<string>()
    for (const line of listed.stdout.split("\n")) {
      const name = archivedChangeName(line.trim().split("/").pop() ?? "")
      if (name !== null) names.add(name)
    }
    this.lastMerged.set(projectDir, names)
    return { kind: "known", names, defaultBranch, stale: false }
  }

  private async defaultBranch(projectDir: string, deadline?: number): Promise<string> {
    const result = await this.git(projectDir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], this.gitTimeoutMs, deadline)
    const ref = result.stdout.trim()
    if (result.code === 0 && ref.startsWith(ORIGIN_REF_PREFIX) && ref.length > ORIGIN_REF_PREFIX.length) {
      return ref.slice(ORIGIN_REF_PREFIX.length)
    }
    return DEFAULT_BRANCH_FALLBACK
  }

  private fallback(projectDir: string, defaultBranch: string, reason: string): MergedChanges {
    const last = this.lastMerged.get(projectDir)
    if (last !== undefined) {
      this.log.log(`change-queue: ${projectDir}: ${reason}; using the last known merged set`)
      return { kind: "known", names: last, defaultBranch, stale: true }
    }
    this.log.log(`change-queue: ${projectDir}: ${reason}; merged set unknown, starting nothing for this project`)
    return { kind: "unknown", reason }
  }

  private git(projectDir: string, args: readonly string[], timeoutMs: number, deadline?: number) {
    const bound = deadline === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadline - Date.now()))
    return this.process.exec(["git", ...args], { cwd: projectDir, timeoutMs: bound, env: GIT_ENV })
  }
}

const quote = (name: string): string => `\`${name}\``

/** The part of the project's workflow the start path depends on: its declared `inputs` (projection shape). */
export interface WorkflowStartInputs {
  readonly inputs: unknown
}

/**
 * Problems that make a change unstartable regardless of the planner's own
 * validation: it has no directory or no `proposal.md`, it (or a
 * not-yet-merged dependency reachable from it) has an unreadable
 * `.openspec.yaml`, or — when the workflow is known — the workflow declares
 * no `change_slug`/`change` string input. Without that input the start
 * could not stamp the change name on the feature, so restart recovery could
 * never find a feature created by a crashed start and exactly-once would
 * not hold; such a change is never claimed. A malformed `depends_on` is thus
 * an `invalid` entry diagnostic, never a crash. Empty when the change is fine.
 */
export function diagnoseUnstartable(
  change: string,
  local: LocalChanges,
  merged: ReadonlySet<string>,
  workflow?: WorkflowStartInputs | null,
): QueueDiagnostic[] {
  if (!local.active.has(change)) {
    return [{ kind: "not-startable", changes: [change], message: `change ${quote(change)} has no directory under ${CHANGES_DIR}/` }]
  }
  if (workflow != null && resolveChangeInput(change, workflow.inputs) === null) {
    return [
      {
        kind: "not-startable",
        changes: [change],
        message: "the workflow declares no `change_slug`/`change` string input",
      },
    ]
  }
  const diagnostics: QueueDiagnostic[] = []
  const seen = new Set<string>()
  const visit = (current: string): void => {
    if (seen.has(current)) return
    seen.add(current)
    const reason = local.unreadable.get(current)
    if (reason !== undefined) {
      diagnostics.push({
        kind: "invalid-depends-on",
        changes: [current],
        message: `.openspec.yaml of ${quote(current)} is invalid: ${reason}`,
      })
      return
    }
    for (const dependency of local.graph.get(current) ?? []) if (!merged.has(dependency)) visit(dependency)
  }
  visit(change)
  if (diagnostics.length === 0 && !local.proposals.has(change)) {
    diagnostics.push({ kind: "not-startable", changes: [change], message: `change ${quote(change)} has no proposal.md` })
  }
  return diagnostics
}

/** Names the planner treats as existing: active, archived in the working tree, or merged on the remote. */
export function knownChanges(local: LocalChanges, merged: ReadonlySet<string>): Set<string> {
  return new Set<string>([...local.active, ...local.archived, ...merged])
}

/** Everything that keeps `change` out of the queue: unstartable first, else graph validation (cycles, unknown dependencies). */
export function diagnoseChange(
  change: string,
  local: LocalChanges,
  merged: ReadonlySet<string>,
  workflow?: WorkflowStartInputs | null,
): QueueDiagnostic[] {
  const unstartable = diagnoseUnstartable(change, local, merged, workflow)
  if (unstartable.length > 0) return unstartable
  return validateQueueEntry(change, local.graph, knownChanges(local, merged))
}
