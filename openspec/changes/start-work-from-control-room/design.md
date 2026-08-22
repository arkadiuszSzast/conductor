## Context

See `proposal.md` for motivation. Manual work already starts through `POST /v1/features`, which validates fixed feature metadata and delegates to `Engine.startFeature`. The engine resolves one registered workflow snapshot per project, creates durable SQLite state, and dispatches `feature.start`; the CLI and runner tools share this path.

The workflow IR already declares typed `inputs`, template evaluation already reads `FeatureState.input`, and the persisted state already contains that map. The missing pieces are transport-level input submission, canonical resolution/defaulting, a safe discovery projection, and a browser mutation/form. No database schema change is required.

Control Room already has daemon health and project-workflow resources, a REST-authoritative invalidation store, a global shell, and an accessible `ActionSheet` that becomes a mobile bottom sheet. The current registry intentionally exposes one `conductor.yaml` workflow per project, so the UI cannot honestly offer several workflow files within a project.

## Goals / Non-Goals

**Goals:**

- Let an operator start durable work from any authenticated Control Room route and land in its feature workspace.
- Represent the current selection truthfully as a configured project/workflow target.
- Support all current workflow input types without exposing workflow authoring secrets.
- Resolve and persist inputs before the first side effect, regardless of whether the caller is the UI, CLI, or another API client.
- Preserve the existing REST-authoritative/SSE-invalidation model under creation races.

**Non-Goals:**

- Multiple workflow files or arbitrary workflow selection within one project.
- Project registration, workflow editing/reloading, or runner administration from the start surface.
- Agent, model, variant, role, or runner overrides at feature-start time.
- Adopting an existing runner session from the browser.
- Durable exactly-once creation across an ambiguous client retry after a lost HTTP response.
- Changes to scheduler, event-trigger, workflow graph, interpreter routing, or concurrency policy.

## Decisions

### Model selection as a project/workflow target

The form selects from projects reported by daemon health, then confirms the one workflow returned by that project's workflow projection. Valid and stale snapshots are eligible; stale carries diagnostics. Invalid and unregistered projects are visible but disabled. Exactly one eligible target is preselected, while multiple targets require explicit operator selection.

The request includes the observed workflow name even though the server could infer it. This turns a reload race into `unknown_workflow` instead of silently starting against a different workflow.

Alternative: render a standalone workflow dropdown. Rejected because the registry has one workflow snapshot per project; such a dropdown would either duplicate the project choice or promise unsupported multi-workflow behavior.

Alternative: derive targets from board scopes. Rejected because projects with no active features would disappear and historical feature data is not the authoritative workflow registry.

### Extend the structure projection with input definitions only

`GET /v1/projects/workflow` adds an `inputs` map using the normalized `InputDef` shape: type plus required/optional presence and default where applicable. This is sufficient to build controls and uses the exact valid or retained-stale snapshot that execution will resolve.

Prompts, expressions, roles, agents, models, action `with:` values, and retry policy remain excluded. Input defaults are intentionally exposed because they are user-facing start values, not execution secrets.

Alternative: parse `conductor.yaml` in the browser. Rejected because it duplicates validation, leaks authoring content, cannot honor retained stale snapshots, and makes a deployment-specific filesystem visible to the client.

Alternative: add a second form-schema endpoint. Rejected because input definitions are part of the existing structure-only workflow projection and do not justify another cache or consistency boundary.

### Resolve workflow inputs purely, then create durably

Add a pure core helper that accepts normalized input definitions and an unknown supplied map and returns either the resolved typed map or ordered diagnostics. It rejects non-object values, unknown keys, missing required keys, wrong primitive types, and non-finite numbers, then fills omitted defaults. Stable input-name ordering keeps diagnostics reproducible.

`POST /v1/features` performs only JSON-shape validation and passes `inputs` to `Engine.startFeature`. After resolving the current snapshot and checking the submitted workflow identity, the engine calls the pure resolver. Only a successful result reaches `Store.createFeature({ input: resolved })`; dispatch follows the existing path. Input errors extend the start result/error vocabulary with a dedicated client-correctable code and actionable message.

This preserves the architectural split: the helper is pure, the interpreter remains unchanged, SQLite creation is the durability boundary, and the engine owns dispatch and all I/O. The first prompt/action/command therefore observes the same resolved map that restart recovery reads.

Alternative: validate only in the UI. Rejected because CLI/API clients could bypass it and workflow edits can race submission.

Alternative: let template evaluation report missing values after feature creation. Rejected because a feature and possibly other side effects would exist before a start-contract error is discovered.

### Render one shared shell-owned start sheet

The authenticated shell owns whether the form is open and passes one trigger callback to the persistent top bar and board empty states. The form composes the existing `ActionSheet`; it does not introduce a `/feature/new` route or a second modal primitive. A real form associates the sticky action button by form id so Enter submission and browser accessibility semantics remain intact.

On open, health is refreshed. The target policy and field serialization live in pure web helpers with unit tests. Target changes reset workflow-specific values to the newly projected defaults while preserving feature-level title, description, and PR fields. Typed controls use deliberate conversion: strings remain strings, finite numbers become numbers, and booleans remain booleans.

Alternative: put the form inside the board. Rejected because creation must remain available from feature routes and would otherwise produce duplicate form/state implementations.

Alternative: make project registration part of the empty state. Rejected because registration is administration with different validation and security implications.

### Treat creation as a dedicated authoritative store mutation

The browser API client gains `startFeature`; the `DataSource` gains a dedicated creation method rather than reusing per-feature command serialization, because no feature id exists before the response. Creation is not optimistic.

After a successful 201 response, the store:

1. bumps authority for the returned detail/list resources so older in-flight loads cannot overwrite the response;
2. applies the returned detail and upserts its list projection when the list is already loaded;
3. arms echo suppression for the new feature;
4. starts a best-effort list refresh without making refresh success part of creation success; and
5. returns the payload so the shell closes the sheet and navigates to `/feature/:id`.

Initial dispatch occurs before the HTTP response, so an SSE invalidation may arrive first. That event carries no state; the later response remains authoritative and epoch guards reject stale fetches. Failed POSTs mutate no cache. Fields remain disabled and the sheet cannot close while the POST is pending, preventing simultaneous duplicate submissions.

Alternative: wait for SSE or a list refresh before navigation. Rejected because the 201 response already contains authoritative detail and coupling success to a secondary fetch can encourage a duplicate retry after durable creation.

Alternative: optimistically allocate a temporary feature. Rejected because ids, workflow resolution, resource waits, and initial dispatch state are server-owned.

### Keep authentication failure handling at the API-client boundary

Every browser request, including discovery and creation, must invoke the configured unauthorized callback on 401. Centralize that behavior in the API client's request path and remove duplicate store-only handling so mutations and loads return to the auth gate consistently.

Alternative: handle 401 in the form. Rejected because authentication is a shell-wide invariant and every future mutation would otherwise need to repeat it.

### Keep runtime bindings in workflow roles

The form does not expose agents or models. The workflow may contain several role-specific bindings, and the runtime-neutral runner registry does not publish a capability catalog. A global override would be ambiguous, non-reproducible, and specific to one runner.

If role overrides are needed later, they require a separate design for role-keyed durable overrides, runner capability discovery, validation, and variant transport.

### Scheduler and concurrency remain unchanged

Manual starts are independent engine operations and retain existing concurrent-start behavior. The change introduces no shared queue, scheduler reservation, or interpreter decision. If no runner is available, creation remains durable and existing resource-wait behavior owns execution readiness; the UI warns but does not impose a stricter policy than the daemon.

The pure input resolver can be reused by future schedule/event ingress, but this change wires it only into the current manual start contract and does not invent trigger payload semantics.

## Risks / Trade-offs

- **[Ambiguous transport failure can still lead to a manual duplicate retry]** -> Keep submission single-flight, never report a successful POST as failed because reconciliation failed, and leave durable start idempotency to a dedicated cross-client change if dogfood demonstrates the need.
- **[Stale workflow may differ from the file an operator just edited]** -> Label stale targets prominently, expose diagnostics, and submit the observed workflow identity; execution intentionally uses the retained valid snapshot.
- **[Workflow input defaults become externally visible]** -> Treat defaults as start-form metadata and continue excluding prompts, role bindings, action payloads, and configuration values.
- **[Number fields can accidentally serialize empty or non-finite values]** -> Keep an explicit unset state in the form, convert only on validation, and revalidate authoritatively in core.
- **[Creation response and early SSE refresh can race]** -> Advance store authority when applying creation and test both response orders.
- **[The canonical web-ui spec still awaits the completed redesign delta]** -> Implement against the current Control Room and archive/sync `redesign-control-room` before archiving this change so the canonical spec receives deltas in product order.

## Migration Plan

1. Add pure input resolution and tests without changing existing start behavior for no-input workflows.
2. Extend engine/API/CLI wire types and workflow projection; deploy remains backward compatible because `inputs` is optional and the response field is additive.
3. Add the browser client/store mutation and start surface behind the existing authenticated shell.
4. Build the embedded UI sidecar and binary together, restart the dogfood daemon, and start a disposable dogfood feature from desktop and mobile viewports.

No SQLite or workflow-config migration is required. Rollback consists of deploying the previous binary and UI sidecar together; features created with resolved inputs remain readable because the persisted state shape already supports the input map.
