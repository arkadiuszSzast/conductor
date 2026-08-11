# Design — api-ui-projections

## Context

See `proposal.md` for motivation. Current state: `api.ts` projects
`store.getFeature()`/`listFeatures()` (both return only the parsed state
blob), overwrites `jobs` with a summary on both list and detail, has no
workflow route, no static serving, no status filter, and serves the raw
`event` column string on the timeline. `WorkflowRegistry` already has
`resolve` (last valid snapshot) and `getStatus` (valid/stale/invalid/
unregistered + diagnostics); `ApiDeps` currently receives only the
`resolveWorkflow` resolver. The `feature` table already has
`time_created`/`time_updated`; `finding` already has `status`.

## Goals / Non-Goals

**Goals:**
- All effects flow through existing ports/DI; API stays a pure projection.
- One store round-trip per new datum where the shape allows it (grouped
  finding counts; timestamps read with the same row fetch).

**Non-Goals:**
- No `@conductor/core` changes, no engine/interpreter changes, no
  migrations, no SSE changes, no CORS, no pagination, no `activeRun` on
  list items.

## Decisions

- **Timestamps via `FeatureRecord`, not core state.** The store gains
  record-shaped reads returning `{state, createdAt, updatedAt}` from the
  same row the state blob comes from (`getFeatureRecord`,
  `listFeatureRecords`). Existing `getFeature`/`listFeatures` remain for
  engine callers. Alternative — adding fields to `FeatureState` — rejected:
  the interpreter would then own data it never writes.
- **Detail projection returns `JobRuntime` verbatim except step outputs.**
  Truncation limit 500 chars per output value; a truncated value carries
  `truncated: true` on the step projection and the newest `runId` for the
  step (from the runs already fetched once per detail request). Full
  output stays reachable via `GET /v1/runs/:id`. Alternative — full outputs
  in detail — rejected: unbounded payloads for log-like outputs.
- **Workflow structure is project-scoped** (`GET /v1/projects/workflow?dir=`)
  because the registry snapshot belongs to the project; a feature only gets
  a `workflowRef: {name, stale}` hint resolved through the same lookup.
  `ApiDeps` gains `workflowStatus: (projectDir) => WorkflowStatus` (the
  registry's `getStatus`), which also answers stale/invalid with
  diagnostics. Alternative — feature-scoped route per the gap doc —
  rejected: it would imply per-feature snapshots that do not exist.
- **Status mapping for the workflow route:** `unregistered` → 404,
  `invalid` → 409 (`conflict`) with diagnostics joined into the message,
  `valid`/`stale` → 200 with `stale` flag and diagnostics array. 409 (not
  422) because the project is registered but its current file is unusable —
  a state conflict, not a request error.
- **Static serving inside the API handler**, after `/v1` routing misses and
  only for `GET`/`HEAD`: resolve the requested path against
  `ui.staticDir`, `path.normalize` + prefix check against the resolved
  root to block traversal, extension→Content-Type map for the common web
  asset types, fallback to `index.html` when the path has no matching
  file. No directory listing. Absent config → the current 404 JSON
  envelope. Alternative — separate Bun.serve static config — rejected:
  the handler must stay a plain testable function.
- **Status filter parsing** validates each comma token against the
  `FeatureStatus` union; the store gains a `statuses` filter clause
  (`status IN (...)`) composing with the existing clauses.
- **Finding counts** come from one
  `SELECT feature_id, status, COUNT(*) ... GROUP BY feature_id, status`
  over the listed feature ids, zero-filled in the projection.
- **Timeline** parses `event` in `store.getTransitions` (type
  `TransitionEntry.event: PipelineEvent`) — the write side already
  guarantees valid JSON.

## Risks / Trade-offs

- [Detail payload grows with big DAGs] → outputs are the only unbounded
  part and they are truncated; jobs/steps counts are workflow-bounded.
- [Static file serving is a new attack surface] → GET/HEAD only,
  normalize+prefix check, no symlink escape beyond the resolved root check,
  no directory listing, opt-in config.
- [`workflowRef` reflects the *current* registry snapshot, which may
  differ from what an old feature started with] → carried `stale` flag and
  the documented phase-1 caveat from the gap analysis.

## Migration Plan

Additive API surface; greenfield — no compatibility shims. The timeline
`event` shape change is breaking for any hypothetical consumer, accepted
per the greenfield rule.
