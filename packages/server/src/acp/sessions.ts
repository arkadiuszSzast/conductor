/**
 * `ManagedSessions` — the ACP `SessionClient` implementation (design.md
 * D4/D7/D9, tasks 3.3–3.6). Ties together the connection (3.1), process
 * spawner (3.2), permissions (3.5) and diagnostics (3.6) modules behind
 * the SAME `SessionClient` port the native transport implements.
 *
 * Ownership model: `prepare()` spawns one process and negotiates one ACP
 * connection per ATTEMPT (never per session — a single agent process
 * hosts exactly one session for its whole lifetime here, matching D3/D9:
 * "one process/reservation per attempt"). `createSession` consumes the
 * reservation and calls `session/new`. `prompt` calls `session/prompt`
 * and returns `{kind: "submitted", operationId}` immediately once the
 * local write is confirmed sent — the actual turn runs to completion in
 * the background and is observed later through `observeOperation`.
 *
 * Independently bounded deadlines (D7): `startupMs` bounds
 * spawn+initialize+session/new; `writeMs` bounds the local
 * `session/prompt` call's write phase; `turnMs` bounds the WHOLE turn
 * (default 60 minutes — never the native transport's fixed 10s request
 * deadline); `cancelMs`/`killMs` bound cooperative-then-forced shutdown.
 */

import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import type * as schema from "@agentclientprotocol/sdk"
import type {
  OperationObservation,
  PrepareInput,
  PrepareResult,
  SessionCapabilities,
  SessionClient,
} from "../ports.ts"
import { RunnerOperationError } from "../ports.ts"
import { resolveAcpDeadlines, type AcpDeadlines, type AcpPermissionPolicy, type AcpRoleBinding } from "./config.ts"
import { ndJsonStream, RequestError } from "@agentclientprotocol/sdk"
import { connectAcp, journalAcpStream, validatedAcpBytes, type AcpConnectionHandle } from "./connection.ts"
import { operationKindForPurpose, type ReportingReadinessPort, type RunnerSafetyStore } from "../runner-execution.ts"
import { validateAcpSpawn, type AcpProcessHandle, type AcpProcessSpawner } from "./process.ts"
import { BoundedActivityLog, sanitizeStderrTail } from "./diagnostics.ts"
import { decidePermissionBounded } from "./permissions.ts"
import { AcpRunLogWriter, type AcpRunLogSink } from "./run-log.ts"

export const ACP_SESSION_CAPABILITIES: SessionCapabilities = {
  parentSessions: false,
  nonInferentialNotes: false,
  promptConfirmation: "submitted",
}

// --------------------------------------------------------------- reservations

interface Reservation {
  readonly id: string
  readonly assignment: PrepareInput
  readonly processHandle: AcpProcessHandle
  readonly connectionHandle: AcpConnectionHandle
  readonly journal: ReturnType<typeof journalAcpStream>
  readonly activity: BoundedActivityLog
  readonly permissions: AcpPermissionPolicy
  readonly deadlines: AcpDeadlines
  readonly startupDeadline: number
  consumed: boolean
  /** True once the run/session using this reservation has been revoked
   *  (fenced/concluded) — permission decisions must deny/cancel from
   *  this point on (D9). */
  revoked: boolean
  killTimer?: ReturnType<typeof setTimeout>
}

interface ManagedSession {
  readonly reservation: Reservation
  readonly acpSessionId: schema.SessionId
  readonly runId: string
  /** The MOST RECENT prompt's tracking state (never cleared to null on
   *  completion — only ever REPLACED by a fresh turn). `status()`/`isBusy`
   *  read `.status` to tell "outstanding" from "settled"; `observeOperation`
   *  can still read a completed turn's result after it finishes. D7:
   *  "only one prompt may be in flight" — `prompt()` must reject a
   *  concurrent call while the current turn is not yet settled. */
  currentTurn: TurnState | null
  turnCounter: number
  /** Last time `touchRunActivity` was actually called for this session
   *  (review F3) — throttles the durable write so a fast-streaming turn
   *  (many `session/update` notifications per second) does not hammer
   *  SQLite once per chunk; the one-second throttle bounds how often
   *  a live turn refreshes its TTL clock. `0` (never touched) always
   *  triggers an immediate write on the first update. */
  lastActivityTouchedAt: number
}

interface TurnState {
  readonly operationId: string
  status: "submitted" | "completed"
  stopReason?: schema.StopReason
  diagnostic?: string
  cancelDeadline?: () => void
}

export interface ManagedSessionsDeps {
  readonly spawner: AcpProcessSpawner
  readonly store: RunnerSafetyStore
  readonly generation: number
  readonly activityNow?: () => number
  readonly turnDeadline?: (callback: () => void, ms: number) => () => void
  readonly readiness?: ReportingReadinessPort
  readonly reportBridge?: (runId: string) => { command: string; args: string[]; env: Record<string, string> }
  readonly bindings: Readonly<Record<string, AcpRoleBinding>>
  readonly permissions: AcpPermissionPolicy
  readonly allowedRoots: readonly string[]
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly deadlines?: Partial<AcpDeadlines>
  readonly maxConcurrent: number
  /** Optional notification; persistence always precedes observation. */
  readonly onOperationObserved?: (operationId: string, observation: OperationObservation) => void
  /** Optional run-log sink for agent narrative and tool status lines. */
  readonly runLog?: AcpRunLogSink
}

/** Substitutes the ONE supported template token, a whole `{directory}`
 *  argv element (D3) — never partial-string interpolation. */
function substituteDirectory(args: readonly string[], directory: string): readonly string[] {
  return args.map(arg => (arg === "{directory}" ? directory : arg))
}

function digestPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

export class ManagedSessions implements SessionClient {
  private readonly reservations = new Map<string, Reservation>()
  private readonly sessions = new Map<string, ManagedSession>()
  /** Termination evidence for runs whose reservation was torn down before
   *  a session existed (failed/lost session/new) — consumed by cleanupRun,
   *  which otherwise finds no session and could only report unconfirmed. */
  private readonly terminatedWithoutSession = new Map<string, Promise<"confirmed_terminated" | "unconfirmed">>()
  private slotsInUse = 0

  private readonly runLog: AcpRunLogWriter | null

  constructor(private readonly deps: ManagedSessionsDeps) {
    this.runLog = deps.runLog ? new AcpRunLogWriter({ sink: deps.runLog }) : null
  }

  capabilities(): SessionCapabilities {
    return ACP_SESSION_CAPABILITIES
  }

  // ----------------------------------------------------------- preparation

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    if (this.slotsInUse >= this.deps.maxConcurrent) {
      return { ok: false, reason: "unavailable", diagnostic: "ACP process slots exhausted" }
    }
    const binding = this.deps.bindings[input.agent]
    if (!binding) {
      return { ok: false, reason: "incompatible", diagnostic: `no ACP mode binding configured for agent "${input.agent}"` }
    }

    const command = [this.deps.command, ...substituteDirectory(this.deps.args, input.directory)]
    const invalid = validateAcpSpawn({
      command,
      directory: input.directory,
      allowedRoots: this.deps.allowedRoots,
      env: this.deps.env,
    })
    if (invalid) {
      return { ok: false, reason: "incompatible", diagnostic: `ACP spawn validation failed: ${invalid.kind}` }
    }

    this.slotsInUse += 1
    let processHandle: AcpProcessHandle
    try {
      processHandle = this.deps.spawner.spawn(command, { cwd: input.directory, env: this.deps.env })
    } catch (error) {
      this.slotsInUse -= 1
      return { ok: false, reason: "unavailable", diagnostic: `failed to spawn ACP process: ${errorMessage(error)}` }
    }

    const deadlines = resolveAcpDeadlines(this.deps.deadlines)
    const startupDeadline = Date.now() + deadlines.startupMs
    const activity = new BoundedActivityLog()
    const reservationId = randomUUID()

    let connectionHandle: AcpConnectionHandle
    const stream = ndJsonStream(processHandle.stdin, validatedAcpBytes(processHandle.stdout))
    const journal = journalAcpStream(stream, this.deps.store, this.deps.generation)
    try {
      connectionHandle = await connectAcp({
        stream: journal.stream,
        startupTimeoutMs: deadlines.startupMs,
        client: this.buildClientHandlers(reservationId, activity, deadlines),
      })
    } catch (error) {
      processHandle.signal("SIGTERM")
      this.slotsInUse -= 1
      return { ok: false, reason: "unavailable", diagnostic: `ACP connection failed: ${errorMessage(error)}` }
    }

    if (!connectionHandle.initializeOutcome.ok) {
      processHandle.signal("SIGTERM")
      this.slotsInUse -= 1
      const outcome = connectionHandle.initializeOutcome
      const diagnostic = outcome.reason === "incompatible_protocol_major"
        ? `agent returned protocol major ${outcome.returnedMajor}, requested ${outcome.requestedMajor}`
        : outcome.diagnostic
      return { ok: false, reason: "incompatible", diagnostic }
    }

    const reservation: Reservation = {
      id: reservationId,
      assignment: input,
      processHandle,
      connectionHandle,
      journal,
      activity,
      permissions: this.deps.permissions,
      deadlines,
      startupDeadline,
      consumed: false,
      revoked: false,
    }
    this.reservations.set(reservationId, reservation)

    // An unused reservation must expire and be killed (D4: "Unused
    // reservations expire and are killed") — bounded by the startup
    // deadline itself, since a reservation exists only to bridge
    // "process ready" to "createSession consumes it", which must happen
    // well within that same window in practice.
    reservation.killTimer = setTimeout(() => {
      if (!reservation.consumed) this.releaseReservation(reservationId, "unused reservation expired")
    }, deadlines.startupMs)

    return { ok: true, reservationId, capabilities: ACP_SESSION_CAPABILITIES }
  }

  async releaseReservation(reservationId: string, reason = "released"): Promise<void> {
    const reservation = this.reservations.get(reservationId)
    if (!reservation) return
    reservation.revoked = true
    this.reservations.delete(reservationId)
    if (reservation.killTimer) clearTimeout(reservation.killTimer)
    this.slotsInUse = Math.max(0, this.slotsInUse - 1)
    reservation.connectionHandle.close()
    await this.terminate(reservation, reason)
  }

  /**
   * TERM-then-KILL, bounded by `cancelMs`/`killMs` as before — PLUS
   * (real finding: OpenCode's shell tool runs a background command via
   * `setsid`, giving it its OWN process group AND session, invisible to
   * a leader-group-only signal/probe) a Linux transitive-descendant
   * snapshot taken BEFORE the first SIGTERM, refreshed once more right
   * after. The snapshot must be taken pre-kill because children can be
   * reparented to pid 1 the instant the leader dies, which would erase
   * the evidence a post-kill-only snapshot would need. `signal()` on the
   * returned handle reaches every snapshotted descendant PID/PGID in
   * addition to the leader's own group; `groupAbsent()` only reports
   * true once every one of them is independently proven gone (or pid
   * reuse) — see `process.ts`'s `groupAbsent`/`partitionDescendantsByIdentity`.
   */
  private async terminate(reservation: Reservation, _reason: string): Promise<void> {
    reservation.processHandle.refreshDescendants?.()
    reservation.processHandle.signal("SIGTERM")
    // A short-lived window where a last-instant fork (or a child not
    // yet visible at the pre-kill snapshot) can still be observed
    // before pid-1 reparenting/exit removes the evidence — merged into
    // whatever the pre-kill snapshot already found, never replacing it.
    reservation.processHandle.refreshDescendants?.()
    const waitAbsent = async () => {
      const deadline = Date.now() + reservation.deadlines.killMs
      while (!reservation.processHandle.groupAbsent?.() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return reservation.processHandle.groupAbsent?.() === true
    }
    if (!await waitAbsent()) {
      reservation.processHandle.signal("SIGKILL")
      await waitAbsent()
    }
  }

  // ------------------------------------------------------------- sessions

  async createSession(input: {
    title: string
    directory: string
    parentID?: string
    runId?: string
    reservationId?: string
    operationId?: string
  }): Promise<{ id: string }> {
    if (!input.runId) throw new RunnerOperationError("ACP requires a durable runId", { delivery: "not_sent" })
    if (!input.reservationId) {
      throw new RunnerOperationError("ACP createSession requires a reservationId from prepare()", { delivery: "not_sent" })
    }
    const reservation = this.reservations.get(input.reservationId)
    if (!reservation || reservation.consumed) {
      throw new RunnerOperationError("ACP reservation is missing or already consumed", { delivery: "not_sent" })
    }
    if (reservation.assignment.directory !== input.directory) throw new RunnerOperationError("ACP reservation directory mismatch", { delivery: "not_sent" })
    reservation.consumed = true
    if (reservation.killTimer) clearTimeout(reservation.killTimer)

    const bridge = input.runId ? this.deps.reportBridge?.(input.runId) : undefined
    const request: schema.NewSessionRequest = {
      cwd: input.directory,
      mcpServers: bridge ? [{ name: `conductor-${input.runId}`, command: bridge.command, args: bridge.args, env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })) }] : [],
    }
    const operation = this.deps.store.claimOperation({
      runId: input.runId, kind: "create", logicalKey: input.runId,
      payloadDigest: digestPayload(request), ownerGeneration: this.deps.generation ?? 0,
    })
    if (operation && operation.phase !== "prepared") {
      throw new RunnerOperationError("ACP create already attempted", { delivery: "unknown", operationId: operation.id })
    }
    const submitted = reservation.journal.track(operation.id)
    let response: schema.NewSessionResponse
    const createStartedAt = Date.now()
    try {
      const responsePromise = reservation.connectionHandle.connection.newSession(request)
      void responsePromise.catch(() => {})
      await withTimeout(submitted, reservation.deadlines.writeMs, "session/new write")
      response = await withTimeout(
        responsePromise,
        Math.max(1, reservation.startupDeadline - Date.now()),
        "session/new",
      )
    } catch (error) {
      // A lost session/new response is exactly the D5/D6 uncertainty
      // case: the write may have reached the agent even though this
      // await never resolved. Never retry with another session/new —
      // surface as unknown so the caller fences. `create_response_lost`
      // lets `observeRunnerOperation` propagate the specific
      // `lost_create_response` fence reason rather than collapsing it
      // into the generic `lost_prompt_response` every other unknown
      // prompt/answer outcome uses.
      const detail = describeUnknown("session/new", error, createStartedAt)
      // Register the teardown BEFORE the unknown phase becomes observable:
      // a reconcile pass may fence and ask for cleanup evidence the moment
      // markUnknown commits, and must wait for this termination proof.
      const teardown = this.releaseReservation(input.reservationId, "session/new failed")
        .then(() => reservation.processHandle.groupAbsent?.() === true ? "confirmed_terminated" as const : "unconfirmed" as const)
        .catch(() => "unconfirmed" as const)
      this.terminatedWithoutSession.set(input.runId, teardown)
      this.markUnknown(operation.id, "create_response_lost", detail)
      await teardown
      throw new RunnerOperationError(`ACP session/new failed or was lost: ${detail}`, {
        delivery: "unknown",
        ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      })
    }

    const binding = this.deps.store.getRunnerBinding(input.runId)
    if (binding?.phase !== "active" || binding.daemonGeneration !== this.deps.generation
      || !this.deps.store.transitionOperationPhase(operation.id, "submitted", "completed")) {
      throw new RunnerOperationError("ACP create ownership lost", { delivery: "unknown", operationId: operation.id })
    }
    const mode = this.deps.bindings[reservation.assignment.agent]!.mode
    if (response.modes?.availableModes.some(candidate => candidate.id === mode)) {
      if (response.modes.currentModeId !== mode) {
        await withTimeout(reservation.connectionHandle.connection.setSessionMode({ sessionId: response.sessionId, modeId: mode }), Math.max(1, reservation.startupDeadline - Date.now()), "session/set_mode")
      }
    } else {
      // Some ACP peers (including OpenCode) advertise modes only as a
      // select config option. Match the exact advertised value, never a label.
      const option = response.configOptions?.find(candidate =>
        (candidate.category === "mode" || candidate.id === "mode") && candidate.type === "select"
        && candidate.options.some(entry => "value" in entry ? entry.value === mode : entry.options.some(value => value.value === mode)))
      if (!option) {
        await this.releaseReservation(reservation.id, "unsupported mode")
        throw new RunnerOperationError("ACP requested mode is not advertised", { delivery: "not_sent", diagnostic: "unsupported_mode", failureClass: "invalid_config" })
      }
      const selected = await withTimeout(reservation.connectionHandle.connection.setSessionConfigOption({ sessionId: response.sessionId, configId: option.id, value: mode }), Math.max(1, reservation.startupDeadline - Date.now()), "session/set_config_option")
      if (!selected.configOptions.some(candidate => candidate.id === option.id && candidate.currentValue === mode)) {
        await this.releaseReservation(reservation.id, "mode selection not confirmed")
        throw new RunnerOperationError("ACP mode selection not confirmed", { delivery: "not_sent", failureClass: "invalid_config" })
      }
    }
    for (const [configId, value] of Object.entries(this.deps.bindings[reservation.assignment.agent]!.configOptions ?? {})) {
      const option = response.configOptions?.find(candidate => candidate.id === configId)
      if (!option || option.type !== "select" || !option.options.some(candidate => "value" in candidate ? candidate.value === value : candidate.options.some(entry => entry.value === value))) {
        await this.releaseReservation(reservation.id, "unsupported option")
        throw new RunnerOperationError("ACP requested option is not advertised", { delivery: "not_sent", failureClass: "invalid_config" })
      }
      const selected = await withTimeout(reservation.connectionHandle.connection.setSessionConfigOption({ sessionId: response.sessionId, configId, value }), Math.max(1, reservation.startupDeadline - Date.now()), "session/set_config_option")
      if (!selected.configOptions.some(candidate => candidate.id === configId && candidate.currentValue === value)) throw new RunnerOperationError("ACP option selection not confirmed", { delivery: "not_sent", failureClass: "invalid_config" })
    }
    if (reservation.assignment.model !== undefined) {
      const option = response.configOptions?.find(candidate => candidate.category === "model" && candidate.type === "select")
      if (!option || option.type !== "select" || !option.options.some(candidate => "value" in candidate ? candidate.value === reservation.assignment.model : candidate.options.some(entry => entry.value === reservation.assignment.model))) {
        await this.releaseReservation(reservation.id, "unsupported model")
        throw new RunnerOperationError("ACP requested model is not advertised", { delivery: "not_sent", diagnostic: "unsupported_model", failureClass: "invalid_config" })
      }
      const selected = await withTimeout(reservation.connectionHandle.connection.setSessionConfigOption({ sessionId: response.sessionId, configId: option.id, value: reservation.assignment.model }), Math.max(1, reservation.startupDeadline - Date.now()), "session/set_config_option")
      if (!selected.configOptions.some(candidate => candidate.id === option.id && candidate.currentValue === reservation.assignment.model)) throw new RunnerOperationError("ACP model selection not confirmed", { delivery: "not_sent", failureClass: "invalid_config" })
    }
    const localId = `acp-${randomUUID()}`
    if (!this.deps.store.setBindingSessionRef(input.runId, localId, response.sessionId)) {
      throw new RunnerOperationError("ACP binding lost", { delivery: "unknown", operationId: operation.id })
    }
    this.sessions.set(localId, { reservation, acpSessionId: response.sessionId, runId: input.runId, currentTurn: null, turnCounter: 0, lastActivityTouchedAt: 0 })
    return { id: localId }
  }

  async sessionExists(sessionID: string): Promise<boolean> {
    // Stable ACP 1 has no receiver-side session query — a locally
    // tracked session is "exists" as long as we still hold it; anything
    // else is unknown, never asserted gone (D4: "unknown ... SHALL NOT
    // trigger ... missing-session failure").
    return this.sessions.has(sessionID)
  }

  async status(sessionID: string): Promise<"busy" | "idle" | "retry" | "missing" | "unknown"> {
    const session = this.sessions.get(sessionID)
    if (!session || session.reservation.revoked || session.reservation.connectionHandle.connection.signal.aborted || session.currentTurn?.diagnostic) return "unknown"
    if (session.currentTurn === null || session.currentTurn.status === "completed") return "idle"
    return "busy"
  }

  async note(_input: { sessionID: string; text: string }): Promise<void> {
    // capabilities().nonInferentialNotes === false — the engine must
    // never call this; if it does anyway, fail loud rather than
    // silently sending a real prompt (which WOULD trigger inference).
    throw new RunnerOperationError("ACP sessions do not support non-inferential notes", { delivery: "not_sent" })
  }

  /**
   * `abort()` (below) already routes through `releaseReservation()` ->
   * `terminate()`, which snapshots the leader's transitive Linux
   * descendant tree BEFORE the first SIGTERM (D9/real finding: a
   * `setsid`'d tool the agent spawned — e.g. OpenCode's shell tool
   * backgrounding a command — gets its OWN process group, invisible to
   * a leader-group-only probe) and escalates TERM->KILL against BOTH
   * the leader's group and every snapshotted descendant PID/PGID. The
   * final `groupAbsent()` read here is therefore never leader-exit-alone
   * evidence: it is `true` only once the leader's own group AND every
   * one of those descendants is independently proven gone (or resolved
   * as pid reuse) — `"confirmed_terminated"` reflects exactly that;
   * anything else, including a descendant forked after the last
   * snapshot (a documented boundary — this is not a sandbox), reports
   * `"unconfirmed"` so recovery still requires an explicit
   * `cleanupAttested` acknowledgement rather than a false attestation.
   */
  async cleanupRun(runId: string, sessionId: string | null): Promise<"confirmed_terminated" | "unconfirmed"> {
    const session = (sessionId ? this.sessions.get(sessionId) : undefined)
      ?? [...this.sessions.values()].find(candidate => candidate.runId === runId)
    if (!session) {
      const evidence = await (this.terminatedWithoutSession.get(runId) ?? "unconfirmed")
      this.terminatedWithoutSession.delete(runId)
      return evidence
    }
    await this.abort(sessionId ?? [...this.sessions.entries()].find(([, value]) => value === session)![0])
    return session.reservation.processHandle.groupAbsent?.() === true ? "confirmed_terminated" : "unconfirmed"
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.abort(id)))
    await Promise.all([...this.reservations.keys()].map(id => this.releaseReservation(id)))
  }

  async abort(sessionID: string): Promise<void> {
    const session = this.sessions.get(sessionID)
    if (!session) return
    this.runLog?.release(session.runId)
    session.reservation.revoked = true
    session.currentTurn?.cancelDeadline?.()
    try {
      await withTimeout(
        session.reservation.connectionHandle.connection.cancel({ sessionId: session.acpSessionId }),
        session.reservation.deadlines.cancelMs,
        "session/cancel",
      )
    } catch {
      // Best-effort by port contract — bounded termination follows below
      // regardless of whether the cooperative cancel notification itself
      // could be confirmed sent.
    }
    await this.releaseReservation(session.reservation.id, "aborted")
  }

  /**
   * Submits a prompt and returns as soon as the local
   * `connection.prompt(...)` call's JSON-RPC write has gone out over the
   * stream — NOT once the turn completes (D7). The journal observes the
   * underlying write, independently of the SDK's turn response promise.
   */
  async prompt(input: {
    sessionID: string
    text: string
    agent?: string
    model?: string
    operationId?: string
    purpose?: "initial" | "answer" | "nudge"
  }): Promise<void | { readonly kind: "submitted"; readonly operationId: string }> {
    const session = this.sessions.get(input.sessionID)
    if (!session) {
      throw new RunnerOperationError(`ACP session "${input.sessionID}" is not tracked`, { delivery: "not_sent" })
    }
    if ((input.agent !== undefined && input.agent !== session.reservation.assignment.agent)
      || (input.model !== undefined && input.model !== session.reservation.assignment.model)) {
      throw new RunnerOperationError("ACP prompt assignment differs from reservation", { delivery: "not_sent" })
    }
    if (session.currentTurn !== null && session.currentTurn.status !== "completed") {
      // D7: "Never overlap prompts" — a caller trying to prompt a busy
      // session is a caller-side bug, not a proven-safe no-write
      // condition; fail closed as not_sent (this call itself never
      // wrote anything) rather than silently queuing.
      throw new RunnerOperationError("ACP session already has an outstanding prompt", { delivery: "not_sent" })
    }

    const readinessDeadline = session.reservation.startupDeadline
    while (!this.deps.readiness?.isReady(session.runId)) {
      if (session.reservation.revoked || Date.now() >= readinessDeadline) {
        throw new RunnerOperationError("ACP reporting bridge is not ready", { delivery: "not_sent", diagnostic: "reporting_not_ready" })
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, readinessDeadline - Date.now()))))
    }
    if (session.reservation.revoked || session.currentTurn?.diagnostic) {
      throw new RunnerOperationError("ACP session outcome unknown", { delivery: "unknown" })
    }
    if (input.purpose && input.purpose !== "initial" && !input.operationId) {
      throw new RunnerOperationError("ACP answer/nudge requires a logical key", { delivery: "not_sent" })
    }
    const operation = this.deps.store.claimOperation({
      runId: session.runId, kind: operationKindForPurpose(input.purpose),
      logicalKey: operationKindForPurpose(input.purpose) === "prompt" ? session.runId : input.operationId!,
      payloadDigest: digestPayload({ text: input.text }), ownerGeneration: this.deps.generation ?? 0,
    })
    if (operation && operation.phase !== "prepared") {
      throw new RunnerOperationError("ACP prompt already attempted", { delivery: "unknown", operationId: operation.id })
    }
    const operationId = operation.id
    const submitted = session.reservation.journal.track(operation.id)
    const deadlines = session.reservation.deadlines
    const turn: TurnState = { operationId, status: "submitted" }
    session.currentTurn = turn

    const request: schema.PromptRequest = {
      sessionId: session.acpSessionId,
      prompt: [{ type: "text", text: input.text }],
    }

    // `diagnosticCode` distinguishes WHY the turn's outcome became
    // unknown (durably, on `runner_operation.diagnostic_code` — D5) so
    // the engine's `observeRunnerOperation` can propagate a SPECIFIC
    // `RunnerFenceReasonCode` (`turn_deadline_exceeded` vs the generic
    // `lost_prompt_response`) instead of collapsing every unknown-outcome
    // cause into one reason code. Purely descriptive/audit, exactly like
    // the reason code itself — never changes the fencing decision.
    const fail = (diagnosticCode: "write_timeout" | "response_lost" | "turn_deadline_exceeded" = "response_lost", detail?: string) => {
      if (turn.stopReason !== undefined || turn.diagnostic) return
      turn.cancelDeadline?.()
      turn.status = "completed"
      turn.diagnostic = "ACP turn outcome unknown"
      this.markUnknown(operationId, diagnosticCode, detail ?? defaultUnknownDetail(diagnosticCode, deadlines))
    }
    const promptStartedAt = Date.now()
    const promptPromise = session.reservation.connectionHandle.connection.prompt(request)
    void promptPromise.catch(() => {})
    // Responses can precede write completion. Never commit completion until
    // the actual write observer has durably committed submission.
    const completion = submitted.then(() => promptPromise).then(response => {
      if (turn.diagnostic) return
      const binding = this.deps.store.getRunnerBinding(session.runId)
      if (binding?.phase !== "active" || binding.daemonGeneration !== this.deps.generation
        || !this.deps.store.transitionOperationPhase(operationId, "submitted", "completed", { stopReason: response.stopReason })) {
        fail("response_lost")
        return
      }
      turn.cancelDeadline?.()
      turn.status = "completed"
      turn.stopReason = response.stopReason
      this.runLog?.flush(session.runId)
      this.deps.onOperationObserved?.(operationId, { status: "completed", stopReason: response.stopReason })
    }).catch(error => fail("response_lost", describeUnknown("session/prompt", error, promptStartedAt)))
    void completion.catch(() => {})
    try {
      await withTimeout(submitted, deadlines.writeMs, "session/prompt write")
    } catch (error) {
      const detail = describeUnknown("session/prompt write", error, promptStartedAt)
      fail("write_timeout", detail)
      throw new RunnerOperationError(`ACP write outcome unknown: ${detail}`, { delivery: "unknown", operationId })
    }
    if (turn.status !== "completed") {
      this.deps.onOperationObserved?.(operationId, { status: "submitted" })
      const deadline = this.deps.turnDeadline ?? ((callback: () => void, ms: number) => {
        const timer = setTimeout(callback, ms)
        return () => clearTimeout(timer)
      })
      turn.cancelDeadline = deadline(() => fail("turn_deadline_exceeded"), deadlines.turnMs)
    }

    return { kind: "submitted", operationId }
  }

  /** Conservative observation of a durable prompt operation — reads the
   *  in-memory turn state this same adapter instance tracks. A restart
   *  loses this map entirely (by design: "restart reconstructs resource
   *  waits, not process handles") — the durable safety layer (task 2.x)
   *  is the source of truth across restarts, this is only the live,
   *  same-process fast path. */
  private markUnknown(operationId: string, diagnosticCode?: string, diagnostic?: string): void {
    try {
      const operation = this.deps.store.getOperation(operationId)
      if (operation && operation.phase !== "completed" && this.deps.store.transitionOperationPhase(operationId, operation.phase, "unknown", {
        ...(diagnosticCode !== undefined ? { diagnosticCode } : {}),
        ...(diagnostic !== undefined ? { diagnostic } : {}),
      })) {
        this.deps.onOperationObserved?.(operationId, { status: "unknown" })
      }
    } catch {
      // A persistence outage must not turn a potentially sent operation into
      // success. Its retained sending/submitted row is unsafe on recovery.
    }
  }

  async observeOperation(operationId: string): Promise<OperationObservation> {
    for (const session of this.sessions.values()) {
      if (session.currentTurn?.operationId === operationId) {
        const turn = session.currentTurn
        if (turn.status === "completed") {
          return turn.diagnostic !== undefined
            ? { status: "unknown", diagnostic: turn.diagnostic }
            : { status: "completed", ...(turn.stopReason !== undefined ? { stopReason: turn.stopReason } : {}) }
        }
        return { status: this.deps.store.getOperation(operationId)?.phase ?? "unknown" }
      }
    }
    return { status: "unknown" }
  }

  // ----------------------------------------------------------- client handlers

  private buildClientHandlers(reservationId: string, activity: BoundedActivityLog, deadlines: AcpDeadlines): schema.Client {
    return {
      sessionUpdate: async notification => {
        const reservation = this.reservations.get(reservationId)
        const session = [...this.sessions.values()].find(candidate => candidate.reservation === reservation && candidate.acpSessionId === notification.sessionId)
        if (!session || reservation?.revoked) return
        const binding = this.deps.store.getRunnerBinding(session.runId)
        if (binding?.phase !== "active" || binding.daemonGeneration !== this.deps.generation) return
        activity.record(notification.update)
        this.runLog?.record(session.runId, notification.update)
        const now = (this.deps.activityNow ?? Date.now)()
        if (session.lastActivityTouchedAt === 0 || now - session.lastActivityTouchedAt >= 1000) {
          this.deps.store.touchRunActivity(session.runId, now)
          session.lastActivityTouchedAt = now
        }
      },
      requestPermission: async request => {
        const reservation = this.reservations.get(reservationId)
        const session = [...this.sessions.values()].find(candidate => candidate.reservation === reservation && candidate.acpSessionId === request.sessionId)
        const binding = session && this.deps.store.getRunnerBinding(session.runId)
        const decision = await decidePermissionBounded(
          request,
          { sessionRevoked: !session || reservation?.revoked !== false || binding?.phase !== "active" || binding.daemonGeneration !== this.deps.generation, allowKinds: this.deps.permissions.allowKinds },
          { timeoutMs: deadlines.cancelMs },
        )
        return { outcome: decision }
      },
      // SECURITY (D9: "Advertise no client filesystem or terminal
      // capabilities initially ... Reject unexpected fs/terminal/
      // elicitation requests rather than implementing an accidental
      // shell/filesystem service"): these methods MUST be explicitly
      // rejected, never merely omitted. `ClientSideConnection`'s own
      // `legacyClientApp` wrapper (the SDK's LEGACY, still-supported
      // surface this module deliberately uses per D2) unconditionally
      // registers `onRequest` handlers for EVERY one of these methods
      // regardless of whether this implementation provides the optional
      // method at all — an omitted `writeTextFile`/`readTextFile`/
      // `createTerminal` does NOT fail closed with method-not-found on
      // this SDK version; it silently returns a FAKE SUCCESS (`{}` or
      // `undefined`) instead, verified against the pinned 1.5.0
      // package's own `legacyClientApp` source, not merely assumed.
      // Explicit rejection here is the only fail-closed boundary.
      writeTextFile: () => { throw RequestError.methodNotFound("fs/write_text_file") },
      readTextFile: () => { throw RequestError.methodNotFound("fs/read_text_file") },
      createTerminal: () => { throw RequestError.methodNotFound("terminal/create") },
      terminalOutput: () => { throw RequestError.methodNotFound("terminal/output") },
      releaseTerminal: () => { throw RequestError.methodNotFound("terminal/release") },
      waitForTerminalExit: () => { throw RequestError.methodNotFound("terminal/wait_for_exit") },
      killTerminal: () => { throw RequestError.methodNotFound("terminal/kill") },
    }
  }
}

// ------------------------------------------------------------------ helpers

class AcpDeadlineError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AcpDeadlineError(`${label} exceeded ${timeoutMs}ms deadline`)), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function errorMessage(_error: unknown): string {
  // Provider/SDK errors may echo frames containing injected bridge credentials.
  return "ACP transport or process failure"
}

/** Only our own deadline messages are safe to persist verbatim; anything
 *  from the peer stays redacted. Elapsed wall time is always recorded —
 *  elapsed far beyond the deadline means the host (not the agent) stalled. */
function describeUnknown(label: string, error: unknown, startedAt: number): string {
  const what = error instanceof AcpDeadlineError ? error.message : `${label}: ${errorMessage(error)}`
  return `${what} (elapsed ${Date.now() - startedAt}ms)`
}

function defaultUnknownDetail(code: string, deadlines: AcpDeadlines): string {
  return code === "turn_deadline_exceeded"
    ? `session/prompt turn exceeded ${deadlines.turnMs}ms deadline`
    : `session/prompt outcome lost (${code})`
}

export { sanitizeStderrTail }
