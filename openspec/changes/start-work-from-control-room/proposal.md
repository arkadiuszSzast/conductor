## Why

Control Room can observe and steer existing work, but starting new work still requires leaving the browser and using the CLI. Operators should be able to choose an installed project/workflow target, describe the task, and enter the resulting feature workspace without changing tools.

## What Changes

- Add a global "Start work" action to the authenticated Control Room shell, with the same action available from useful empty states.
- Present an accessible responsive start sheet that discovers configured project/workflow targets and clearly distinguishes valid, stale, invalid, and unavailable targets.
- Collect a required title, optional task description, optional existing pull-request number, and any declared workflow inputs required by the selected target.
- Extend the structure-only workflow projection with safe input definitions and extend manual feature creation to validate supplied inputs, reject unknown or mistyped values, apply defaults, and persist the resolved input map before dispatch.
- Submit through the existing authoritative feature-start engine path, preserve form contents after failures, prevent duplicate in-flight submissions, seed the returned feature state, refresh list-backed views, and navigate directly to the created feature workspace.
- Keep agents and models owned by workflow roles; this change does not add runtime-specific agent/model overrides, project registration, or multiple workflow files per project.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `web-ui`: Add the Control Room start-work entry point, target discovery, validated responsive form, authoritative creation handling, and success navigation.
- `workflow-definition`: Make declared workflow inputs discoverable to manual clients and define canonical validation/default resolution before a manually started feature executes.

## Impact

- Affects the web shell, top bar, API client/store/hooks, start-work form, responsive styles, and web tests under `apps/web`.
- Extends `GET /v1/projects/workflow` and `POST /v1/features`, plus their browser/CLI-facing documentation and server tests; existing requests without workflow inputs remain valid for workflows that require none.
- Adds pure workflow-input resolution in core and passes the resolved map through the existing engine/store start path; no new orchestration side effects belong in the HTTP or UI layers.
- Reuses the opencode-conductor carry-over that all starts route through one durable engine path and SQLite remains authoritative; the browser becomes another client rather than introducing a parallel state machine.
- Requires no conductor database migration because feature state already persists an input map, and requires no gloam-idle configuration migration because existing `conductor.yaml` files and start requests remain valid.
- Advances the standalone control-surface and workflow-as-data pillars without changing any confirmed runtime, repository, action-registry, or runner decision.
