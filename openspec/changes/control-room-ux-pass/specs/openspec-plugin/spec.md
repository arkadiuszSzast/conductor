## ADDED Requirements

### Requirement: The panel shows which changes already have a live run

The plugin SHALL expose `GET /runs`, which reads the project's live features
(`running`, `waiting_human`, `escalated`, `paused`) through the daemon's
public feature list and maps each feature whose `change_slug` or `change`
input names a change to `{featureId, status, jobId, stepId}`, where the job
is the feature's running job, else a ready one, else a failed one; the most
recently updated feature wins. For a change with a live run the panel SHALL
show the run's status and `job › step`, SHALL NOT offer Start work or Queue,
and SHALL offer **Show run**, which sends the bridge `navigate` message with
`to: {feature, job}`. The panel SHALL refresh its listing, queue and runs
while visible at least every 15 seconds, when it becomes visible again, and
when the host sends `context-changed`, without collapsing an expanded change.

#### Scenario: A running change offers Show run

- **WHEN** a live feature started with `change_slug: retry-policy` is running
  job `impl` at step `implement`
- **THEN** the `retry-policy` tile shows `impl › implement` and a Show run
  button, and no Start work button

#### Scenario: Show run lands on the active job

- **WHEN** the operator clicks Show run
- **THEN** the Control Room opens the feature with job `impl` selected

#### Scenario: Idle changes are unaffected

- **WHEN** no live feature delivers change `todo-filtering`
- **THEN** its tile offers Start work (and Queue when the queue is available)
