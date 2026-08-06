import { describe, expect, it } from "bun:test"
import { realProcessRunner } from "./src/engine/process.ts"

describe("realProcessRunner: arrival-order parity with the seed's runShell", () => {
  it("interleaves stdout and stderr chronologically in `output`, matching the seed's single-buffer capture", async () => {
    const result = await realProcessRunner.shell(
      'echo -n "A"; sleep 0.05; echo -n "B" 1>&2; sleep 0.05; echo -n "C"',
      { cwd: "/tmp" },
    )
    expect(result.code).toBe(0)
    // stdout/stderr stay separately available (GitHub JSON parsing needs them)...
    expect(result.stdout).toBe("AC")
    expect(result.stderr).toBe("B")
    // ...but `output` preserves the order commands actually emitted them in,
    // exactly like the seed's runShell (one shared buffer both streams write
    // into) — concatenating stdout then stderr would produce "ACB" instead.
    expect(result.output).toBe("ABC")
  })

  it("caps combined output at 256 KiB, matching the seed's MAX_OUTPUT_BYTES", async () => {
    // Print slightly more than 256 KiB total, split across stdout and stderr.
    const result = await realProcessRunner.shell(
      "(yes A | head -c 200000); (yes B | head -c 200000) 1>&2",
      { cwd: "/tmp" },
    )
    expect(result.output.length).toBeLessThanOrEqual(256 * 1024)
  })

  it("exec() runs the given argv directly (no shell interpretation) and reports empty-command errors", async () => {
    const result = await realProcessRunner.exec(["echo", "hi"], { cwd: "/tmp" })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("hi")

    const empty = await realProcessRunner.exec([], { cwd: "/tmp" })
    expect(empty.code).toBe(127)
    expect(empty.output).toContain("empty command")
  })

  it("kills the child and reports a non-zero exit after the timeout elapses", async () => {
    const result = await realProcessRunner.shell("sleep 5", { cwd: "/tmp", timeoutMs: 50 })
    expect(result.code).not.toBe(0)
  })

  it("pipes stdin to the child and closes it, without shell heredoc construction", async () => {
    const result = await realProcessRunner.exec(["cat"], { cwd: "/tmp", stdin: "hello from stdin" })
    expect(result.stdout).toBe("hello from stdin")
  })

  it("settles instead of crashing when the child closes stdin early (EPIPE)", async () => {
    const result = await realProcessRunner.shell("exec 0<&-; sleep 0.1", {
      cwd: "/tmp",
      stdin: "x".repeat(2 * 1024 * 1024),
    })
    expect(result.code).toBe(0)
  })

  it("caps an oversized stdin payload instead of writing it unbounded", async () => {
    const result = await realProcessRunner.exec(["wc", "-c"], {
      cwd: "/tmp",
      stdin: "x".repeat(16 * 1024 * 1024),
    })
    expect(result.code).toBe(0)
    expect(Number.parseInt(result.stdout.trim(), 10)).toBeLessThanOrEqual(8 * 1024 * 1024)
  })
})
