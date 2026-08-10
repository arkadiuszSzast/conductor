/**
 * Action host — executes a resolved action binding against its manifest's
 * `run` entry point. Dispatch is entirely generic on `manifest.run.kind`
 * (`inprocess` → handler registry lookup by name, `process` → the JSON
 * execution protocol over stdio); there is no action-name switch here or
 * anywhere downstream.
 *
 * Capability enforcement wraps the injected `ProcessRunner` so a handler
 * (in-process or, transitively, a subprocess action) that calls
 * `exec`/`shell` without the manifest having declared the `process`
 * capability gets a classified `capability_denied` rejection instead of
 * silently running. This is a guardrail and an audit trail — declaring a
 * capability is a policy statement the daemon enforces, not a sandbox; an
 * in-process handler can still reach outside its declared capabilities
 * through any other ambient API Node exposes.
 */

import type { ActionCapability, ActionManifest, ActionResult, ActionRunContext } from "@conductor/core"
import type { Logger, ProcessRunner } from "./ports.ts"
import type { ResolvedActionBinding } from "./workflow-reservation.ts"

export interface ActionHostDeps {
  readonly process: ProcessRunner
  readonly log: Logger
  /** Injectable delay for polling handlers (e.g. `github/await-checks`). Real by default. */
  readonly sleep: (ms: number) => Promise<void>
}

export type ActionHandler = (ctx: ActionRunContext, deps: ActionHostDeps) => Promise<ActionResult>

export type ActionHostExecuteResult =
  | { readonly ok: true; readonly outputs: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string }

/** The engine's view of an action host — small enough to fake in tests without depending on the real dispatch/capability machinery. */
export interface ActionExecutor {
  execute(binding: ResolvedActionBinding, ctx: ActionRunContext): Promise<ActionHostExecuteResult>
}

const DEFAULT_SUBPROCESS_TIMEOUT_MS = 10 * 60 * 1000

export const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Thrown by the capability-gated `ProcessRunner` when a handler invokes a
 *  capability its manifest did not declare. Caught and classified by `execute`. */
export class CapabilityDeniedError extends Error {
  constructor(readonly capability: ActionCapability) {
    super(`capability "${capability}" was not declared by the action manifest`)
    this.name = "CapabilityDeniedError"
  }
}

export class ActionHost implements ActionExecutor {
  constructor(
    private readonly handlers: Readonly<Record<string, ActionHandler>>,
    private readonly deps: Omit<ActionHostDeps, "sleep"> & { readonly sleep?: (ms: number) => Promise<void> },
  ) {}

  async execute(binding: ResolvedActionBinding, ctx: ActionRunContext): Promise<ActionHostExecuteResult> {
    const deps: ActionHostDeps = {
      process: gateProcessRunner(this.deps.process, ctx.capabilities),
      log: this.deps.log,
      sleep: this.deps.sleep ?? realSleep,
    }
    try {
      const result = await this.dispatch(binding.manifest, ctx, deps)
      return toHostResult(result)
    } catch (error) {
      if (error instanceof CapabilityDeniedError) {
        return { ok: false, error: `capability_denied: ${error.message}` }
      }
      return { ok: false, error: errorMessage(error) }
    }
  }

  private async dispatch(manifest: ActionManifest, ctx: ActionRunContext, deps: ActionHostDeps): Promise<ActionResult> {
    if (manifest.run.kind === "inprocess") {
      const handler = this.handlers[manifest.run.handler]
      if (!handler) {
        return { status: "failed", error: `unknown_handler: no handler registered for "${manifest.run.handler}" (action "${manifest.name}@v${manifest.version}")` }
      }
      return handler(ctx, deps)
    }
    return runSubprocessAction(manifest.run.command, ctx, deps)
  }
}

// ---------------------------------------------------------------------------
// Subprocess JSON protocol
// ---------------------------------------------------------------------------

async function runSubprocessAction(
  command: readonly string[],
  ctx: ActionRunContext,
  deps: ActionHostDeps,
): Promise<ActionResult> {
  const result = await deps.process.exec(command, {
    cwd: ctx.workdir,
    stdin: JSON.stringify(ctx),
    timeoutMs: DEFAULT_SUBPROCESS_TIMEOUT_MS,
  })
  if (result.code !== 0) {
    return { status: "failed", error: `action process exited ${result.code}: ${result.output.slice(-4000)}` }
  }
  return parseActionResult(result.stdout)
}

function parseActionResult(stdout: string): ActionResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { status: "failed", error: `action process produced invalid JSON on stdout: ${stdout.slice(0, 500)}` }
  }
  if (!isActionResult(parsed)) {
    return { status: "failed", error: `action process produced a malformed ActionResult: ${stdout.slice(0, 500)}` }
  }
  return parsed
}

function isActionResult(value: unknown): value is ActionResult {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  if (record.status === "succeeded") return typeof record.outputs === "object" && record.outputs !== null
  if (record.status === "failed") return typeof record.error === "string"
  return false
}

// ---------------------------------------------------------------------------
// Capability-gated process runner
// ---------------------------------------------------------------------------

function gateProcessRunner(inner: ProcessRunner, capabilities: readonly ActionCapability[]): ProcessRunner {
  const allowed = capabilities.includes("process")
  return {
    async exec(command, options) {
      if (!allowed) throw new CapabilityDeniedError("process")
      return inner.exec(command, options)
    },
    async shell(command, options) {
      if (!allowed) throw new CapabilityDeniedError("process")
      return inner.shell(command, options)
    },
  }
}

// ---------------------------------------------------------------------------

function toHostResult(result: ActionResult): ActionHostExecuteResult {
  return result.status === "succeeded" ? { ok: true, outputs: result.outputs } : { ok: false, error: result.error }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
