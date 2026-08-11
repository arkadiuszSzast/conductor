# Run logs: capture, store, serve (GAP-11) + feedback snapshot in feature detail (GAP-12)

## Why

The Control Room UI's step inspector has outputs but no narrative: command
steps' interleaved stdout/stderr is captured by the process runner and then
discarded on success, agent sessions live entirely inside the opencode
runner where the daemon never sees their output, and step authors have no
way to append custom log lines. Separately, the UI cannot draw the rerun
loop edge precisely because the engine's persisted feedback snapshot
(`Store.getFeedback`) is never projected into any API payload. Both gaps
were verified against the code in the web-UI design handoff
(`docs/design/web-ui/02-api-extensions-request.md`, GAP-11/GAP-12); all the
missing data either already exists (feedback, command output) or has an
obvious capture point (agent transcript via runner push, action-host
logger).

## What Changes

- **GAP-12** — The feature **detail** payload (`GET /v1/features/:id`)
  gains `feedback`, straight from `store.getFeedback` (null when absent).
  Not on the list payload. The lifecycle is documented per the actual code
  semantics: `applyTransition` writes the column only when
  `transition.feedback !== undefined` and never clears it — after the
  first rerun the snapshot persists for the feature's lifetime; a later
  rerun replaces it.
- **GAP-11 storage** — New append-only `run_log` table (migration
  `0011_run_log`): `(run_id, seq, time, source, chunk)` with a monotonic
  per-run `seq` and a 2 MB per-run cap enforced at write time
  (drop-oldest, the tail survives). Retention beyond the per-run cap
  (pruning on feature terminal state, retention windows) is **consciously
  out of scope** for this change.
- **GAP-11 capture** — Command steps persist the interleaved output the
  engine already receives from `ProcessRunner` as `source: "process"` (one
  write per command on settle; the existing failure `reason` behaviour is
  unchanged — logs supplement it, never replace it). The action host gains
  an injected run-log port so action executions write `source: "action"`
  chunks. Agent sessions stream through the runner: the opencode plugin
  subscribes to session message-part events and pushes batched
  `source: "agent"` chunks to the daemon.
- **GAP-11 read/write API** —
  `GET /v1/runs/:id/logs?after=<seq>&limit=<n>` returns
  `{lines: [{seq, time, source, text}], nextSeq, truncated}` for
  cursor-incremental tailing. `POST /v1/runs/:id/logs {lines: [{text,
  source?}]}` appends lines (default source `step`, allowed `step|agent`),
  rejected with 409 once the run is no longer running — this one route
  serves both step authors' custom logs and the runner's agent push.
- **GAP-11 live updates** — `StoreChange.kind` extends with `"run_log"`
  (payload-free `{kind, featureId}` like every other kind). Emission is
  throttled at the source (per run, one emission per window) so chatty
  producers cannot flood SSE; the API stays a plain fan-out.

Invariants preserved: logs never enter feature/run payloads; SSE stays a
payload-free invalidation stream; the interpreter stays pure (logging is
engine/runner/action-host I/O); no unbounded growth (per-run cap at
write); no opencode SDK import outside `packages/runner-opencode`;
migrations stay append-only.

## Capabilities

### New Capabilities

- `run-logs`: per-run log capture, storage, serving and live-tail
  invalidation — the `run_log` store contract (append, cursor reads, cap,
  throttled change emission), the capture paths (process, action, agent
  via runner push, step-author custom lines), and the two `/v1/runs/:id/logs`
  routes.

### Modified Capabilities

- `api`: the feature detail projection gains the `feedback` snapshot
  (detail only, straight from the store, null when absent).

## Impact

- `packages/server/src/migrations.ts` — append migration `0011_run_log`.
- `packages/server/src/store.ts` — `appendRunLog`/`getRunLog`, the
  `run_log` StoreChange kind with per-run throttled emission.
- `packages/server/src/engine.ts` — command-step output persisted to the
  run log; action-host wiring gains the log port.
- `packages/server/src/action-host.ts` — injected run-log writer exposed
  to action executions as a logger.
- `packages/server/src/api.ts` — `feedback` in the detail payload,
  `GET`/`POST /v1/runs/:id/logs` routes.
- `packages/runner-opencode/src/` — plugin `event` hook subscribing to
  message-part updates, batched debounced push to the daemon's log route.
- `packages/cli/src/client.ts` — typed client methods for the log routes.
- `docs/http-api.md` — new routes, `feedback` lifecycle documentation.
- No `@conductor/core` changes; error envelope unchanged; no changes to
  the other active OpenSpec changes.
