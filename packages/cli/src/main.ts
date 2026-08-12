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

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import {
  Daemon,
  RunnerRegistry,
  createRunnerSessionClient,
  startApiServer,
  type ApiServer,
} from "@conductor/server"
import { runCli, type DaemonProcessHandle, type DaemonStartInput } from "./cli.ts"

/**
 * The UI is a property of the artifact, never configuration. Resolution
 * order: (1) SPA embedded in the compiled binary (registered by the
 * build script on globalThis), (2) the checkout's built SPA
 * (apps/web/dist relative to this package), (3) a one-time startup
 * build when the checkout can build it, (4) none — the daemon runs on
 * without UI.
 */
function resolveUiRoot(log: DaemonStartInput["log"]): string | null {
  const embedded = (globalThis as { CONDUCTOR_EMBEDDED_UI_INDEX?: string }).CONDUCTOR_EMBEDDED_UI_INDEX
  if (embedded !== undefined) return dirname(embedded)

  const repoRoot = resolve(import.meta.dirname, "../../..")
  const dist = resolve(repoRoot, "apps/web/dist")
  const distFresh = existsSync(resolve(dist, "index.html")) && !uiDistStale(resolve(repoRoot, "apps/web"), dist)
  if (distFresh) return dist

  const webPackage = resolve(repoRoot, "apps/web/package.json")
  if (existsSync(webPackage) && existsSync(resolve(repoRoot, "node_modules"))) {
    log({ level: "info", message: "building web ui..." })
    const build = spawnSync("bun", ["run", "--cwd", resolve(repoRoot, "apps/web"), "build:vite"], {
      stdio: "ignore",
      timeout: 300_000,
    })
    if (build.status === 0 && existsSync(resolve(dist, "index.html"))) {
      log({ level: "info", message: "web ui built", fields: { dist } })
      return dist
    }
    if (existsSync(resolve(dist, "index.html"))) {
      log({ level: "warn", message: "web ui build failed — serving the previous (stale) build" })
      return dist
    }
    log({ level: "warn", message: "web ui build failed — continuing without UI" })
    return null
  }

  if (existsSync(resolve(dist, "index.html"))) return dist
  log({ level: "info", message: "no web ui in this artifact — API only" })
  return null
}

/**
 * A checkout's dist is stale when any UI source file is newer than the
 * built index.html — `git pull` touches sources, not dist, so without
 * this check the daemon happily serves a build from before the fix the
 * user just pulled.
 */
function uiDistStale(webRoot: string, dist: string): boolean {
  const builtAt = statSync(resolve(dist, "index.html")).mtimeMs
  const newerThanBuild = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (newerThanBuild(path)) return true
      } else if (statSync(path).mtimeMs > builtAt) {
        return true
      }
    }
    return false
  }
  try {
    for (const probe of ["src", "index.html", "vite.config.ts"]) {
      const path = resolve(webRoot, probe)
      if (!existsSync(path)) continue
      const stat = statSync(path)
      if (stat.isDirectory()) {
        if (newerThanBuild(path)) return true
      } else if (stat.mtimeMs > builtAt) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

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

  const uiRoot = input.noUi ? null : resolveUiRoot(input.log)
  const apiConfig = uiRoot !== null ? { ...input.api, ui: { staticDir: uiRoot } } : input.api

  const started = (async () => {
    await daemon.start()
    server = startApiServer(apiConfig, {
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
