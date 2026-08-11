# run-logs — per-run log capture, storage and serving

## Purpose

Gives every run a durable, bounded, per-run narrative log — command output,
action-host chatter, agent session transcripts and step-author custom lines —
stored in SQLite, served over a cursor-incremental read endpoint, appended
through one authenticated write endpoint, and surfaced live via a throttled,
payload-free SSE invalidation kind.

## ADDED Requirements

### Requirement: Per-run append-only log storage with monotonic cursor

The system SHALL store log lines per run with a monotonic per-run sequence
number, a capture timestamp, a source label and the text chunk. Sequence
numbers within a run SHALL be strictly increasing in append order and
SHALL never be reused, so a client holding a cursor never sees a line
twice or misses a line appended after its cursor. A batch of lines
appended together SHALL be persisted atomically (all lines or none).

#### Scenario: Round-trip append and read

- **WHEN** three lines are appended to a run's log and the run's log is
  read from the start
- **THEN** the same three lines come back in append order, each carrying
  its sequence number, timestamp and source

#### Scenario: Sequence numbers are monotonic across batches

- **WHEN** two batches are appended to the same run in succession
- **THEN** every line of the second batch has a sequence number greater
  than every line of the first batch

#### Scenario: Batch append is atomic

- **WHEN** persisting one line of a multi-line batch fails
- **THEN** none of the batch's lines are visible in the run's log

### Requirement: Per-run size cap enforced at write

The system SHALL enforce a per-run size cap (2 MB of chunk text) at write
time by dropping the oldest lines first — the tail of the log always
survives. Appends SHALL never fail because the cap was reached, and the
cap SHALL never block conclusion of the run. Retention beyond the per-run
cap (pruning terminal features, retention windows) is out of scope for
this capability version.

#### Scenario: Cap drops oldest lines, keeps the tail

- **WHEN** appends exceed the per-run cap
- **THEN** the oldest lines are removed until the run's log fits the cap
- **AND** the most recently appended lines remain readable

### Requirement: Cursor-incremental log read endpoint

The API SHALL expose `GET /v1/runs/:id/logs?after=<seq>&limit=<n>`
(bearer-authenticated like every other route) returning
`{lines: [{seq, time, source, text}], nextSeq, truncated}`. `after`
returns only lines with a sequence number strictly greater than the
cursor; `limit` bounds the page (server default 500, hard maximum 2000).
`truncated` SHALL be true when more lines exist beyond the returned page,
so a client can tail by refetching with `after=nextSeq`. An unknown run
SHALL yield 404 in the standard error envelope. Log lines SHALL NOT
appear in any feature or run payload — this endpoint is the only way to
read them.

#### Scenario: Tailing with a cursor

- **WHEN** a client reads a run's log, then more lines are appended, then
  the client refetches with `after` set to the previous response's
  `nextSeq`
- **THEN** the second response contains exactly the lines appended after
  the first read

#### Scenario: Limit is bounded

- **WHEN** a client requests a limit above the hard maximum
- **THEN** the response returns at most the hard maximum number of lines
  and sets `truncated` accordingly

#### Scenario: Unknown run

- **WHEN** a client reads logs for a run id that does not exist
- **THEN** the API responds 404 with the standard error envelope

### Requirement: Log write endpoint for runners and step authors

The API SHALL expose `POST /v1/runs/:id/logs` accepting
`{lines: [{text, source?}]}` (bearer-authenticated). `source` defaults to
`"step"`; the only values accepted on this route are `"step"` and
`"agent"` — any other value SHALL be rejected as invalid. Appends to a
run that is not `running` SHALL be rejected with 409 (consistent with the
report route's already-concluded semantics). An unknown run SHALL yield
404.

#### Scenario: Step author appends custom lines

- **WHEN** a client POSTs `{lines: [{text: "checkpoint"}]}` for a running
  run
- **THEN** the line is appended with source `"step"` and becomes readable
  via the log read endpoint

#### Scenario: Runner pushes agent chunks

- **WHEN** a runner POSTs a batch of `{text, source: "agent"}` lines for
  a running run
- **THEN** all lines of the batch are appended atomically with source
  `"agent"`

#### Scenario: Invalid source is rejected

- **WHEN** a client POSTs a line with `source: "process"`
- **THEN** the API responds 400 with the standard error envelope

#### Scenario: Concluded run rejects appends

- **WHEN** a client POSTs lines for a run that already concluded
- **THEN** the API responds 409 with the standard error envelope

### Requirement: Command step output is captured to the run log

When a command step's processes settle, the engine SHALL persist the
chronologically interleaved stdout/stderr capture to the run's log with
source `"process"`. On failure the existing behaviour — the tail of the
output landing in the run's `reason` — SHALL be preserved unchanged; the
log supplements the reason, it does not replace it.

#### Scenario: Successful command output is no longer discarded

- **WHEN** a command step succeeds with output on stdout/stderr
- **THEN** the interleaved output is readable from the run's log with
  source `"process"`

#### Scenario: Failed command keeps its reason and gains a log

- **WHEN** a command step fails with output
- **THEN** the run's `reason` carries the output tail exactly as before
- **AND** the run's log carries the interleaved output with source
  `"process"`

### Requirement: Action executions log through an injected port

The action host SHALL expose a logger to action executions that writes
chunks to the executing run's log with source `"action"` through an
injected port — an action handler SHALL NOT write to the store directly.

#### Scenario: Action log lines land in the run log

- **WHEN** an action handler writes through its logger during execution
- **THEN** the text is readable from that run's log with source
  `"action"`

### Requirement: Agent session output reaches the run log via runner push

The opencode runner SHALL observe its sessions' streamed output and push
it to the daemon's log write endpoint as `source: "agent"` lines for the
session's run, batched and debounced on the runner side so a chatty
session does not produce one HTTP request per token. Log push SHALL be
best-effort: a failed push MUST NOT fail, block or conclude the run.
Because each attempt and rerun round is its own run, agent logs are
naturally scoped per attempt.

#### Scenario: Agent output is tailable during a run

- **WHEN** an agent session emits output while its run is running
- **THEN** the daemon's log read endpoint eventually returns that output
  as `"agent"` lines for the run

#### Scenario: Push failure never breaks the run

- **WHEN** the daemon is unreachable while the runner tries to push log
  lines
- **THEN** the session and its run continue unaffected

### Requirement: Throttled run_log change notifications

The store's change notification SHALL gain kind `"run_log"` carrying only
`{kind, featureId}` — payload-free like every other kind, fanned out on
the existing SSE stream. Emission SHALL be throttled at the source per
run: within one throttle window (1 second), successive appends to the
same run coalesce into at most one notification, so a chatty producer
cannot flood SSE subscribers. Appends themselves are never delayed by
throttling — only the notification is coalesced.

#### Scenario: SSE clients are notified of log activity

- **WHEN** lines are appended to a running run's log
- **THEN** SSE subscribers receive a `{kind: "run_log", featureId}` event

#### Scenario: Rapid appends coalesce

- **WHEN** many appends land on one run within a single throttle window
- **THEN** subscribers receive at most one `run_log` notification for
  that window
- **AND** an append after the window elapses produces a new notification
