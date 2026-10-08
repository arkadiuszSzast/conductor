## 1. Contracts and config

- [x] 1.1 [runner][test] Probe OpenCode 2.0.25 for the client-supplied `ses…`/`msg…` id grammar and the 409 behaviour, and record the result in design.md D4 (fall back to server-assigned ids if the grammar is unsuitable).
- [x] 1.2 [core] Add optional `role.variant` to workflow types, parsing and validation, with tests.
- [x] 1.3 [cli] Parse `runners.opencode.<profile>` (`baseUrl`, `passwordEnv`|`passwordFile`, `allowedRoots`, `maxConcurrent`, `deadlines.startupMs`, `bindings.<agent>.{model,variant}`), reject inline secrets, allow `runners.projects` to reference opencode profiles, and update the sample config.
- [x] 1.4 [server][db] Add a migration that widens `runner_binding.transport` to include `'opencode'`, plus store tests.

## 2. v2 session client

- [x] 2.1 [server] Add an `opencode/` HTTP client: Basic auth, the `location[directory]` query, bounded request deadlines, and error mapping to `RunnerOperationError` (`not_sent` vs `unknown`).
- [x] 2.2 [server] Implement `prepare()`: retry the empty agent catalog bounded, validate agent/model/variant (`invalid_config`), check `conductor.report` plugin readiness.
- [x] 2.3 [server] Implement `createSession` with a deterministic id, the full `{providerID,id,variant}`, `agent`, `location`, and `metadata.conductor`; replay on lost response, fence on a mismatched echo (2.0.25 never returns 409, see D4).
- [x] 2.4 [server] Implement `prompt` (deterministic id, no model), `status` (active + outcome/idle; 404 means missing, else unknown), `abort` (`interrupt?resume=false`), `note` (`synthetic`, `resume:false`) and `sessionExists`.
- [x] 2.5 [server] Route in `runner-router.ts` and compose in `daemon.ts`: concurrency limit per profile (running bound runs + live reservations); readiness is checked per attempt in `prepare()`, not by a global probe.
- [x] 2.6 [server] Resolve role ?? binding `{model, variant}` in `engine.ts`, and pass it to the opencode and ACP transports.

## 3. Reporting plugin

- [x] 3.1 [runner] Rewrite `packages/runner-opencode` as a v2 `Plugin.define` (`conductor.report`) on `@opencode/plugin` 2.x: the three tools, credential from session metadata, `/v1/worker/*` calls, refusal for unbound sessions.
- [x] 3.2 [runner] Delete the v1 `hub.ts`, `sessions.ts`, `agent-logs.ts` and the v1 plugin entry; remove the opencode use of the runner registry/transport paths where nothing else uses them. (The registry/transport stay: they are the generic native runner protocol; the deleted v1 plugin was their only opencode client.)

## 4. ACP fix

- [x] 4.1 [server][fix] In `acp/sessions.ts`, apply `model` first and `effort` last, let the role variant override binding effort, and treat an effective-effort mismatch as `invalid_config`.

## 5. Tests and docs

- [x] 5.1 [test] Fake v2 server tests: cold catalog, unknown variant, lost create/prompt replay, 409 fence, status mapping, abort idempotence, non-inferential note, plugin-readiness failure.
- [x] 5.2 [test] Plugin tests: metadata credential, mismatched run_id rejected, unbound session refused.
- [x] 5.3 [test] ACP ordering test: a model switch that resets effort still ends at the configured effort.
- [x] 5.4 [docs] `docs/install.md`: native v2 setup (dedicated `opencode serve` unit, password file, plugin install), updated ACP section, removal of the v1 plugin.
- [x] 5.5 [test] Run `bun run typecheck`, `bun test` and `bun run lint`; review the final diff.
- [ ] 5.6 [review] Pilot on the host: route gloam-idle to the opencode profile, run one small feature, and verify sessions carry the expected `variant` (gates `low`), skills/repowise tools are native, and `sed -i` is rejected.
