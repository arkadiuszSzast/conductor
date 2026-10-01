## 1. Pure scheduling in core

- [ ] 1.1 [core] Add the queue types (entry, entry state with reason, scheduler input/output) and `planQueue` per design D3: validation (cycles over active changes, unknown dependencies), transitive `blocked` propagation from escalated/paused/abandoned features, `waiting` reasons (unmerged dependencies, limit, paused), and start selection in queue order under the limit. Verify: `bun test packages/core` with table-driven cases covering every scenario in `specs/change-queue/spec.md` that does not need I/O.
- [ ] 1.2 [core][test] Property tests for `planQueue`: never selects more starts than `limit` minus running queue features; never selects an entry with an unmerged dependency; an entry independent of every stuck feature is never `blocked`. Verify: `bun test packages/core`.

## 2. Persistence

- [ ] 2.1 [db] Additive migration for `change_queue` and `change_queue_entry` (design D4) with the partial unique index on live entries, plus store accessors: read queue, add/remove/reorder entries, set paused/parallelism, transition entry state with an audit row, claim (`waiting → starting`) and link (`starting → running`) in separate transactions. Verify: store tests on an empty DB and on a DB at the current schema; a second live entry for the same change is rejected.
- [ ] 2.2 [db][test] Restart reconciliation of `starting` entries: link to the feature created after the claim for that change, otherwise release the claim. Verify: tests for crash before feature creation, after creation before link, and after link.

## 3. Server

- [ ] 3.1 [server] Extract the start-input derivation (title, description from the proposal's *Why*, `change_slug`/`change` input from the workflow projection) from `plugins/openspec/serve.ts` into a shared module used by the plugin and the server, with no behaviour change. Verify: the existing plugin tests pass unchanged, and a unit test covers the derivation directly.
- [ ] 3.2 [server] Merged-set and graph readers: `.openspec.yaml` `depends_on` for active changes, active/archived name sets, and merged names from `origin/<default>` via the process port with a bounded fetch (design D2). Verify: tests against a temporary git repo with a bare remote: archived on remote = merged; archived only locally = not merged; default branch other than `main`.
- [ ] 3.3 [server] `ChangeQueueScheduler.tick()`: gather inputs, call `planQueue`, persist states, start selected entries through `Engine.startFeature` with the claim/link protocol; wire it into the daemon timer on its own interval (default 60 s, configurable). Verify: integration tests with a fake runner covering "next change starts without a human", "independent changes run in parallel", "limit holds back a ready change", "unrelated work continues", "recovery unblocks the dependants" and "restart does not start a change twice".
- [ ] 3.4 [server] Queue HTTP API per design D5 (read, add with validation, remove, update paused/parallelism/order) using the existing error envelope and auth. Verify: API tests for each endpoint including the cycle and unknown-dependency `422`s and the refusal to remove a running entry.

## 4. OpenSpec plugin

- [ ] 4.1 [web] Panel: queue/dequeue actions, declared dependencies per change, queue state and reason per entry, pause/resume and parallelism controls, inline API errors. Start-work is unchanged. Verify: plugin tests for the three panel scenarios in `specs/openspec-plugin/spec.md`, plus a manual check against a local daemon.

## 5. Documentation and review

- [ ] 5.1 [docs] Document the queue: `depends_on` in `.openspec.yaml`, what "merged" means, states and reasons, the HTTP API (`docs/http-api.md`), and a "running unattended" section (`docs/install.md`) that explains removing the human merge gate is the project's choice. Mark Track B Stages 5–6 in `docs/development-roadmap.md` as superseded by this change for the change level. Verify: docs reviewed against the shipped behaviour.
- [ ] 5.2 [review] Review the full diff against the specs and design (interpreter purity, no queue knowledge in the engine, exactly-once start). Verify: review notes recorded on the PR.
- [ ] 5.3 [test] Full quality gate: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`. Verify: all green.
