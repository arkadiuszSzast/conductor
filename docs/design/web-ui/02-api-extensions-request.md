# API extensions request — step logs & loop feedback

Handoff spec for the server-side agent. Two extensions the Control Room UI
(variant A, chosen) needs; written against the current code
(`packages/server/src`, post-PR #23). GAP numbering continues
`01-api-gaps.md`.

---

## GAP-12 — expose the rerun feedback snapshot in feature detail — SMALL, DO FIRST

### Why the UI needs it

The graph draws a rerun back-edge (review ⟲ implement) **only while the
loop is in flight** — i.e. when a rerun target job is the currently active
one. To do that precisely the UI must know, for the most recent rerun:
which job routed it, which jobs were reset, and why. All of that is the
**feedback snapshot** the engine already persists.

### Current state (verified)

- `feature.feedback` column exists; `Store.getFeedback(id)` returns
  `Feedback | null` = `{jobs: {jobId: {stepId: {name: value}}}, message}`.
- `featurePayload()` in `api.ts` does NOT include it. Timeline lets the UI
  approximate (a `changes_requested` outcome followed by re-execution),
  but multi-target job-scope reruns and the routing-step identity are
  ambiguous from decisions alone.

### Requested change

- Add `feedback` to the **detail** payload (`GET /v1/features/:id`), value
  straight from `store.getFeedback` (null when absent). Not on the list
  payload.
- Document the lifecycle in `docs/http-api.md`: when the column is set
  (rerun transition) and when it is overwritten/cleared — the UI treats
  "a feedback target job is active again" as "loop in flight", so exact
  clearing semantics matter and should be stated, not guessed.

### UI consumption (for context)

Edge = `routing job → each job in feedback.jobs` (minus the routing job),
drawn only while such a target is `running`/`ready` with `reruns > 0`;
label = `feedback.message`. After the round completes the edge disappears;
a quiet `round N` chip (from `JobRuntime.reruns`, already exposed) remains.

---

## GAP-11 — run logs: capture, store, serve, tail — THE REAL WORK

### Why the UI needs it

Clicking a step in the workflow graph opens a step inspector. Outputs are
already served (step outputs + `runId` → `GET /v1/runs/:id`). What is
missing entirely is the **narrative**: what the step is doing / did.
Requirements from the operator:

1. `agent` steps: session log — live tail while running, full history
   after completion.
2. `command` steps: interleaved stdout/stderr.
3. Any step author can append custom log lines.
4. Logs are per **run**, so retries (`attempt` 1..n) and rerun rounds each
   have their own log.

### Current state (verified)

- `process.ts` already captures chronologically-interleaved
  stdout/stderr (`result.output`) — but `engine.ts` discards it on
  success (only `$CONDUCTOR_OUTPUT` pairs persist; on failure the last
  4000 chars land in `run.reason`).
- `SessionClient` (`ports.ts`: createSession/prompt/sessionExists/status/
  note) has **no transcript capability** — the opencode runner holds the
  session, the daemon never sees agent output.
- No log table, no log routes, SSE kinds are
  `feature|transition|run|finding`.

### Requested design (adjust as the code dictates; keep the invariants)

**Storage** — new `run_log` table: `(run_id, seq INTEGER, time INTEGER,
source TEXT, chunk TEXT)`, append-only, monotonic `seq` per run; size cap
per run (suggest 2 MB, drop oldest — keep the tail) enforced at write.
SQLite stays the source of truth (product commitment).

**Capture paths**

- `command`: persist the interleaved capture the engine already has —
  ideally streamed in chunks during execution (live tail for long
  commands), acceptable MVP: one write on settle. `source: "process"`.
- `agent`: extend the runner protocol. Preferred: **runner pushes** log
  chunks to the daemon (`POST /v1/runs/:id/logs`, same auth style as
  `/report`) — gives live tail and keeps the daemon passive. Alternative
  MVP: `SessionClient.transcript(sessionID)` pull on completion (no live
  tail for agents). `source: "agent"`.
- custom: the same `POST /v1/runs/:id/logs` accepts
  `{lines: [{text, source?}]}` from step authors/tools. For `command`
  steps optionally mirror the outputs mechanism: append-only
  `$CONDUCTOR_LOG` file picked up by the engine. `source: "step"`.
- `action`: actions run in-daemon; give the action host a logger that
  writes `source: "action"` chunks.

**Read API** — `GET /v1/runs/:id/logs?after=<seq>&limit=<n>` →
`{lines: [{seq, time, source, text}], nextSeq, truncated: bool}`.
Cursor-incremental so the UI can tail by refetching `after=nextSeq`.

**Live updates** — extend `StoreChange` with `{kind: "run_log",
featureId}` (payload-free, consistent with the invalidation model;
throttle emission, e.g. ≥1/s per run, so chatty commands do not flood
SSE). UI reaction: if the inspector is open on that feature's active run,
refetch the tail.

**Invariants to preserve**

- Logs never enter feature/run payloads (fetch on demand only).
- SSE stays payload-free invalidation.
- Interpreter stays pure — logging is engine/runner I/O.
- No unbounded growth: per-run cap + (suggested) prune on feature
  terminal state or a retention window.

**Out of scope** — log search, cross-run aggregation, ANSI rendering
(UI strips/renders client-side).

---

## Suggested delivery order

1. GAP-12 (one projection line + doc note) — unblocks the loop-edge rule.
2. GAP-11 storage + command capture + read endpoint (no runner change) —
   unblocks the inspector for command/action steps.
3. GAP-11 runner push + live tail + SSE kind — completes agent logs.
