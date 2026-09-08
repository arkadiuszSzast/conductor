# run-liveness Specification (delta)

## ADDED Requirements

### Requirement: TTL staleness is measured from last observed activity

The engine SHALL reap an agent run on TTL only when the time since the
run's **last observed activity** exceeds the governing TTL, not the time
since the run was dispatched. Observed activity SHALL include at minimum:
the run's dispatch, every accepted log append for the run, and every
accepted status/question/report interaction on the run. The activity
timestamp SHALL be durable — a daemon restart SHALL NOT reset it to
"now" for runs whose last activity predates the restart, and SHALL NOT
inherit the dispatch time when later activity was recorded.

The idle-session nudge path (nudge after idle debounce, reap after the
nudge budget) is unchanged — activity-aware TTL replaces only the
wall-clock-from-start reap.

#### Scenario: Productive long run is not reaped

- **WHEN** an agent run has been executing longer than the governing TTL
  but its last accepted log append is more recent than the TTL window
- **THEN** the reconcile pass does not reap the run

#### Scenario: Run gone dark is reaped after TTL of silence

- **WHEN** an agent run's last observed activity is older than the
  governing TTL and the session still reports busy
- **THEN** the reconcile pass reaps the run, recording a timeout failure
  whose reason names the silence duration, and the failure feeds the
  step's normal retry/onFail path

#### Scenario: Restart does not grant stale runs a fresh window

- **WHEN** the daemon restarts and a recovered run's last recorded
  activity is already older than the governing TTL
- **THEN** the next reconcile pass reaps the run instead of restarting
  the TTL window from the restart moment

### Requirement: Agent steps may override the engine TTL per step

An agent step SHALL accept an optional `ttlMs` field (positive integer,
milliseconds). When present, that value governs the step's runs instead
of the engine-wide TTL default; when absent, the engine-wide default
applies. Validation SHALL reject a non-positive or non-numeric `ttlMs`
at load time, naming the step. Non-agent steps SHALL NOT accept `ttlMs`
(command steps keep their existing `timeoutMs`).

#### Scenario: Step override governs its runs

- **WHEN** an agent step declares `ttlMs: 10800000` while the engine
  default is 3600000 and the run's activity gap is 2 hours
- **THEN** the run is not reaped, because the step's own TTL governs

#### Scenario: Invalid override is a load error

- **WHEN** a workflow declares `ttlMs: 0` or `ttlMs: "1h"` on an agent
  step
- **THEN** loading the workflow fails with an error naming the step and
  the constraint

### Requirement: Reaping a run aborts its session

When the engine reaps an agent run that has an associated session, it
SHALL instruct the runner to abort that session so the runtime stops
consuming resources for a run the engine has concluded. The runner
SHALL expose an abort operation that terminates the session's current
processing; aborting a session that is already finished or missing
SHALL be a no-op success. An abort failure SHALL be logged and SHALL
NOT prevent or delay the reap conclusion — the run concludes reaped
regardless.

#### Scenario: Orphan session is stopped on reap

- **WHEN** the engine reaps a run whose session is still busy
- **THEN** the runner receives an abort for that session and the session
  stops processing; no further inference happens on behalf of the
  reaped run

#### Scenario: Abort failure does not block the reap

- **WHEN** the abort call fails (runner unreachable, session unknown)
- **THEN** the run is still concluded as reaped with its failure
  envelope, and the abort failure appears in the daemon log

#### Scenario: Nudge-path reap also aborts

- **WHEN** a run is reaped through the idle-nudge path (idle after the
  nudge budget) rather than TTL
- **THEN** the session abort is issued the same way
