# api — UI-facing HTTP projections

## Purpose

Defines the projection contract the daemon's HTTP API v1 offers to UIs and
other read-heavy clients: what feature list/detail payloads contain, how the
workflow structure of a project is exposed, how a browser SPA reaches the API,
and how list-level filters and counts behave. The API remains a pure
projection over the store and workflow registry — nothing here changes
engine or interpreter semantics.

## ADDED Requirements

### Requirement: Feature projections carry store timestamps

Every feature payload (list items and detail) SHALL include `createdAt` and
`updatedAt` as epoch-millisecond numbers sourced from the store's persisted
row metadata. The core interpreter state shape SHALL NOT gain time fields —
timestamps are store metadata returned alongside the state.

#### Scenario: List items include timestamps

- **WHEN** a client requests `GET /v1/features`
- **THEN** each returned feature includes numeric `createdAt` and `updatedAt`
  fields matching the row's creation and last-update times

#### Scenario: Detail includes timestamps

- **WHEN** a client requests `GET /v1/features/:id`
- **THEN** the feature payload includes numeric `createdAt` and `updatedAt`
- **AND** `updatedAt` is greater than or equal to `createdAt` after any
  transition has been applied

### Requirement: Feature detail exposes full per-step runtime

The feature **detail** payload (`GET /v1/features/:id`) SHALL return the
full per-job runtime: job `status`, `currentStep`, `attempts`, `reruns`,
job `outputs`, and `steps` with per-step `status` and outputs. The feature
**list** payload SHALL keep the `{status, currentStep}` per-job summary.

Step outputs in the detail payload SHALL be bounded: any output value longer
than the truncation limit is cut and marked, and the step carries the id of
its newest run (when one exists) so the full output remains retrievable via
`GET /v1/runs/:id`.

#### Scenario: Detail shows per-step status

- **WHEN** a feature has a job whose first step succeeded and whose second
  step is running
- **THEN** `GET /v1/features/:id` returns that job with
  `steps.<first>.status = "succeeded"` and `steps.<second>.status = "running"`
- **AND** the job's `attempts` and `reruns` counters are present

#### Scenario: Oversized step output is truncated with a pointer to the run

- **WHEN** a step reported an output value longer than the truncation limit
- **THEN** the detail payload returns the value cut to the limit with a
  truncation marker set
- **AND** the step projection includes the `runId` of the newest run for
  that step so the client can fetch the full output from `GET /v1/runs/:id`

#### Scenario: List keeps the summary shape

- **WHEN** a client requests `GET /v1/features`
- **THEN** each feature's `jobs` map contains only `{status, currentStep}`
  per job

### Requirement: Project workflow structure endpoint

The API SHALL expose `GET /v1/projects/workflow?dir=<projectDir>` returning a
structure-only projection of the project's registered workflow: workflow
`name`, a `stale` flag (true when the served snapshot survived a failed
reload), per-job `needs` edges and ordered `steps` as `{id, kind}` pairs
(`kind` one of `agent`/`command`/`action`/`human`), and `diagnostics` (empty
unless stale). The response SHALL NOT contain prompts, expressions, `with:`
payloads, retry policies, or any other workflow authoring content.

An unregistered project SHALL yield 404. A registered project with no valid
snapshot (invalid) SHALL yield 409 with the load diagnostics in the error
message. A missing or empty `dir` parameter SHALL yield 400.

#### Scenario: Valid project returns its structure

- **WHEN** a project with a valid `conductor.yaml` is registered and a client
  requests `GET /v1/projects/workflow?dir=<projectDir>`
- **THEN** the response is 200 with `name`, `stale: false`, empty
  `diagnostics`, and each job's `needs` and ordered `steps` `{id, kind}`

#### Scenario: Stale project serves the last valid structure with diagnostics

- **WHEN** a project's `conductor.yaml` was edited into an invalid state
  after a successful load and reloaded
- **THEN** the endpoint returns 200 with the last valid structure,
  `stale: true`, and the reload diagnostics

#### Scenario: Invalid project is a conflict with diagnostics

- **WHEN** a registered project has never produced a valid workflow load
- **THEN** the endpoint returns 409 and the error message carries the load
  diagnostics

#### Scenario: Unregistered project is not found

- **WHEN** the `dir` parameter names a directory that was never registered
- **THEN** the endpoint returns 404

#### Scenario: Structure only — no authoring content

- **WHEN** the workflow contains agent prompts, command scripts, and action
  `with:` payloads
- **THEN** none of those strings appear anywhere in the endpoint's response

### Requirement: Feature detail carries a workflow reference

The feature detail payload SHALL include `workflowRef: {name, stale}` — the
name of the workflow the project currently resolves to and whether that
snapshot is stale — as a lightweight hint. `workflowRef` SHALL be null when
the project has no resolvable workflow. Full structure comes from the
project-scoped endpoint, never from the feature payload.

#### Scenario: Detail hints at the resolved workflow

- **WHEN** a feature's project has a valid registered workflow
- **THEN** `GET /v1/features/:id` includes
  `workflowRef: {name: <workflow name>, stale: false}`

### Requirement: Optional static UI serving

The API SHALL optionally serve a built SPA from an explicitly configured
directory. When the configuration is absent, behaviour SHALL be identical to
an API without the capability. There SHALL be no default directory — the
path is never inferred from the package location or a home directory.

When configured: `GET` requests for paths outside `/v1` are served from the
directory with `Content-Type` derived from the file extension; requests for
paths that do not match a file fall back to `index.html` (SPA routing);
`/v1/*` routes always take precedence; path traversal outside the configured
directory SHALL be rejected. The API SHALL NOT emit CORS headers — the SPA
is same-origin by construction.

#### Scenario: Configured directory serves the app shell and assets

- **WHEN** `ui.staticDir` is configured and the directory contains
  `index.html` and `assets/app.js`
- **THEN** `GET /` returns the `index.html` content as `text/html`
- **AND** `GET /assets/app.js` returns the file with a JavaScript content
  type

#### Scenario: Client-side routes fall back to index.html

- **WHEN** `ui.staticDir` is configured and a client requests
  `GET /features/abc` (no such file)
- **THEN** the response is the `index.html` content

#### Scenario: API routes take precedence

- **WHEN** `ui.staticDir` is configured
- **THEN** `GET /v1/features` is handled by the API, not the static layer,
  and an unknown `/v1/...` path returns the API's JSON 404 error envelope

#### Scenario: Path traversal is rejected

- **WHEN** a client requests a path that resolves outside the configured
  directory (e.g. `/../secret`)
- **THEN** the file is not served

#### Scenario: Unconfigured API is unchanged

- **WHEN** no `ui` configuration is provided
- **THEN** `GET /` returns the API's JSON 404 error envelope exactly as
  before

### Requirement: Feature list status filter

`GET /v1/features` SHALL accept a `status` query parameter as a
comma-separated list of feature statuses and return only features whose
status is in the list. Values SHALL be validated against the feature status
vocabulary; any unknown value SHALL yield 400 with the invalid-request error
envelope. The filter composes with the existing `project` and `active`
filters.

#### Scenario: Filtering by two statuses

- **WHEN** features exist with statuses `running`, `done` and
  `waiting_human` and a client requests
  `GET /v1/features?status=waiting_human,done`
- **THEN** only the `waiting_human` and `done` features are returned

#### Scenario: Unknown status value is a client error

- **WHEN** a client requests `GET /v1/features?status=bogus`
- **THEN** the response is 400 with the `invalid_request` error code

### Requirement: Feature list carries finding counts

Each feature list item SHALL include
`findingCounts: {new, fixed, dismissed, reopened}` — the number of findings
per lifecycle status. The counts SHALL be computed by a single grouped query
across the listed features, not per-feature lookups. A feature with no
findings SHALL report zeros.

#### Scenario: Counts reflect finding statuses

- **WHEN** a feature has two findings with status `new` and one with status
  `fixed`
- **THEN** its list item reports
  `findingCounts: {new: 2, fixed: 1, dismissed: 0, reopened: 0}`

#### Scenario: No findings means zeros

- **WHEN** a feature has no findings
- **THEN** its list item reports all four counts as 0

### Requirement: Timeline events are structured objects

`GET /v1/features/:id/timeline` SHALL return each entry's `event` as a
parsed JSON object (the pipeline event shape), consistent with the
already-object-shaped `decisions`. The string-encoded form SHALL NOT be
served.

#### Scenario: Event arrives as an object

- **WHEN** a feature has transitioned via a `feature.start` event
- **THEN** the timeline entry's `event` is an object with
  `kind: "feature.start"`, not a JSON-encoded string
