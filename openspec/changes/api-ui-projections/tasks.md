# Tasks — api-ui-projections

- [x] 1. [db] Store: record-shaped feature reads — `FeatureRecord = {state, createdAt, updatedAt}` via `getFeatureRecord(id)` and `listFeatureRecords(filter)` reading `time_created`/`time_updated` from the same row; add `statuses` filter clause to the list query
- [x] 2. [db] Store: `countFindingsByStatus(featureIds)` — one `GROUP BY feature_id, status` query returning zero-fillable counts
- [x] 3. [db] Store: `getTransitions` parses `event` into a `PipelineEvent` object (`TransitionEntry.event` type change)
- [x] 4. [test] Store tests: timestamps on record reads, statuses filter, grouped finding counts (incl. zero case), parsed timeline events
- [x] 5. [server] API: feature list projection — `createdAt`/`updatedAt`, `findingCounts`, `?status=` validation (unknown → 400 `invalid_request`), keep `{status, currentStep}` job summary
- [x] 6. [server] API: feature detail projection — `createdAt`/`updatedAt`, full `JobRuntime` with step outputs truncated at 500 chars (`truncated: true` + newest `runId` per truncated step), `workflowRef: {name, stale}` via workflow status lookup
- [x] 7. [server] API: `GET /v1/projects/workflow?dir=` — structure-only projection from `WorkflowStatus` (`name`, `stale`, `jobs.{needs, steps[{id, kind}]}`, `diagnostics`); unregistered → 404, invalid → 409 with diagnostics, missing `dir` → 400; add `workflowStatus` to `ApiDeps` and wire `registry.getStatus` at composition sites
- [x] 8. [server] API: optional static UI serving — `ApiConfig.ui?: {staticDir}`; GET/HEAD non-`/v1` paths served from the directory with extension Content-Type, `index.html` fallback, normalize+prefix traversal guard, `/v1/*` precedence, no CORS headers; absent config → today's behaviour
- [x] 9. [test] API tests: list/detail timestamps; full detail with truncation pointer; status filter happy + 400; findingCounts incl. zeros; timeline object events; workflow endpoint valid/stale/invalid/unregistered + no prompts/expressions in response; static serving configured/unconfigured/traversal/`/v1` precedence
- [x] 10. [docs] Update the API surface documentation in `docs/` (new route, projection fields, `ui.staticDir`, no-CORS decision)
- [x] 11. [review] `bun test && bun run typecheck && bun run lint && openspec validate api-ui-projections`; confirm no `@conductor/core` diffs and `docs/design/web-ui/` untouched
