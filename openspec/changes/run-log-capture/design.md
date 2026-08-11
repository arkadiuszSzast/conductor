# Design — run-log-capture

## Context

See `proposal.md` — Why. The verified code state this builds on:

- `process.ts` already produces a chronologically interleaved
  stdout/stderr capture (`ProcessExecResult.output`, bounded at 256 KB);
  `engine.ts` discards it on success and puts `slice(-4000)` into
  `run.reason` on failure.
- `Store.getFeedback` exists; `featurePayload()` never projects it.
  `applyTransition` writes the `feedback` column only when
  `transition.feedback !== undefined` and never nulls it.
- `StoreChange.kind` is `feature|transition|run|finding`; the API's SSE
  stream is a plain fan-out of store notifications.
- The opencode plugin's `Hooks` surface includes an `event` hook that
  receives the full SDK event stream, including
  `message.part.updated {part, delta?}` — the plugin CAN observe agent
  output live without new SessionClient surface.
- Migrations are append-only; last id is `0010_run_pending_observation`.

## Goals / Non-Goals

**Goals**

- One storage/read/write/notify contract for run logs that every capture
  path (process, action, agent, step) shares.
- Live tail for agent and command output with bounded storage and bounded
  SSE chatter.
- Zero change to interpreter semantics, run conclusion semantics, or the
  error envelope.

**Non-Goals**

- Retention beyond the per-run cap (terminal-state pruning, windows).
- Log search, cross-run aggregation, ANSI handling.
- Streaming command output in chunks during execution (MVP is one write
  on settle; the ProcessRunner port is not rebuilt for streaming).
- `$CONDUCTOR_LOG` file pickup for command steps (the POST route covers
  custom lines; the file mechanism can come later without schema change).

## Decisions

### D1 — `run_log` table shape and cap enforcement

`run_log(run_id TEXT, seq INTEGER, time INTEGER, source TEXT, chunk
TEXT, PRIMARY KEY(run_id, seq))`, no AUTOINCREMENT: `seq` is computed as
`MAX(seq)+1` per run inside the append transaction — monotonic per run,
race-free because SQLite serializes writers. The 2 MB cap is enforced in
the same transaction: after insert, while `SUM(length(chunk)) > cap`,
delete the lowest-seq rows. Deleting old rows never renumbers — cursors
held by clients stay valid (they simply skip deleted seqs).

Alternative considered: global AUTOINCREMENT id + per-run ordering by
rowid. Rejected: per-run `seq` is the API's cursor contract; deriving it
at read time from rowid makes `nextSeq` unstable across VACUUM.

### D2 — throttled emission lives in the store append, not the API

`Store.appendRunLog` emits `{kind: "run_log", featureId}` at most once
per run per throttle window (1 s), tracked in an in-memory
`Map<runId, lastEmit>` with the clock injected via the store's existing
post-commit emit path. The API keeps fanning out every store change
untouched. Rationale: the invalidation contract says "notify after
durable" — coalescing at the producer keeps every subscriber (present and
future) protected without duplicating throttle logic per consumer.
In-memory throttle state is acceptable: after a restart the worst case is
one extra notification.

Trailing edge: a window with suppressed appends does NOT schedule a
deferred emission (no timers in the store). The UI's refetch-on-notify
plus the next append's emission make the gap at most one window for an
actively-logging run; a run's final state is covered by the `run`/
`transition` notifications its conclusion already emits.

### D3 — write route validates source to `step|agent` only

`process` and `action` are daemon-internal sources written through the
store directly by the engine/action host; allowing them over HTTP would
let any bearer-token holder forge daemon output. The POST route is for
out-of-process producers: step authors (`step`, default) and runners
(`agent`).

### D4 — agent capture: runner push via the plugin `event` hook

The SDK delivers `message.part.updated` (with `delta`) to plugins. The
runner adapter maintains a session→run map: the engine's step prompt
already carries `run ${runId}` in its header, but parsing prompts is
fragile — instead the hub records the mapping when the daemon creates
the step session… which the daemon does NOT tell the runner about today.
Options considered:

1. Extend the callback protocol's create-session body with `runId` —
   protocol change, daemon knows the runId only after `insertRun`, which
   happens before session creation, so it is available. **Chosen**: the
   daemon passes `runId` on `POST /v1/sessions` (optional field), the hub
   remembers `sessionID → runId`, the event hook routes
   `message.part.updated` parts for known sessions into a per-run buffer,
   flushed to `POST /v1/runs/:id/logs` on a 1 s debounce (and on session
   idle). Unknown sessions (parent sessions, unrelated user sessions) are
   simply not mapped and produce no push.
2. Parse the `[conductor] … run <id>` header out of prompt text in the
   plugin — no protocol change but couples the runner to prompt wording.
   Rejected.
3. `SessionClient.transcript()` pull at conclusion — no live tail.
   Rejected while option 1 is cheap; kept as documented fallback.

The `runId` field is optional end-to-end: a runner that ignores it still
works (no agent logs, nothing else breaks), preserving the minimal
runner contract.

Text parts streamed via `delta` are accumulated; the runner pushes
completed text chunks (part snapshots on update) rather than one line
per delta, and dedupes by part id + length so re-sent snapshots do not
duplicate content. Push errors are logged and dropped (best-effort).

### D5 — action-host logger is a port on the run context

`ActionHostDeps` gains `runLog(text: string): void` (per-execution,
bound to the run id by the engine's wiring). Handlers get it through
`ActionHostDeps` exactly like `log`. The engine builds it from
`store.appendRunLog(runId, [{source: "action", text}])`. Handlers never
see the store or the run id.

### D6 — GAP-12 is a pure projection

One line in `featurePayload()`: `feedback: store.getFeedback(featureId)`.
Documented lifecycle mirrors `applyTransition`'s actual behaviour
(write-only-on-rerun, never cleared, replaced by later reruns) — no code
change to the lifecycle itself.

## Risks / Trade-offs

- [Cap enforcement per append is O(deleted rows)] → deletes happen only
  when over cap, oldest-first by PK — indexed, incremental, bounded by
  the append size.
- [In-memory throttle map grows with active runs] → entries are cleaned
  opportunistically when the run stops appending; the map is bounded by
  concurrently-logging runs (small).
- [Runner push loses lines on daemon downtime] → accepted: logs are
  best-effort narrative, the outcome protocol (report) remains the
  authoritative channel and is unaffected.
- [409 on concluded runs races the runner's final flush] → accepted and
  by design: a late flush after conclusion is dropped with a 409 the
  runner treats as benign (logged, not retried).
- [`message.part.updated` shape drift across SDK versions] → the runner
  narrows structurally (same pattern as `RawOpencodeSessionApi`) and
  ignores unknown shapes — a drifted event yields no logs, never a crash.

## Migration Plan

Append migration `0011_run_log` (CREATE TABLE + index on
`(run_id, seq)` via the PK). No data backfill, no changes to existing
tables. Rollback = drop table (greenfield, no obligations).

## Open Questions

None — deferred items (retention, `$CONDUCTOR_LOG`, chunked command
streaming) are recorded as non-goals with no schema impact.
