/**
 * Action host — executes a resolved action binding against its manifest's
 * `run` entry point. Dispatch is entirely generic on `manifest.run.kind`
 * (`inprocess` → handler registry lookup by name, `process` → the JSON
 * execution protocol over stdio); there is no action-name switch here or
 * anywhere downstream.
 *
 * Capability enforcement wraps the injected `ProcessRunner`: every
 * `exec` call has its required capability set inferred from the argv
 * (any exec → `process`; `git` → `git`, network-touching git subcommands
 * and known network binaries → `network`, `git worktree` → `filesystem`,
 * `gh` → `credentials`), and a call requiring a capability the manifest
 * did not declare gets a classified `capability_denied` rejection naming
 * the missing capability. `shell` is opaque to inference, so it demands
 * the broadest declaration (`process` + `network`). This is a guardrail
 * and an audit trail — declaring a capability is a policy statement the
 * daemon enforces, not a sandbox; an in-process handler can still reach
 * outside its declared capabilities through any other ambient API Node
 * exposes.
 */

import type { ActionCapability, ActionManifest, ActionResult, ActionRunContext } from "@conductor/core"
import type { Logger, ProcessRunner } from "./ports.ts"
import type { ResolvedActionBinding } from "./workflow-reservation.ts"

export interface ActionHostDeps {
  readonly process: ProcessRunner
  readonly log: Logger
  /** Injectable delay for polling handlers. Real by default. */
  readonly sleep: (ms: number) => Promise<void>
  /** Injectable wall clock for handlers computing a deadline (e.g.
   *  `github/await-checks`) — never ambient `Date.now()` in a handler. */
  readonly now: () => number
}

export type ActionHandler = (ctx: ActionRunContext, deps: ActionHostDeps) => Promise<ActionResult>

export type ActionHostExecuteResult =
  | { readonly ok: true; readonly outputs: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string }
  | { readonly ok: "pending"; readonly nextPollMs: number; readonly state: Readonly<Record<string, unknown>> | null }

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
    private readonly deps: Omit<ActionHostDeps, "sleep" | "now"> & {
      readonly sleep?: (ms: number) => Promise<void>
      readonly now?: () => number
    },
  ) {}

  async execute(binding: ResolvedActionBinding, ctx: ActionRunContext): Promise<ActionHostExecuteResult> {
    const deps: ActionHostDeps = {
      process: gateProcessRunner(this.deps.process, ctx.capabilities),
      log: this.deps.log,
      sleep: this.deps.sleep ?? realSleep,
      now: this.deps.now ?? Date.now,
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
  if (record.status === "pending") {
    if (typeof record.nextPollMs !== "number" || !Number.isFinite(record.nextPollMs) || record.nextPollMs <= 0) return false
    return record.state === undefined || (typeof record.state === "object" && record.state !== null && !Array.isArray(record.state))
  }
  return false
}

// ---------------------------------------------------------------------------
// Capability-gated process runner
// ---------------------------------------------------------------------------

const NETWORK_GIT_SUBCOMMANDS = new Set(["push", "fetch", "pull", "ls-remote", "remote", "clone", "submodule"])
const NETWORK_BINARIES = new Set(["gh", "curl", "wget", "ssh", "scp", "rsync"])

/** The capabilities an argv invocation requires, inferred from its shape. */
export function requiredCapabilities(command: readonly string[]): readonly ActionCapability[] {
  const required = new Set<ActionCapability>(["process"])
  const binary = command[0] ?? ""
  if (binary === "git") {
    required.add("git")
    const subcommand = command.find((arg, i) => i > 0 && !arg.startsWith("-")) ?? ""
    if (NETWORK_GIT_SUBCOMMANDS.has(subcommand)) required.add("network")
    if (subcommand === "worktree") required.add("filesystem")
  }
  if (NETWORK_BINARIES.has(binary)) required.add("network")
  if (binary === "gh") required.add("credentials")
  return [...required]
}

function gateProcessRunner(inner: ProcessRunner, capabilities: readonly ActionCapability[]): ProcessRunner {
  const declared = new Set(capabilities)
  const check = (required: readonly ActionCapability[]) => {
    for (const capability of required) {
      if (!declared.has(capability)) throw new CapabilityDeniedError(capability)
    }
  }
  return {
    async exec(command, options) {
      check(requiredCapabilities(command))
      return inner.exec(command, options)
    },
    async shell(command, options) {
      // A shell string is opaque to argv inference — it demands the
      // broadest declaration instead of pretending to parse it.
      check(["process", "network"])
      return inner.shell(command, options)
    },
  }
}

// ---------------------------------------------------------------------------

function toHostResult(result: ActionResult): ActionHostExecuteResult {
  if (result.status === "succeeded") return { ok: true, outputs: result.outputs }
  if (result.status === "pending") return { ok: "pending", nextPollMs: result.nextPollMs, state: result.state ?? null }
  return { ok: false, error: result.error }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
