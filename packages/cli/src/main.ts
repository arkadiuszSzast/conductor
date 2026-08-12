#!/usr/bin/env bun
/**
 * Process entry point — the ONLY file that touches the real
 * environment. Everything else takes injected dependencies so the CLI
 * is testable without a process, a socket or a filesystem.
 *
 * `startDaemon` is the real implementation of the daemon port: it
 * instantiates `Daemon`, wires the runner registry and session
 * transport, binds the API with `Bun.serve` (`startApiServer`) and owns
 * SIGINT/SIGTERM → graceful stop. A second signal forces exit.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import {
  Daemon,
  RunnerRegistry,
  createRunnerSessionClient,
  startApiServer,
  type ApiServer,
} from "@conductor/server"
import { runCli, type DaemonProcessHandle, type DaemonStartInput } from "./cli.ts"

function startDaemon(input: DaemonStartInput): DaemonProcessHandle {
  const logger = { log: input.log }
  const runners = new RunnerRegistry()
  const sessions = createRunnerSessionClient({ runners })
  const daemon = new Daemon(input.daemon, {
    sessions,
    runnerAvailability: () => runners.list().length > 0,
    logger,
  })

  let server: ApiServer | null = null
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>(resolve => {
    exitResolve = resolve
  })

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) {
      input.log({ level: "warn", message: `second ${signal} — forcing exit` })
      process.exit(1)
    }
    stopping = true
    input.log({ level: "info", message: `received ${signal} — shutting down` })
    void (async () => {
      try {
        await server?.stop()
        await daemon.stop()
        exitResolve(0)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        input.log({ level: "error", message: `shutdown failed: ${reason}` })
        exitResolve(1)
      }
    })()
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  const started = (async () => {
    await daemon.start()
    server = startApiServer(input.api, {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      workflowStatus: dir => daemon.registry.getStatus(dir),
      registerProject: dir => daemon.registry.register(dir),
      runners,
      logger,
    })
  })()

  return { started, exited }
}

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: line => console.log(line),
  stderr: line => console.error(line),
  readFile: path => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content),
  exists: path => existsSync(path),
  mkdir: path => mkdirSync(path, { recursive: true }),
  cwd: () => process.cwd(),
  startDaemon,
})
process.exit(code)
