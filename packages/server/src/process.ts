/**
 * Default `ProcessRunner`: real process execution via `node:child_process`.
 *
 * The engine never calls `spawn`/`exec` directly — every external
 * command crosses `ProcessRunner`. This is the only file that touches
 * `child_process`, and it never falls back to `process.cwd()`; callers
 * must always provide an explicit `cwd`.
 */

import { spawn } from "node:child_process"
import type { ProcessExecOptions, ProcessExecResult, ProcessRunner } from "./ports.ts"

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
