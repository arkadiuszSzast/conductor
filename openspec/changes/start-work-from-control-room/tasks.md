## 1. Canonical Workflow Input Resolution

- [x] 1.1 [core][test] Add and export a deterministic workflow-input resolver that rejects non-object payloads, unknown names, missing required values, wrong primitive types, and non-finite numbers, then applies defaults with stable diagnostics.
- [x] 1.2 [server][test] Extend `Engine.startFeature` and its result vocabulary to resolve inputs against the selected workflow snapshot before `Store.createFeature`, persist the resolved map, and prove rejected inputs create no durable state or execution side effects.
- [x] 1.3 [test] Verify resolved required/defaulted inputs are available to the first agent, command, and action template context and remain intact across a store reload.

## 2. HTTP and Client Contracts

- [x] 2.1 [server][test] Extend `POST /v1/features` to accept optional `inputs`, preserve workflow-name race detection, map malformed or invalid input diagnostics to an actionable client error, and keep existing no-input requests compatible.
- [x] 2.2 [server][test] Extend `GET /v1/projects/workflow` with the served snapshot's safe input definitions while continuing to exclude prompts, expressions, role/model bindings, action payloads, and retry policy for valid and stale projections.
- [x] 2.3 [cli][test] Update the CLI daemon-client start request contract for optional typed inputs without changing the existing `conductor start` command syntax, and retain compatibility coverage for workflows with no required inputs.
- [x] 2.4 [docs] Document workflow input discovery and manual-start request/error semantics in `docs/http-api.md` and clarify resolved/defaulted input persistence in `docs/workflow-reference.md`.

## 3. Browser Data and Mutation Model

- [x] 3.1 [web][test] Add browser-local wire types and API client methods for projected input definitions and feature creation, including centralized `401` handling for both reads and mutations.
- [x] 3.2 [web][test] Add pure target derivation from daemon health plus project workflow projections, covering one-target preselection, multiple-target confirmation, stale warnings, invalid/unregistered targets, runner-unavailable warnings, and target-switch resets.
- [x] 3.3 [web][test] Add pure typed form serialization and validation for title, pull-request number, string/number/boolean workflow inputs, defaults, required values, unset numbers, and non-finite number rejection.
- [x] 3.4 [web][test] Add a non-optimistic `startFeature` store mutation that applies the returned feature as authoritative detail/list state, suppresses its SSE echo, survives response/invalidation ordering, and treats post-create list refresh as best effort.

## 4. Control Room Start Surface

- [x] 4.1 [web] Build one shell-owned start-work form on the existing `ActionSheet`, with target loading/statuses, feature metadata fields, dynamic typed workflow inputs, inline errors, and no agent/model override controls.
- [x] 4.2 [web] Add pending-state protections, focus/escape restoration, form-associated sticky actions, dynamic-viewport scrolling, safe-area padding, and 320px responsive styling without document overflow.
- [x] 4.3 [web] Wire the shared start action into the persistent authenticated top bar and useful board empty states, then close and navigate to `/feature/:id` only after an authoritative successful response.
- [x] 4.4 [web][test] Cover field preservation after validation, configuration-race, network, and server failures; duplicate-submit/dismissal prevention; target metadata refresh after configuration errors; auth-gate return on `401`; and successful navigation without waiting for SSE.

## 5. Verification and Dogfooding

- [x] 5.1 [test] Run focused core, server, CLI, and web tests, then `bun run typecheck`, `bun run lint`, `bun run build`, `bun test`, `git diff --check`, and strict OpenSpec validation; fix regressions attributable to this change.
- [x] 5.2 [review] Review the final diff for interpreter purity, side effects after the SQLite durability boundary, accidental database/config migrations, workflow authoring leakage, runtime-specific overrides, and interference with existing dirty engine/recovery edits.
- [x] 5.3 [web][test] Build and deploy the embedded binary/UI sidecar together, then dogfood browser-created no-input and typed-input features from desktop and 320px/390px mobile viewports, including stale-target and runner-unavailable messaging where safely reproducible.
