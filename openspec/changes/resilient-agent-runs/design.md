# Design — resilient-agent-runs

## Context

See proposal.md — Why. Current mechanics in `packages/server/src/engine.ts`:

- `reconcileTtl` compares `clock.now() - active.timeStarted` against a
  single engine-wide `runTtlMs` (default 1 h) and reaps on breach.
- The nudge path (`reconcileAgentRun`) only covers sessions the runner
  reports `idle`; `busy`/`retry` sessions clear the idle counter and fall
  through to the TTL check. A hung provider stream keeps a session `busy`
  indefinitely, so TTL was the only guard — and it fired mid-work.
- `reap()` calls `concludeAndDispatch(... "reaped" ...)` — DB-only; the
  runner is never told, so the opencode session keeps running.
- The store already has `run_log` rows with a `time` column and the run
  row has `time_started` / nudge counters; there is no last-activity
  column.
- `SessionClient` (packages/server/src/ports.ts) has create / prompt /
  status / note / sessionExists — no abort. The opencode adapter
  (packages/runner-opencode/src/sessions.ts) wraps the opencode SDK
  client, which exposes `session.abort({ path: { id } })`.
- Pause semantics: `paused_ms_at_dispatch` already excludes paused time
  from TTL math; the activity clock must keep that property.

## Goals / Non-Goals

**Goals**

- A run that demonstrably makes progress is never reaped by wall-clock.
- Silence — not age — is the reap trigger; the silence budget stays the
  existing `runTtlMs` scale, overridable per agent step.
- A reaped run's session is actually stopped in the runtime.

**Non-Goals**

- No change to the idle-nudge state machine (debounce cycles, nudge
  budget).
- No per-step nudge/idle tuning — only the TTL is step-scoped.
- No abort for *human* or *command* steps (commands already have
  `timeoutMs` enforced by the process runner).
- No cross-runner protocol change beyond the one new `abort` operation.

## Decisions

### D1 — Activity clock: durable `time_last_activity` column on `run`

Add `time_last_activity` (INTEGER, epoch ms) to the `run` table via a new
migration; initialise to `time_started` on dispatch. Touch points that
update it: log ingestion (`appendRunLog`), question set/answer, nudge
sends, and any runner-originated run mutation. `reconcileTtl` computes
`age = now - max(time_last_activity, time_started) - pausedCredit`.

*Alternative considered*: deriving last activity from `MAX(run_log.time)`
at reconcile time — rejected: a per-reconcile aggregate query per active
run, and logs are not the only activity signal (question flow, nudges).
A denormalised column updated on the write paths is O(1) and durable.

*Restart property*: the column is persisted, so recovery reads the true
last activity; the spec's "no fresh window on restart" scenario falls out
for free. (Seed behaviour note: `time_started` fallback covers legacy
rows created before the migration.)

### D2 — Busy-session TTL means "reap on silence", idle path unchanged

The TTL check moves from "age since start" to "age since last activity"
in both places it exists today (`reconcileAgentRun` → `reconcileTtl` and
the missing-runner sweep). The idle-nudge path is untouched: an idle
session still gets nudged on the idle-cycle debounce and reaped after the
nudge budget — that path already measures the right thing (an idle
session with no report *is* silent).

### D3 — `ttlMs` on agent steps only, resolved at reconcile time

Schema: optional `ttlMs?: number` on the agent step definition
(`packages/core`), validated positive integer. The engine resolves the
governing TTL per active run: step's `ttlMs` if declared, else engine
`runTtlMs`. No DB storage — the workflow snapshot pinned to the feature
already carries the step definition, so reruns stay consistent with the
pinned workflow version.

*Alternative considered*: a job-level TTL — rejected: the expensive step
is almost always a single agent step (implement); a job-wide value would
silently stretch cheap steps' budgets too.

### D4 — `SessionClient.abort(sessionID)` + best-effort call in `reap()`

Port gains `abort(sessionID: string): Promise<void>` with no-op-success
semantics for missing/finished sessions. The opencode adapter maps it to
the SDK's session abort endpoint. `Engine.reap()` calls abort (when
`active.sessionId` is set) *before* `concludeAndDispatch`, wrapped in
try/catch that only logs — conclusion must never be blocked by runner
unavailability. The runner-transport HTTP layer (daemon → runner plugin)
gains the matching route.

*Ordering rationale*: abort-then-conclude keeps the window in which an
aborted-but-unconcluded run exists tiny and harmless (reconcile would
re-reap); conclude-then-abort risks the daemon dying in between and the
orphan surviving — exactly the bug this change kills.

## Risks / Trade-offs

- [Log spam keeps a genuinely stuck run alive] A session stuck in a
  provider retry loop can emit periodic retry noise that counts as
  activity → mitigated by the fact that opencode surfaces provider
  retries as session status `retry` without run-log appends; if a runtime
  does emit heartbeat-ish logs, the step's `ttlMs` still bounds nothing —
  accepted for now, revisit if observed.
- [Write amplification on `run`] Every log append now also updates one
  column on one row by PK — negligible against the log insert itself.
- [Abort races a genuine report] The agent may report success in the same
  instant the reaper decides to abort → the existing conclude-once
  guard (`concludeAndDispatch` conflict handling) already makes the loser
  a no-op; abort of a finished session is a no-op by contract.
- [Runner without abort support] Future runners might not implement
  abort → the port contract makes failure non-blocking; the reap
  proceeds, the orphan risk is that runner's documented limitation.

## Migration Plan

1. Migration adds `time_last_activity` with backfill
   `UPDATE run SET time_last_activity = time_started`.
2. Engine + store + port + adapter land together (single change); the
   runner plugin ships the new abort route in the same release — daemon
   tolerates a missing route (abort failure = logged, non-blocking).
3. Rollback: revert the code; the extra column is inert.

## Open Questions

- Should nudges themselves count as activity (they extend the window of a
  session that ignores them)? Current answer: yes, they count (the nudge
  budget, not the TTL, is the guard on that path) — flip to "no" if a
  pathological ignore-nudges loop shows up in practice.
