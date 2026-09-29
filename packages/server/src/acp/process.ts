/**
 * `AcpProcessSpawner` — the injectable duplex process port ACP owns
 * (design.md D9: "a separate injectable duplex `AcpProcessSpawner`, not
 * PluginProcessSpawner (which lacks stdin/stdout)"). Declared here (task
 * 1.3) as a narrow contract so the adapter (task 3.x) and its tests can
 * be authored against a fake before the real spawn-argv-directly
 * implementation lands; the real implementation (task 3.2) and its
 * validation (canonical root/symlink checks, forbidden env stripping, no
 * shell interpolation) follow below in this same file.
 */

import { spawn } from "node:child_process"
import { realpathSync, readFileSync, readdirSync } from "node:fs"
import { isAbsolute } from "node:path"
import { directoryWithinRoots, FORBIDDEN_INHERITED_ENV_NAMES } from "./config.ts"

export interface AcpProcessSpawnOptions {
  /** Canonical (symlink-resolved) working directory — never a raw
   *  operator-supplied path. */
  readonly cwd: string
  /** The EXACT environment the child receives. No ambient merge here —
   *  the caller (task 3.2) has already applied `env`/`inheritEnv` and
   *  stripped every `FORBIDDEN_INHERITED_ENV_NAMES` entry. */
  readonly env: Readonly<Record<string, string>>
}

export interface AcpProcessExit {
  readonly code: number | null
  readonly signal: string | null
}

/**
 * A spawned ACP agent process — duplex, unlike `PluginProcessHandle`
 * (ports.ts), which only signals and reads stderr. ACP needs stdin
 * writes and stdout reads for JSON-RPC framing.
 */
export interface AcpProcessHandle {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  /** Bounded recent stderr — diagnostic only, never persisted raw
   *  (acp-execution spec: "Worker environment and diagnostics are
   *  explicit"). */
  recentStderr(): string
  /** Sends `name` (default SIGTERM) to the process GROUP, not just the
   *  child — D9: "a dedicated POSIX process group". On Linux this ALSO
   *  reaches every descendant snapshotted before/around cleanup began,
   *  including one that escaped into its OWN process group via its own
   *  `setsid` (a tool the agent spawned, not merely a same-group child)
   *  — see `snapshotDescendantsOf`. A no-op once exited. */
  signal(name?: NodeJS.Signals): void
  /** Resolves exactly once, when the process has exited. */
  readonly exited: Promise<AcpProcessExit>
  /** Only true once the leader's own process group AND every descendant
   *  snapshotted before/around cleanup began (Linux only — see
   *  `snapshotDescendantsOf`) are each proven gone, or now identify a
   *  DIFFERENT process (pid reuse, checked via `/proc/<pid>/stat`
   *  start-time, field 22) — never leader exit alone, and never a
   *  same-group OR a setsid'd-into-its-own-group descendant surviving.
   *  A descendant forked AFTER the last snapshot is outside this
   *  process's own observation and is documented as such (docs/
   *  install.md "Permissions are least-privilege ... not an OS
   *  sandbox"): this is bounded cleanup evidence, not a sandbox. */
  groupAbsent?(): boolean
  /** Merges a fresh Linux `/proc` descendant-tree read into the
   *  accumulated snapshot `signal()`/`groupAbsent()` use (no-op
   *  elsewhere, and no-op if never called — `signal()`/`groupAbsent()`
   *  degrade to the leader-group-only behaviour in that case). The
   *  caller (`ManagedSessions.terminate()`) MUST call this once BEFORE
   *  the first SIGTERM (descendants are still parented to the live
   *  leader then) and MAY call it again immediately after (a
   *  short-lived window where a last-instant fork is still observable
   *  before pid-1 reparenting or exit removes the evidence). */
  refreshDescendants?(): void
}

/** Spawns argv directly — no shell, no interpolation (D9/acp-execution
 *  spec: "no shell interpolation"). `command` is the full argv (argv[0]
 *  plus arguments); the caller has already substituted the ONLY
 *  supported template token, a whole `{directory}` element (D3). */
export interface AcpProcessSpawner {
  spawn(command: readonly string[], options: AcpProcessSpawnOptions): AcpProcessHandle
}

// --------------------------------------------------------------------------
// Task 3.2: real implementation — argv/env/canonical-root validation, one
// process/reservation per attempt, bounded slots.
// --------------------------------------------------------------------------

const MAX_RECENT_STDERR_BYTES = 16 * 1024

export type AcpSpawnValidationError =
  | { readonly kind: "relative_executable"; readonly command: string }
  | { readonly kind: "empty_argv" }
  | { readonly kind: "root_escape"; readonly directory: string; readonly canonicalDirectory: string; readonly allowedRoots: readonly string[] }
  | { readonly kind: "forbidden_env"; readonly name: string }

export class AcpSpawnValidationFailure extends Error {
  readonly detail: AcpSpawnValidationError
  constructor(detail: AcpSpawnValidationError) {
    super(acpSpawnValidationMessage(detail))
    this.name = "AcpSpawnValidationFailure"
    this.detail = detail
  }
}

function acpSpawnValidationMessage(detail: AcpSpawnValidationError): string {
  switch (detail.kind) {
    case "relative_executable":
      return `ACP executable path must be absolute, got "${detail.command}"`
    case "empty_argv":
      return "ACP process argv must not be empty"
    case "root_escape":
      return `directory "${detail.canonicalDirectory}" (resolved from "${detail.directory}") is outside every configured allowed root [${detail.allowedRoots.join(", ")}]`
    case "forbidden_env":
      return `environment variable "${detail.name}" is a forbidden daemon control-plane credential and may never be passed to an ACP worker`
  }
}

/**
 * Validates argv/cwd/env BEFORE any process is spawned — every check
 * here is a fail-closed precondition, never a best-effort warning
 * (acp-execution spec: "Worktree routing is exact ... execution is
 * refused instead of defaulting to another project"). Canonicalizes
 * (symlink-resolves) BOTH the target directory and every configured
 * root before comparing, so a symlink cannot route work outside the
 * configured project (the exact attack `directoryWithinRoots`'s own
 * pure-string check cannot catch by itself).
 */
export function validateAcpSpawn(input: {
  readonly command: readonly string[]
  readonly directory: string
  readonly allowedRoots: readonly string[]
  readonly env: Readonly<Record<string, string>>
}): AcpSpawnValidationError | null {
  const [executable] = input.command
  if (executable === undefined) return { kind: "empty_argv" }
  if (!isAbsolute(executable)) return { kind: "relative_executable", command: executable }

  let canonicalDirectory: string
  try {
    canonicalDirectory = realpathSync(input.directory)
  } catch {
    // A directory that does not exist yet cannot be canonicalized —
    // treat it the same as a root escape: refuse rather than guess.
    return { kind: "root_escape", directory: input.directory, canonicalDirectory: input.directory, allowedRoots: input.allowedRoots }
  }
  const canonicalRoots = input.allowedRoots.map(root => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })
  if (!directoryWithinRoots(canonicalDirectory, canonicalRoots)) {
    return { kind: "root_escape", directory: input.directory, canonicalDirectory, allowedRoots: input.allowedRoots }
  }

  for (const name of Object.keys(input.env)) {
    if (name.startsWith("CONDUCTOR_") || FORBIDDEN_INHERITED_ENV_NAMES.includes(name)) return { kind: "forbidden_env", name }
  }
  return null
}

function toWebWritable(nodeStream: NodeJS.WritableStream): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(chunk, error => (error ? reject(error) : resolve()))
      })
    },
    close() {
      return new Promise<void>(resolve => {
        nodeStream.end(() => resolve())
      })
    },
  })
}

function toWebReadable(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      nodeStream.on("end", () => {
        try {
          controller.close()
        } catch {
          // Already closed/errored — a double-close is harmless.
        }
      })
      nodeStream.on("error", error => {
        try {
          controller.error(error)
        } catch {
          // Already closed — nothing left to error.
        }
      })
    },
    cancel() {
      if ("destroy" in nodeStream && typeof nodeStream.destroy === "function") nodeStream.destroy()
    },
  })
}

// --------------------------------------------------------------------------
// Descendant-tree snapshotting (Linux only): closes the real live gap a
// leader-group-only probe cannot see — a descendant the agent spawns
// that calls its OWN `setsid()` gets a NEW process group AND a NEW
// session, invisible to `process.kill(-leaderPid, ...)`. Observed live:
// OpenCode's shell tool runs `sleep 240` exactly this way (setsid'd,
// PPID reparented to 1, PGID==PID, SID==PID) — after the agent leader's
// own group died, that `sleep` survived as an orphan while
// `groupAbsent()` (probing only the leader's group) reported the group
// absent, producing a false `confirmed_terminated` cleanup attestation.
// --------------------------------------------------------------------------

/** The subset of `/proc/<pid>/stat` fields this module needs: PPID
 *  (field 4), PGRP (field 5), SESSION (field 6), and STARTTIME (field
 *  22) — the same Linux process-identity anchor the leader itself
 *  already used, extended here to every descendant so a reused pid is
 *  never mistaken for the process that was actually snapshotted. */
export interface ProcStatFields {
  readonly ppid: number
  readonly pgrp: number
  readonly session: number
  readonly starttime: string
}

/**
 * Pure parse of one `/proc/<pid>/stat` line's fields AFTER `comm`.
 * `comm` is parenthesized and may itself contain `)` characters
 * (`man proc(5)`: "the command itself might contain closing
 * parentheses. Therefore a correct parsing ... needs to find the LAST
 * ')'"), so this searches from the end rather than splitting naively.
 * Exported so the offset/parsing logic (field 5 pgrp, field 6 session,
 * field 22 starttime — all counted from `state`, the first field after
 * `comm`) and the pid-reuse identity guard can be unit-tested with
 * synthetic strings, independent of genuine `/proc` timing.
 */
export function parseProcStatFields(raw: string): ProcStatFields | undefined {
  const closeParen = raw.lastIndexOf(")")
  if (closeParen === -1) return undefined
  const fields = raw.slice(closeParen + 2).split(" ")
  const ppid = Number(fields[1])
  const pgrp = Number(fields[2])
  const session = Number(fields[3])
  const starttime = fields[19]
  if (!Number.isInteger(ppid) || !Number.isInteger(pgrp) || !Number.isInteger(session) || !starttime) return undefined
  return { ppid, pgrp, session, starttime }
}

function readProcStatFields(pid: number): ProcStatFields | undefined {
  try {
    return parseProcStatFields(readFileSync(`/proc/${pid}/stat`, "utf8"))
  } catch {
    return undefined
  }
}

export interface ProcDescendantSnapshot {
  /** Every transitive descendant pid found (never the root/leader
   *  itself), mapped to its captured Linux start-time identity. */
  readonly pids: ReadonlyMap<number, string>
  /** Every distinct PGID observed among those descendants — includes
   *  one that called its OWN `setsid()`, i.e. is NOT the leader's own
   *  group; that is precisely the gap this snapshot closes. */
  readonly pgids: ReadonlySet<number>
  /** Every distinct SID observed among those descendants. */
  readonly sids: ReadonlySet<number>
}

const EMPTY_DESCENDANT_SNAPSHOT: ProcDescendantSnapshot = { pids: new Map(), pgids: new Set(), sids: new Set() }

/**
 * Pure BFS over an already-collected `pid -> stat` map (never reads
 * `/proc` itself) — builds a parent→children map from every entry's
 * PPID and collects every TRANSITIVE descendant of `rootPid`,
 * regardless of PGID/SID (a `setsid`'d descendant's PPID still points
 * at its real parent even though its PGID/SID no longer match). Exists
 * as a separate pure function so a test can construct a synthetic
 * process tree — including a deliberately mismatched-identity "reused"
 * pid — and assert the exact walk/guard behaviour deterministically,
 * never depending on genuine OS pid-reuse timing.
 */
export function collectDescendants(rootPid: number, statByPid: ReadonlyMap<number, ProcStatFields>): ProcDescendantSnapshot {
  const childrenOf = new Map<number, number[]>()
  for (const [pid, stat] of statByPid) {
    const siblings = childrenOf.get(stat.ppid)
    if (siblings) siblings.push(pid)
    else childrenOf.set(stat.ppid, [pid])
  }
  const pids = new Map<number, string>()
  const pgids = new Set<number>()
  const sids = new Set<number>()
  const queue = [...(childrenOf.get(rootPid) ?? [])]
  const seen = new Set<number>(queue)
  while (queue.length > 0) {
    const pid = queue.shift()!
    const stat = statByPid.get(pid)
    if (!stat) continue
    pids.set(pid, stat.starttime)
    pgids.add(stat.pgrp)
    sids.add(stat.session)
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return { pids, pgids, sids }
}

/**
 * Reads the CURRENT live `/proc` tree (Linux only) and returns every
 * transitive descendant of `rootPid`. Empty on any non-Linux host or
 * when `/proc` is unreadable — the documented fallback (docs/
 * install.md "Permissions are least-privilege ... not an OS sandbox"):
 * cleanup evidence there is exactly the leader-group-only probe this
 * module already had, never a false "no descendants exist" claim.
 */
function snapshotDescendantsOf(rootPid: number): ProcDescendantSnapshot {
  if (process.platform !== "linux") return EMPTY_DESCENDANT_SNAPSHOT
  let entries: string[]
  try {
    entries = readdirSync("/proc")
  } catch {
    return EMPTY_DESCENDANT_SNAPSHOT
  }
  const statByPid = new Map<number, ProcStatFields>()
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue
    const pid = Number(entry)
    const stat = readProcStatFields(pid)
    if (stat) statByPid.set(pid, stat)
  }
  return collectDescendants(rootPid, statByPid)
}

/** Probes one live pid's CURRENT `/proc/<pid>/stat` fields — injectable
 *  so the identity guard below is unit-testable against a fake probe,
 *  never depending on genuine OS pid-reuse timing. */
export type DescendantProbe = (pid: number) => ProcStatFields | undefined

/**
 * Partitions a snapshotted descendant `pid -> starttime` map into
 * `signal` (still alive AND the SAME process the snapshot captured —
 * safe to signal) and `resolved` (either gone, or `probe` now reports a
 * DIFFERENT starttime for that pid — pid reuse, and a reused pid must
 * NEVER be signalled: doing so could hit an unrelated later process
 * that happens to have the same numeric pid). `resolved` doubles as
 * this pid's contribution to cleanup EVIDENCE — a resolved pid counts
 * as "confirmed gone" for `groupAbsent()`'s purposes exactly because
 * signalling it would already be a no-op/wrong-target either way. Pure
 * and synchronous — no `/proc` I/O of its own — so this exact guard is
 * directly unit-testable with a synthetic probe.
 */
export function partitionDescendantsByIdentity(
  descendants: ReadonlyMap<number, string>,
  probe: DescendantProbe,
): { readonly signal: readonly number[]; readonly resolved: readonly number[] } {
  const signal: number[] = []
  const resolved: number[] = []
  for (const [pid, capturedStartTime] of descendants) {
    const current = probe(pid)
    if (!current || current.starttime !== capturedStartTime) resolved.push(pid)
    else signal.push(pid)
  }
  return { signal, resolved }
}

/**
 * Real `AcpProcessSpawner`: spawns argv DIRECTLY via `node:child_process`
 * (`shell: false`, the default — no interpolation ever), gives the child
 * a dedicated POSIX process group (D9), and exposes duplex web streams
 * over its stdio. Callers MUST validate with `validateAcpSpawn` first —
 * this function does not re-validate; it only refuses an empty argv
 * defensively.
 */
export const realAcpProcessSpawner: AcpProcessSpawner = {
  spawn(command, options) {
    const [executable, ...args] = command
    if (executable === undefined) throw new AcpSpawnValidationFailure({ kind: "empty_argv" })

    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    const child = spawn(executable, args, {
      cwd: options.cwd,
      // The EXACT environment only — no ambient `process.env` merge here.
      // The caller (config/composition layer, task 5.x) decides what
      // `env`/`inheritEnv` selects; this boundary must never silently
      // widen it.
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // Best-effort POSIX process-group leader — bounded cleanup (D9)
      // signals the whole group, not just this one PID, so descendants
      // spawned by the agent itself are reachable too. This does NOT
      // reach a descendant that calls its OWN `setsid()` — that gap is
      // what the Linux descendant-tree tracking below closes.
      detached: process.platform !== "win32",
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_RECENT_STDERR_BYTES) return
      const take = chunk.subarray(0, MAX_RECENT_STDERR_BYTES - stderrBytes)
      stderrChunks.push(take)
      stderrBytes += take.length
    })

    // Never reconstruct ownership from a persisted PID. Capture the live
    // leader's Linux start identity; latch absence permanently to prevent
    // signaling a later process group that reuses the numeric ID.
    const identity = () => readProcStatFields(child.pid ?? -1)?.starttime
    const ownedIdentity = identity()
    let leaderAbsentLatched = false
    const leaderGroupAbsent = () => {
      if (leaderAbsentLatched) return true
      if (!child.pid || process.platform === "win32") return false
      try { process.kill(-child.pid, 0); return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") leaderAbsentLatched = true
        return leaderAbsentLatched
      }
    }

    // Accumulated (never replaced by a later call — only MERGED, see
    // `refreshDescendants`) transitive-descendant snapshot: pid ->
    // captured Linux start-time identity, plus every distinct PGID seen
    // among them — including one that called its own `setsid()` and so
    // is NOT the leader's own group (the real live gap this closes: a
    // `setsid`'d tool a run's OpenCode session spawns, e.g. `sleep 240`,
    // survives the leader-group-only TERM/KILL entirely and is left
    // running as an orphan once the leader dies). The caller
    // (`ManagedSessions.terminate()`) refreshes this BEFORE the first
    // SIGTERM and once more immediately after — children can be
    // reparented to pid 1 once the leader dies, which is exactly why
    // the pre-kill snapshot is the one that matters; the post-kill call
    // only picks up a last-instant fork still visible in that brief
    // window, merged into what the pre-kill snapshot already found.
    const descendants = new Map<number, string>()
    const descendantPgids = new Set<number>()
    const refreshDescendants = () => {
      if (!child.pid || process.platform !== "linux") return
      const snapshot = snapshotDescendantsOf(child.pid)
      for (const [pid, starttime] of snapshot.pids) descendants.set(pid, starttime)
      for (const pgid of snapshot.pgids) descendantPgids.add(pgid)
    }
    /** Current split of the ACCUMULATED descendant snapshot into pids
     *  still safe to signal (alive AND the same process that was
     *  snapshotted) vs already resolved (gone, or a DIFFERENT process
     *  now holds that pid — reuse, which must never be signalled and
     *  which counts as "confirmed gone" for cleanup evidence for
     *  exactly that reason). */
    const partitionDescendants = () => partitionDescendantsByIdentity(descendants, readProcStatFields)

    let didExit = false
    const exited = new Promise<AcpProcessExit>(resolve => {
      child.on("exit", (code, signal) => { didExit = true; resolve({ code, signal }) })
      child.on("error", () => { didExit = true; resolve({ code: null, signal: null }) })
    })

    const signalLeader = (name: NodeJS.Signals) => {
      if (leaderGroupAbsent()) return
      const currentIdentity = identity()
      if (currentIdentity !== undefined && currentIdentity !== ownedIdentity) return
      try {
        const pid = child.pid
        if (pid !== undefined && process.platform !== "win32") {
          process.kill(-pid, name)
          return
        }
      } catch {
        // Group already gone — fall through to the direct kill.
      }
      try {
        if (!didExit) child.kill(name)
      } catch {
        // Already exited — signalling a dead process is a no-op.
      }
    }
    /** Reaches every descendant PROCESS GROUP found (including one a
     *  descendant put itself into via its own `setsid()`) and every
     *  individual descendant pid, guarded by start-time identity —
     *  independent of whether the leader's own group is still alive,
     *  because the whole point is that a `setsid`'d descendant can
     *  outlive the leader entirely. Linux only: `descendantPgids`/
     *  `descendants` are always empty elsewhere (`refreshDescendants`
     *  itself no-ops there), so this is a harmless no-op on other
     *  platforms — the documented fallback. */
    const signalDescendants = (name: NodeJS.Signals) => {
      if (process.platform !== "linux") return
      const leaderPid = child.pid
      for (const pgid of descendantPgids) {
        if (leaderPid !== undefined && pgid === leaderPid) continue // already reached above, same group as the leader
        try { process.kill(-pgid, name) } catch { /* that group is already gone */ }
      }
      const { signal: stillLive } = partitionDescendants()
      for (const descendantPid of stillLive) {
        try { process.kill(descendantPid, name) } catch { /* already gone */ }
      }
    }

    const groupAbsent = () => {
      if (!leaderGroupAbsent()) return false
      if (process.platform !== "linux") return true
      // Confirmed only once EVERY snapshotted descendant pid is either
      // gone or now identifies a different process (pid reuse) — never
      // inferred from the leader's own exit/group absence alone. A
      // descendant forked AFTER the last `refreshDescendants()` call is
      // outside this observation and is a documented boundary (docs/
      // install.md), not a false "confirmed" claim.
      return partitionDescendants().signal.length === 0
    }

    return {
      stdin: toWebWritable(child.stdin!),
      stdout: toWebReadable(child.stdout!),
      recentStderr: () => Buffer.concat(stderrChunks).toString("utf-8"),
      refreshDescendants,
      signal(name = "SIGTERM") {
        signalLeader(name)
        signalDescendants(name)
      },
      exited,
      groupAbsent,
    }
  },
}

// --------------------------------------------------------------------------
// Bounded process slots (D4: "Slots are bounded; restart reconstructs
// resource waits, not process handles").
// --------------------------------------------------------------------------

/** A bounded, per-profile concurrency gate: at most `maxConcurrent`
 *  outstanding acquisitions at once. Unlike a generic semaphore library,
 *  this is intentionally tiny and synchronous-acquire-or-queue — no
 *  external dependency, matching the codebase's "explicit dependency
 *  interfaces" convention (ports.ts's own docstring). */
export class BoundedProcessSlots {
  private inUse = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer")
    }
  }

  get available(): number {
    return Math.max(0, this.maxConcurrent - this.inUse)
  }

  /** Acquires a slot, resolving immediately if one is free. When none
   *  are free, the returned promise resolves once a `release()` call
   *  frees one — durable resource-wait territory (the caller, task 2.4,
   *  is responsible for NOT awaiting this inline in a way that blocks
   *  the reconciler; it should be raced against a bounded check). */
  tryAcquire(): boolean {
    if (this.inUse >= this.maxConcurrent) return false
    this.inUse += 1
    return true
  }

  release(): void {
    if (this.inUse === 0) return
    this.inUse -= 1
    const next = this.waiters.shift()
    next?.()
  }

  /** Resolves once a slot becomes free WITHOUT acquiring it — the
   *  caller must still call `tryAcquire()` to actually claim it (avoids
   *  a lost-wakeup race consuming an attempt with nothing to show for
   *  it, matching acp-execution spec: "Capacity is exhausted ... work
   *  remains durably resource-blocked without consuming executable
   *  retry attempts"). */
  onSlotFreed(): Promise<void> {
    if (this.available > 0) return Promise.resolve()
    return new Promise(resolve => this.waiters.push(resolve))
  }
}
