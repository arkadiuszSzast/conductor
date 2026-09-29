import { expect, it } from "bun:test"
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realProcessRunner } from "./src/process.ts"

it("pre-aborted commands never execute", async () => {
  const result = await realProcessRunner.shell("exit 0", { cwd: tmpdir(), signal: AbortSignal.abort() })
  expect(result.code).toBe(130)
})

it.skipIf(!process.env.VISUAL_SUPERVISOR)("cancellation reaches the detached visual supervisor and its owned process group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "visual-supervisor-"))
  const pidfile = join(directory, "pid")
  const controller = new AbortController()
  const code = `import os,time; open(${JSON.stringify(pidfile)},"w").write(str(os.getpid())); time.sleep(20)`
  const execution = realProcessRunner.exec(["python3", process.env.VISUAL_SUPERVISOR!, "10", "python3", "-c", code], { cwd: directory, signal: controller.signal, timeoutMs: 12000 })
  try {
    for (let tries = 0; tries < 100 && !existsSync(pidfile); tries++) await Bun.sleep(20)
    expect(existsSync(pidfile)).toBe(true)
    const pid = Number(readFileSync(pidfile, "utf8"))
    controller.abort()
    expect((await execution).code).toBe(130)
    expect(existsSync(`/proc/${pid}`)).toBe(false)
  } finally {
    controller.abort()
    await execution
    rmSync(directory, { recursive: true, force: true })
  }
}, 15000)

for (const mode of ["abort", "timeout"] as const) {
  it(`${mode} kills an actual TERM-ignoring grandchild within the escalation bound`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "process-cancel-"))
    const pidfile = join(directory, "pid")
    const controller = new AbortController()
    const code = `import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open(${JSON.stringify(pidfile)},"w").write(str(os.getpid())); time.sleep(20)`
    const execution = realProcessRunner.shell(`python3 -c '${code}' & wait`, { cwd: directory, signal: controller.signal, timeoutMs: mode === "timeout" ? 500 : 10000 })
    try {
      for (let tries = 0; tries < 100 && !existsSync(pidfile); tries++) await Bun.sleep(20)
      expect(existsSync(pidfile)).toBe(true)
      const pid = Number(readFileSync(pidfile, "utf8"))
      if (mode === "abort") controller.abort()
      const result = await execution
      expect(result.code).toBe(mode === "abort" ? 130 : 124)
      const live = () => existsSync(`/proc/${pid}/stat`) && readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z"
      for (let tries = 0; tries < 250 && live(); tries++) await Bun.sleep(20)
      expect(live()).toBe(false)
    } finally {
      controller.abort()
      await execution
      rmSync(directory, { recursive: true, force: true })
    }
  }, 12000)
}
