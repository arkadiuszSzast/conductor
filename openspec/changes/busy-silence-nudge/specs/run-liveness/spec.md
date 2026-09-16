# run-liveness Specification (delta)

## ADDED Requirements

### Requirement: A busy session that has gone silent is nudged on the shared budget

When an agent run's session reports `busy` or `retry` but the run's last
observed activity is older than the busy-silence threshold
(`busySilenceNudgeMs`, engine option, default 10 minutes), the engine
SHALL treat the run as suspect and nudge the session — the same prompt
protocol and the same per-run nudge budget as idle nudges. The nudge
SHALL count as run activity, so one nudge opens a fresh busy-silence
window; a session that resumes observable work after a nudge SHALL NOT
be nudged again until it goes silent past the threshold anew. A run
whose nudge budget is exhausted and which is STILL silent past the
threshold SHALL be reaped through the normal reap path (timeout
failure class, session abort, retry/onFail routing) without waiting for
the TTL.

The busy-silence threshold SHALL be strictly smaller in effect than the
governing TTL for the run (a step whose `ttlMs` is at or below
`busySilenceNudgeMs` simply reaps on TTL first — busy-silence nudging
never extends any TTL). Waiting-for-answer runs (pending question) are
exempt, as they are from idle nudging.

#### Scenario: Cut stream is nudged at the minutes scale

- **WHEN** an agent run's session reports `busy` with no observed
  activity for longer than `busySilenceNudgeMs` and the run has nudges
  left in its budget
- **THEN** the reconcile pass nudges the session with the interrupted-
  turn prompt naming the step and run id, increments the nudge counter,
  and the nudge itself counts as activity

#### Scenario: Productive busy session is never nudged

- **WHEN** an agent run's session reports `busy` and its last activity
  (log appends) is within the busy-silence threshold
- **THEN** the reconcile pass does not nudge

#### Scenario: Exhausted budget reaps well before the TTL

- **WHEN** a busy-silent run has already consumed its whole nudge budget
  and stays silent past the threshold again
- **THEN** the run is reaped with a timeout failure envelope, its
  session is aborted, and the step's normal retry/onFail routing applies

#### Scenario: Recovery-after-nudge resets the window

- **WHEN** a nudged session resumes work and its logs advance the
  activity clock
- **THEN** no further nudge occurs until silence exceeds the threshold
  again, and the nudge counter is NOT reset (the budget is per run)
