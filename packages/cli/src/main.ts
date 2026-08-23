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
  PluginRegistry,
  PluginSupervisor,
  RunnerRegistry,
  createPluginControl,
  createRunnerSessionClient,
  realPluginProcessSpawner,
  realPortAllocator,
  startApiServer,
  type ApiServer,
} from "@conductor/server"
import { runCli, type DaemonProcessHandle, type DaemonStartInput } from "./cli.ts"
import { preparePluginSubsystem } from "./plugin-runtime.ts"
import { uiDistStale, type UiDistFs } from "./ui-dist.ts"

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
  if (embedded !== undefined) {
    // Bun's /$bunfs/ virtual filesystem is not accessible via statSync
    // or Bun.file().size — check for a dist/ui/ directory alongside
    // the binary (copied there by the build script).
    const binDir = dirname(process.execPath)
    const uiDist = resolve(binDir, "ui")
    if (existsSync(resolve(uiDist, "index.html"))) {
      log({ level: "info", message: "serving web UI from dist/ui/", fields: { uiDist } })
      return uiDist
    }
    return dirname(embedded)
  }

  const repoRoot = resolve(import.meta.dirname, "../../..")
  const dist = resolve(repoRoot, "apps/web/dist")
  const hasDist = existsSync(resolve(dist, "index.html"))
  const stale =
    hasDist &&
    uiDistStale(uiDistFs, resolve(repoRoot, "apps/web"), dist, error =>
      log({
        level: "warn",
        message: "ui staleness check failed — treating dist as fresh",
        fields: { error: String(error) },
      }),
    )
  if (hasDist && !stale) return dist

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

  if (existsSync(resolve(dist, "index.html"))) {
    if (stale) log({ level: "warn", message: "web ui sources changed but this checkout cannot rebuild — serving the previous (stale) build" })
    return dist
  }
  log({ level: "info", message: "no web ui in this artifact — API only" })
  return null
}

const uiDistFs: UiDistFs = {
  exists: existsSync,
  mtimeMs: path => statSync(path).mtimeMs,
  isDirectory: path => statSync(path).isDirectory(),
  readdir: path => readdirSync(path),
  join: (...parts) => resolve(...parts),
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
  let pluginStop: (() => Promise<void>) | null = null
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
        await pluginStop?.()
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

    const plugins = await preparePluginSubsystem(input.plugins, {
      scan: () =>
        PluginRegistry.scan({
          globalDir: input.pluginsDir,
          extraPaths: input.plugins.paths,
          projects: daemon.registry.list().map(entry => ({ id: entry.projectDir, root: entry.projectDir })),
          disabled: input.plugins.disabled,
        }),
      createSupervisor: () =>
        new PluginSupervisor(
          {
            spawner: realPluginProcessSpawner,
            ports: realPortAllocator,
            log: { log: (message: string) => input.log({ level: "info", message }) },
          },
          {
            conductorUrl: `http://${apiConfig.bind.host}:${apiConfig.bind.port}`,
            ...(apiConfig.auth.mode === "bearer" ? { conductorToken: apiConfig.auth.token } : {}),
          },
        ),
      createControl: createPluginControl,
      disabledControl: () => ({
        listing: () => ({ enabled: false, plugins: [], diagnostics: [] }),
        resolve: () => ({ ok: false as const }),
        subscribe: () => () => {},
      }),
    })
    pluginStop = plugins.stop

    server = startApiServer(apiConfig, {
      store: daemon.store,
      engine: daemon.engine,
      health: () => daemon.health(),
      resolveWorkflow: daemon.registry.resolver,
      workflowStatus: dir => daemon.registry.getStatus(dir),
      registerProject: dir => daemon.registry.register(dir),
      runners,
      plugins: plugins.control,
      logger,
    })

    // Plugin backends are started once the daemon's own API is bound —
    // their CONDUCTOR_URL env only becomes answerable at this point.
    await plugins.start()
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
