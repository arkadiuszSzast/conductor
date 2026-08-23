/**
 * Default `ProcessRunner`: real process execution via `node:child_process`.
 *
 * The engine never calls `spawn`/`exec` directly — every external
 * command crosses `ProcessRunner`. This is the only file that touches
 * `child_process`, and it never falls back to `process.cwd()`; callers
 * must always provide an explicit `cwd`.
 *
 * `realPluginProcessSpawner` is the equivalent boundary for LONG-RUNNING
 * children (plugin backends) — `spawn` without a completion promise, a
 * `signal()` method and an `exited` promise instead.
 */

import { createServer } from "node:net"
import { spawn } from "node:child_process"
import type {
  PluginProcessExit,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessSpawner,
  PortAllocator,
  ProcessExecOptions,
  ProcessExecResult,
  ProcessRunner,
} from "./ports.ts"

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_OUTPUT_BYTES = 256 * 1024
/** Generous enough for a large output payload; bounds a runaway/malicious stdin payload. */
const MAX_STDIN_BYTES = 8 * 1024 * 1024

function run(
  command: string,
  args: readonly string[],
  options: ProcessExecOptions,
): Promise<ProcessExecResult> {
  return new Promise(resolve => {
    let settled = false
    const settle = (result: ProcessExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(command, args as string[], {
      cwd: options.cwd,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env: options.env !== undefined ? { ...process.env, ...options.env } : process.env,
    })
    if (options.stdin !== undefined && child.stdin) {
      // The child may close stdin early (e.g. it exits before reading all
      // input) — write() then raises EPIPE on the stream. Without this
      // handler that is an unhandled 'error' event and crashes the
      // process; the run still settles normally via 'close'.
      child.stdin.on("error", () => {})
      const stdinBuf = Buffer.from(options.stdin, "utf-8")
      child.stdin.write(stdinBuf.length > MAX_STDIN_BYTES ? stdinBuf.subarray(0, MAX_STDIN_BYTES) : stdinBuf)
      child.stdin.end()
    }
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    // Combined, chronologically-interleaved capture under ONE shared byte
    // budget (so whichever stream writes first is kept first). Concatenating
    // the separate stdout/stderr buffers instead would put all of stdout
    // before all of stderr, losing arrival order for interleaved output.
    const combinedChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let combinedBytes = 0
    const capture = (into: Buffer[], budget: () => number, spend: (n: number) => void) => (chunk: Buffer) => {
      const used = budget()
      if (used < MAX_OUTPUT_BYTES) {
        into.push(chunk.subarray(0, MAX_OUTPUT_BYTES - used))
        spend(used + chunk.length)
      }
      if (combinedBytes < MAX_OUTPUT_BYTES) {
        combinedChunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - combinedBytes))
        combinedBytes += chunk.length
      }
    }
    child.stdout?.on("data", capture(stdoutChunks, () => stdoutBytes, n => { stdoutBytes = n }))
    child.stderr?.on("data", capture(stderrChunks, () => stderrBytes, n => { stderrBytes = n }))

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.on("close", code => {
      settle({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        output: Buffer.concat(combinedChunks).toString("utf-8"),
      })
    })
    child.on("error", err => {
      settle({ code: 127, stdout: "", stderr: String(err), output: String(err) })
    })
  })
}

export const realProcessRunner: ProcessRunner = {
  exec(command, options) {
    const [head, ...rest] = command
    if (head === undefined) return Promise.resolve({ code: 127, stdout: "", stderr: "empty command", output: "empty command" })
    return run(head, rest, options)
  },
  shell(command, options) {
    return run("bash", ["-lc", command], options)
  },
}

/** Bounds the crash-diagnostic stderr excerpt kept per plugin child — cheap, not a log. */
const MAX_RECENT_STDERR_BYTES = 4 * 1024

/** The only ambient variables a plugin backend inherits by default — the
 *  basics an interpreter/runtime needs to start at all (PATH to find its
 *  own binary, HOME for tool caches, LANG/TMPDIR for sane behaviour).
 *  Everything else the daemon knows (tokens, other env) never crosses;
 *  the plugin's own `CONDUCTOR_*` contract is layered on top by the
 *  caller and always wins on conflict. */
const PASSTHROUGH_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"] as const

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export const realPluginProcessSpawner: PluginProcessSpawner = {
  spawn(command, options: PluginProcessSpawnOptions): PluginProcessHandle {
    const [head, ...rest] = command
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    let child: ReturnType<typeof spawn> | null = null
    const exited = new Promise<PluginProcessExit>(resolve => {
      if (head === undefined) {
        resolve({ code: 127, signal: null })
        return
      }
      child = spawn(head, rest as string[], {
        cwd: options.cwd,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...baseEnv(), ...options.env },
        // Best-effort: detach from the daemon's process group so a
        // signal to the daemon does not also race-kill the child before
        // the supervisor's own graceful shutdown gets to signal it —
        // reaping on shutdown stays the supervisor's explicit job.
        detached: process.platform !== "win32",
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_RECENT_STDERR_BYTES) return
        stderrChunks.push(chunk.subarray(0, MAX_RECENT_STDERR_BYTES - stderrBytes))
        stderrBytes += chunk.length
      })
      child.on("exit", (code, signal) => resolve({ code, signal }))
      child.on("error", () => resolve({ code: null, signal: null }))
    })
    return {
      signal(name = "SIGTERM") {
        // `detached: true` made the child a process-group leader, so the
        // negative-PID form reaps grandchildren too (a backend that shells
        // out must not leave orphans past daemon shutdown — design risk
        // "zombie plugin processes"). Fall back to the single-PID kill
        // where groups are unsupported (Windows) or the group is gone.
        try {
          const pid = child?.pid
          if (pid !== undefined && process.platform !== "win32") {
            process.kill(-pid, name)
            return
          }
        } catch {
          // Group already gone — fall through to the direct kill.
        }
        try {
          child?.kill(name)
        } catch {
          // Already exited — signalling a dead process is a no-op.
        }
      },
      exited,
      recentStderr: () => Buffer.concat(stderrChunks).toString("utf-8"),
    }
  },
}

/** Bind port 0 on loopback, read back the OS-assigned port, release it —
 *  the daemon never configures a plugin backend's port (design D2). A
 *  race between release and the child's own bind is inherent to this
 *  scheme and accepted (same trade-off `port: 0` tests already make
 *  elsewhere in this codebase). */
export const realPortAllocator: PortAllocator = {
  allocate(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        const port = typeof address === "object" && address !== null ? address.port : null
        server.close(closeErr => {
          if (closeErr) {
            reject(closeErr)
          } else if (port === null) {
            reject(new Error("failed to determine allocated port"))
          } else {
            resolve(port)
          }
        })
      })
    })
  },
}
