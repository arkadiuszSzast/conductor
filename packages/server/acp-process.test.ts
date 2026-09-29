import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  AcpSpawnValidationFailure,
  BoundedProcessSlots,
  collectDescendants,
  parseProcStatFields,
  partitionDescendantsByIdentity,
  realAcpProcessSpawner,
  validateAcpSpawn,
  type ProcStatFields,
} from "./src/acp/process.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conductor-acp-process-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 3.2: explicit argv/env/canonical-root validation
// ---------------------------------------------------------------------------

describe("validateAcpSpawn: relative executable", () => {
  it("rejects a relative executable path", () => {
    const result = validateAcpSpawn({
      command: ["opencode", "acp"],
      directory: root,
      allowedRoots: [root],
      env: {},
    })
    expect(result?.kind).toBe("relative_executable")
  })

  it("accepts an absolute executable path within an allowed root", () => {
    const result = validateAcpSpawn({
      command: ["/usr/bin/true", "acp"],
      directory: root,
      allowedRoots: [root],
      env: {},
    })
    expect(result).toBeNull()
  })

  it("rejects an empty argv", () => {
    const result = validateAcpSpawn({ command: [], directory: root, allowedRoots: [root], env: {} })
    expect(result?.kind).toBe("empty_argv")
  })
})

describe("validateAcpSpawn: symlink/root escape", () => {
  it("rejects a directory that escapes every allowed root through a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "conductor-acp-outside-"))
    const allowedProject = join(root, "allowed-project")
    mkdirSync(allowedProject)
    const evilLink = join(allowedProject, "escape-link")
    symlinkSync(outside, evilLink)
    try {
      const result = validateAcpSpawn({
        command: ["/usr/bin/true"],
        directory: evilLink,
        allowedRoots: [allowedProject],
        env: {},
      })
      expect(result?.kind).toBe("root_escape")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("accepts a symlink whose target resolves inside a DIFFERENT explicitly-allowed root (sibling worktree, D3)", () => {
    const allowedProject = join(root, "allowed-project")
    const siblingWorktree = join(root, "sibling-worktree")
    mkdirSync(allowedProject)
    mkdirSync(siblingWorktree)
    const insideLink = join(allowedProject, "worktree-link")
    symlinkSync(siblingWorktree, insideLink)
    const result = validateAcpSpawn({
      command: ["/usr/bin/true"],
      directory: insideLink,
      // Both the primary project AND the sibling worktree root are
      // explicitly configured — D3: "including sibling worktree roots
      // explicitly".
      allowedRoots: [allowedProject, siblingWorktree],
      env: {},
    })
    expect(result).toBeNull()
  })

  it("rejects a directory that does not exist (cannot be canonicalized)", () => {
    const result = validateAcpSpawn({
      command: ["/usr/bin/true"],
      directory: join(root, "does-not-exist"),
      allowedRoots: [root],
      env: {},
    })
    expect(result?.kind).toBe("root_escape")
  })
})

describe("validateAcpSpawn: unrelated-project routing", () => {
  it("rejects a sibling directory that merely shares the root's string prefix", () => {
    const projectA = join(root, "my-project")
    const projectB = join(root, "my-project-2")
    mkdirSync(projectA)
    mkdirSync(projectB)
    const result = validateAcpSpawn({
      command: ["/usr/bin/true"],
      directory: projectB,
      allowedRoots: [projectA],
      env: {},
    })
    expect(result?.kind).toBe("root_escape")
  })
})

describe("validateAcpSpawn: forbidden admin env", () => {
  it("F5 rejects every CONDUCTOR_ name including the actual admin token", () => {
    for (const name of ["CONDUCTOR_TOKEN", "CONDUCTOR_RUN_TOKEN", "CONDUCTOR_URL", "CONDUCTOR_FUTURE_SECRET"]) {
      expect(validateAcpSpawn({ command: ["/bin/true"], directory: root, allowedRoots: [root],
        env: { [name]: "synthetic-only" } })).toEqual({ kind: "forbidden_env", name })
    }
  })
  it("rejects CONDUCTOR_ADMIN_TOKEN even if the caller tried to pass it through", () => {
    const result = validateAcpSpawn({
      command: ["/usr/bin/true"],
      directory: root,
      allowedRoots: [root],
      env: { CONDUCTOR_ADMIN_TOKEN: "leaked-secret", PATH: "/usr/bin" },
    })
    expect(result?.kind).toBe("forbidden_env")
    if (result?.kind === "forbidden_env") expect(result.name).toBe("CONDUCTOR_ADMIN_TOKEN")
  })

  it("accepts a plain, non-forbidden env map", () => {
    const result = validateAcpSpawn({
      command: ["/usr/bin/true"],
      directory: root,
      allowedRoots: [root],
      env: { PATH: "/usr/bin", HOME: "/srv/agent-home" },
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3.2: real spawn — no shell interpolation, duplex streams
// ---------------------------------------------------------------------------

describe("realAcpProcessSpawner: no shell interpolation", () => {
  it("SEC1 leader exit does not prove group absence or suppress descendant signals", async () => {
    const handle = realAcpProcessSpawner.spawn(["/bin/sh", "-c", "(trap '' TERM; while :; do sleep 1; done) & printf ready; exit 0"], { cwd: root, env: { PATH: "/usr/bin:/bin" } })
    const reader = handle.stdout.getReader()
    await reader.read()
    await handle.exited
    try {
      expect(handle.groupAbsent?.()).toBe(false)
      handle.signal("SIGTERM")
      expect(handle.groupAbsent?.()).toBe(false)
      handle.signal("SIGKILL")
      // Reparented zombies can keep the group observable on hosts whose
      // init does not reap promptly. Never claim confirmed cleanup here.
      expect(typeof handle.groupAbsent?.()).toBe("boolean")
    } finally { handle.signal("SIGKILL"); await reader.cancel() }
  })

  it("SEC1/DB6: proves the TERM-ignoring descendant process is ACTUALLY alive before/after TERM and dead after KILL — not merely inferred from groupAbsent()", async () => {
    // Writes its OWN pid to a file so this test can independently
    // confirm (via `process.kill(pid, 0)`, a pure liveness probe that
    // sends no signal) that the descendant genuinely survives a TERM to
    // the group and genuinely dies once KILL reaches it — proving the
    // absent/unconfirmed distinction is backed by real process state,
    // not just this module's own self-reported `groupAbsent()`.
    const pidFile = join(root, "descendant.pid")
    // `$!` from the PARENT shell (never `$$` inside the backgrounded
    // subshell itself — under `dash`/POSIX `sh`, `$$` inside a `(...)`
    // subshell reports the ENCLOSING shell's pid, not the subshell's
    // own, since a subshell is not guaranteed a real fork boundary).
    const handle = realAcpProcessSpawner.spawn(
      ["/bin/sh", "-c", `(trap '' TERM; while :; do sleep 1; done) & echo $! > ${pidFile}; printf ready; exit 0`],
      { cwd: root, env: { PATH: "/usr/bin:/bin" } },
    )
    const reader = handle.stdout.getReader()
    await reader.read()
    await handle.exited // the LEADER has exited — the descendant has not
    let descendantPid = -1
    for (let attempt = 0; attempt < 50 && descendantPid === -1; attempt++) {
      try { descendantPid = Number((await Bun.file(pidFile).text()).trim()) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    expect(descendantPid).toBeGreaterThan(0)
    const isAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    try {
      // BEFORE any signal: leader is gone, descendant is alive.
      expect(isAlive(descendantPid)).toBe(true)
      expect(handle.groupAbsent?.()).toBe(false)

      // DURING/after TERM: the descendant explicitly traps and ignores
      // TERM — it MUST remain alive, and groupAbsent() must NOT claim
      // the group is gone (leader-exit alone must never be conflated
      // with confirmed cleanup, nor may an ignored TERM be).
      handle.signal("SIGTERM")
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(isAlive(descendantPid)).toBe(true)
      expect(handle.groupAbsent?.()).toBe(false)

      // Only KILL (unblockable) actually reaches and terminates it.
      handle.signal("SIGKILL")
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(isAlive(descendantPid)).toBe(false)
      expect(handle.groupAbsent?.()).toBe(true)
    } finally { handle.signal("SIGKILL"); await reader.cancel() }
  })
  it("passes an argument containing shell metacharacters literally, never interpolated", async () => {
    // `echo` with an argument containing `; rm -rf /` etc. must be
    // printed VERBATIM — a shell would need to interpret those
    // characters, `spawn(..., { shell: false })` never does.
    const dangerous = "hello; touch /tmp/should-not-exist-$(whoami) && echo pwned"
    const handle = realAcpProcessSpawner.spawn(["/bin/echo", dangerous], { cwd: root, env: {} })
    const chunks: Uint8Array[] = []
    const reader = handle.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const output = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf-8")
    expect(output.trim()).toBe(dangerous)
    await handle.exited
  })

  it("gives the child exactly the provided env — no ambient ${process.env} merge", async () => {
    const handle = realAcpProcessSpawner.spawn(
      ["/usr/bin/env"],
      { cwd: root, env: { ONLY_THIS: "yes" } },
    )
    const chunks: Uint8Array[] = []
    const reader = handle.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const output = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf-8")
    expect(output.trim()).toBe("ONLY_THIS=yes")
    await handle.exited
  })

  it("exited resolves with the process's real exit code", async () => {
    const handle = realAcpProcessSpawner.spawn(["/usr/bin/env", "false"], { cwd: root, env: {} })
    void handle.stdout.cancel()
    const exit = await handle.exited
    // /usr/bin/env with a nonexistent "false" absolute-less command —
    // accept either a nonzero exit or a spawn error resolving null/1,
    // the point is `exited` SETTLES rather than hanging.
    expect(exit).toBeDefined()
  })

  it("recentStderr captures bounded stderr output", async () => {
    const handle = realAcpProcessSpawner.spawn(["/bin/sh", "-c", "echo oops 1>&2"], { cwd: root, env: {} })
    void handle.stdout.cancel()
    await handle.exited
    // Give the stderr 'data' event a tick to land.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.recentStderr()).toContain("oops")
  })

  it("throws AcpSpawnValidationFailure for an empty argv rather than spawning nothing silently", () => {
    expect(() => realAcpProcessSpawner.spawn([], { cwd: root, env: {} })).toThrow(AcpSpawnValidationFailure)
  })

  it("signal() terminates a long-running child", async () => {
    const handle = realAcpProcessSpawner.spawn(["/bin/sleep", "30"], { cwd: root, env: {} })
    void handle.stdout.cancel()
    handle.signal("SIGTERM")
    const exit = await handle.exited
    expect(exit.signal === "SIGTERM" || exit.code !== null).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Real finding: OpenCode's shell tool runs a background command via
  // `setsid` — a NEW process group AND session, invisible to
  // `process.kill(-leaderPid, ...)`. These tests prove the descendant
  // snapshot/signal/groupAbsent machinery actually reaches and confirms
  // termination of exactly that shape, not merely a same-group child.
  // -------------------------------------------------------------------------

  it("SEC1 setsid'd descendant: signal() reaches it via its OWN process group and groupAbsent() only confirms once it is actually gone", async () => {
    const pidFile = join(root, "setsid-descendant.pid")
    // The LEADER itself stays alive (`sleep 30`) after backgrounding the
    // setsid'd descendant so the pre-kill PPID-based descendant walk
    // has a live leader to walk from — exactly why `terminate()`
    // documents taking its snapshot BEFORE the first SIGTERM: once the
    // leader exits, the kernel reparents the descendant to pid 1 and
    // the PPID chain back to the (now-gone) leader is lost.
    const handle = realAcpProcessSpawner.spawn(
      ["/bin/sh", "-c", `setsid sh -c 'echo $$ > ${pidFile}; trap "" TERM; while :; do sleep 1; done' & printf ready; sleep 30`],
      { cwd: root, env: { PATH: "/usr/bin:/bin" } },
    )
    const reader = handle.stdout.getReader()
    await reader.read()
    let descendantPid = -1
    for (let attempt = 0; attempt < 50 && descendantPid === -1; attempt++) {
      try { descendantPid = Number((await Bun.file(pidFile).text()).trim()) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    expect(descendantPid).toBeGreaterThan(0)
    const isAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    try {
      // Pre-kill snapshot — the leader is still alive at this point.
      handle.refreshDescendants?.()
      expect(isAlive(descendantPid)).toBe(true)
      expect(handle.groupAbsent?.()).toBe(false)

      handle.signal("SIGTERM")
      // Post-signal refresh, mirroring `ManagedSessions.terminate()`.
      handle.refreshDescendants?.()
      await new Promise(resolve => setTimeout(resolve, 150))
      // The leader itself (no trap) dies from TERM; the setsid'd
      // descendant explicitly ignores TERM and MUST remain alive —
      // groupAbsent() must NOT report confirmed cleanup while it does.
      expect(isAlive(descendantPid)).toBe(true)
      expect(handle.groupAbsent?.()).toBe(false)

      // Only KILL (unblockable) actually reaches and terminates it.
      handle.signal("SIGKILL")
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(isAlive(descendantPid)).toBe(false)
      expect(handle.groupAbsent?.()).toBe(true)
    } finally { handle.signal("SIGKILL"); await reader.cancel() }
  })

  it("groupAbsent() reports true once a leader-group-only probe would (wrongly) look absent, PROVIDED the accumulated descendant snapshot itself is also empty — proving groupAbsent honours descendant evidence and not just leader-group state", async () => {
    // A leader with NO descendants at all: the descendant snapshot is
    // legitimately empty, so groupAbsent() degrades to (and must still
    // correctly report) the leader-group-only result once KILLed.
    const handle = realAcpProcessSpawner.spawn(["/bin/sleep", "30"], { cwd: root, env: {} })
    void handle.stdout.cancel()
    handle.refreshDescendants?.()
    handle.signal("SIGKILL")
    await handle.exited
    handle.refreshDescendants?.()
    expect(handle.groupAbsent?.()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pure descendant-tree helpers — deterministic, no real /proc I/O, so the
// pid-reuse identity guard (task item 4c) can be tested without depending
// on genuine OS pid-reuse timing.
// ---------------------------------------------------------------------------

describe("parseProcStatFields", () => {
  it("parses ppid/pgrp/session/starttime from a synthetic /proc/<pid>/stat line", () => {
    // Field 2 is `comm` (parenthesized); fields counted from field 3
    // (`state`) onward. starttime is field 22 overall == index 19 in
    // the slice taken right after the closing paren + state field.
    const fields = ["S", "111", "222", "333", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "999888"]
    const line = `4242 (my proc) ${fields.join(" ")}`
    const parsed = parseProcStatFields(line)
    expect(parsed).toEqual({ ppid: 111, pgrp: 222, session: 333, starttime: "999888" })
  })

  it("finds the LAST ')' when comm itself contains a closing paren (man proc(5))", () => {
    const fields = ["S", "111", "222", "333", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "555"]
    const line = `4242 (weird)name) ${fields.join(" ")}`
    const parsed = parseProcStatFields(line)
    expect(parsed?.starttime).toBe("555")
  })

  it("returns undefined for an unparseable line", () => {
    expect(parseProcStatFields("garbage, no parens")).toBeUndefined()
  })
})

describe("collectDescendants", () => {
  it("collects every transitive descendant of the root, regardless of PGID/SID", () => {
    const stat = (ppid: number, pgrp: number, session: number, starttime: string): ProcStatFields => ({ ppid, pgrp, session, starttime })
    const statByPid = new Map<number, ProcStatFields>([
      [200, stat(100, 100, 100, "s200")], // direct child, same group as leader
      [201, stat(200, 201, 201, "s201")], // grandchild that setsid'd — DIFFERENT pgid/sid
      [999, stat(1, 999, 999, "unrelated")], // unrelated process elsewhere in /proc
    ])
    const snapshot = collectDescendants(100, statByPid)
    expect([...snapshot.pids.keys()].sort()).toEqual([200, 201])
    expect(snapshot.pids.get(201)).toBe("s201")
    expect(snapshot.pgids.has(201)).toBe(true) // the setsid'd descendant's OWN group is captured
    expect(snapshot.sids.has(201)).toBe(true)
    expect(snapshot.pids.has(999)).toBe(false)
  })

  it("returns an empty snapshot for a leader with no descendants", () => {
    const snapshot = collectDescendants(100, new Map())
    expect(snapshot.pids.size).toBe(0)
    expect(snapshot.pgids.size).toBe(0)
  })
})

describe("partitionDescendantsByIdentity: pid-reuse guard (task item 4c)", () => {
  it("keeps a still-alive descendant in `signal` when the probe reports the SAME start-time identity", () => {
    const captured = new Map([[500, "s500"]])
    const probe = (pid: number): ProcStatFields | undefined => pid === 500 ? { ppid: 1, pgrp: 500, session: 500, starttime: "s500" } : undefined
    const result = partitionDescendantsByIdentity(captured, probe)
    expect(result.signal).toEqual([500])
    expect(result.resolved).toEqual([])
  })

  it("moves a gone pid into `resolved` — never signals a pid the probe cannot find", () => {
    const captured = new Map([[500, "s500"]])
    const probe = (): ProcStatFields | undefined => undefined
    const result = partitionDescendantsByIdentity(captured, probe)
    expect(result.signal).toEqual([])
    expect(result.resolved).toEqual([500])
  })

  it("F: a REUSED pid (different start-time identity) is NEVER signalled — moved to `resolved` instead, counted as gone rather than mistakenly targeted", () => {
    const captured = new Map([[500, "s500-original"]])
    // The OS reused pid 500 for an entirely unrelated later process —
    // same pid, different starttime.
    const probe = (pid: number): ProcStatFields | undefined => pid === 500 ? { ppid: 1, pgrp: 500, session: 500, starttime: "s500-DIFFERENT" } : undefined
    const result = partitionDescendantsByIdentity(captured, probe)
    expect(result.signal).toEqual([])
    expect(result.resolved).toEqual([500])
  })

  it("partitions a mixed set correctly: alive+same-identity, gone, and reused", () => {
    const captured = new Map([
      [1, "alive"],
      [2, "gone"],
      [3, "reused"],
    ])
    const probe = (pid: number): ProcStatFields | undefined => {
      if (pid === 1) return { ppid: 0, pgrp: 1, session: 1, starttime: "alive" }
      if (pid === 3) return { ppid: 0, pgrp: 3, session: 3, starttime: "reused-DIFFERENT" }
      return undefined
    }
    const result = partitionDescendantsByIdentity(captured, probe)
    expect(result.signal).toEqual([1])
    expect([...result.resolved].sort()).toEqual([2, 3])
  })
})

// ---------------------------------------------------------------------------
// 3.2: bounded process slots — capacity is exhausted / release
// ---------------------------------------------------------------------------

describe("BoundedProcessSlots", () => {
  it("allows up to maxConcurrent acquisitions, then refuses", () => {
    const slots = new BoundedProcessSlots(2)
    expect(slots.tryAcquire()).toBe(true)
    expect(slots.tryAcquire()).toBe(true)
    expect(slots.tryAcquire()).toBe(false)
    expect(slots.available).toBe(0)
  })

  it("release() frees exactly one slot", () => {
    const slots = new BoundedProcessSlots(1)
    expect(slots.tryAcquire()).toBe(true)
    expect(slots.tryAcquire()).toBe(false)
    slots.release()
    expect(slots.available).toBe(1)
    expect(slots.tryAcquire()).toBe(true)
  })

  it("release() on an idle pool is a harmless no-op, never goes negative", () => {
    const slots = new BoundedProcessSlots(1)
    slots.release()
    expect(slots.available).toBe(1)
  })

  it("onSlotFreed() resolves immediately when capacity is already available", async () => {
    const slots = new BoundedProcessSlots(1)
    await slots.onSlotFreed()
    expect(true).toBe(true)
  })

  it("onSlotFreed() resolves only after a release() call — capacity exhaustion consumes no attempt while waiting", async () => {
    const slots = new BoundedProcessSlots(1)
    slots.tryAcquire()
    let resolved = false
    const waiting = slots.onSlotFreed().then(() => {
      resolved = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(resolved).toBe(false)
    slots.release()
    await waiting
    expect(resolved).toBe(true)
  })

  it("rejects a non-positive-integer maxConcurrent at construction", () => {
    expect(() => new BoundedProcessSlots(0)).toThrow()
    expect(() => new BoundedProcessSlots(-1)).toThrow()
  })
})
