## 0. Diagnostics groundwork (done)

- [x] 0.1 [db][server][runner] Persist the concrete unknown-outcome diagnostic on `runner_operation.diagnostic` (migration 0026), record elapsed time vs deadline, and carry the diagnostic and `operationId` into the fence. Verified by an `engine-acp-integration.test.ts` case.

## 1. Workflow model

- [x] 1.1 [core] Add optional `replaySafe` to `AgentStep`. Parse it in the agent step reader. Reject it on non-agent steps and on `interactive: true` steps. Verify with parse/validate tests covering the default, the opt-in and both invalid placements.
- [x] 1.2 [core] Add a pure `classifyFence(evidence)` returning `no_effect | replay_safe | unsafe`. Verify with an exhaustive truth-table test, including unconfirmed cleanup always being `unsafe` and a pending answer delivery being `unsafe`.
- [x] 1.3 [core] Change `step.execution_unknown` to hold the step fenced (job running, same currentStep) without escalating. Add `step.fence_classified` (unsafe→escalate, safe→noop/heal) and a pending-fence-classification progress anchor. Verify with interpreter and invariant tests showing that unsafe still escalates, safe does not, and a pending classification is not stranded.

## 2. Durable state

- [x] 2.1 [db] Add the `feature_attention` table (projected `attention` status), `runner_fence.classification` plus evidence JSON, and the `healing_episode` table. Verify with a migration test.
- [x] 2.2 [db] Add the `notification_outbox` table: status, attempts, next_attempt_at, dedup_key unique per channel, and an index on due rows. Verify with a migration test.
- [x] 2.3 [db][server] Store helpers: `classifyFenceExecution` (persists classification, schedules healing, sets attention atomically), `healFencedTarget`, `listUnclassifiedFences`, and outbox insert/claim/mark. Verify with store tests covering concurrent claim and restart between fence and classification.

## 3. Engine healing

- [x] 3.1 [server] After `recordRunnerCleanup`, or when the classify timeout expires, gather the evidence (session bound, prompt left prepared, cleanup, replaySafe from the pinned snapshot, answer delivery), then classify and dispatch `step.fence_classified`. Reconcile picks up unclassified fences after a restart. Verify with a test where `session/new` times out with confirmed cleanup, which must give `no_effect` and no escalation.
- [x] 3.2 [server] Schedule a healing episode with exponential full-jitter backoff (1 m → 30 m cap, configurable). A due episode runs a system recovery through `recoverStepTargets` (actor system, key `heal:<runId>`) and then dispatches. Healing never consumes the step retry budget. Verify with fake-clock tests for the backoff growth, the cap, idempotency, and old operations never being resent.
- [x] 3.3 [server] Attention lifecycle: enter at `attentionAfter` consecutive healing failures, or when transient retry passes 50% of its budget. Clear on a successful conclusion. Pause and resume recompute it. Verify with engine tests for the third failure (attention, attempt 4 still scheduled) and for success (back to running).
- [x] 3.4 [server] Make the existing guards respect healing: `hasUnresolvedRunnerFence` must only block when the fence is unclassified or unsafe, abandon cancels healing, and pause suspends it. Verify with engine tests for pause, abandon and resume during healing.

## 4. Notifications

- [x] 4.1 [server] Insert outbox rows transactionally on: attention entered/cleared, escalated, waiting_human, done. The in-process `notify` callback stays as a best-effort hook (it is part of the tested completion-outbox replay); the daemon delivers only via the durable outbox. Verify with a test that rolling back the status change leaves no outbox row.
- [x] 4.2 [server] `NotificationDispatcher`: interval claim, dedup/rate-limit window with folded suppression counts, delivery retry with backoff for up to 24 h, never touching engine state. Verify with fake-clock tests for a flapping attention and a failing channel.
- [x] 4.3 [server] Telegram channel: HTML-escaped messages, 10 s timeout, token redacted from all errors, optional event filter. Verify with tests against a stubbed fetch, including a redaction test.
- [x] 4.4 [cli] Strict `notifications` section in `daemon.yaml` and `engine.healing` options. Fail startup when the token env var is missing. Update the config template and wire the dispatcher in `startDaemon`. Verify with daemon-config parser tests.
- [x] 4.5 [server][cli] `POST /v1/notifications/test` and `conductor notify test`, reporting per-channel results. Verify with API and CLI tests.

## 5. Visibility

- [x] 5.1 [server] API projection: `attention` activity state with targets, consecutive failures, next attempt and last diagnostic; fence classification and evidence on uncertain runs; `system.healed` in the timeline. Verify with API contract tests.
- [x] 5.2 [cli] `status` shows `attention` and the next healing attempt. Verify with a CLI snapshot test.
- [x] 5.3 [web] Attention badge and filter (distinct from escalated, marked as progressing), healing countdown in the step inspector, and the classification shown on uncertain runs. Verify with web component tests and `bun run --cwd apps/web typecheck`.

## 6. Docs and rollout

- [x] 6.1 [docs] Document `replaySafe`, healing behaviour, `attention`, and notification config including Telegram bot setup. Verify the docs build/lint and that links resolve.
- [x] 6.2 [test] End-to-end: simulate a host stall on `session/new` for a review step through to healing, attention after 3 failures, recovery, and the notifications recorded and delivered to a stub channel. Verify that `bun test` passes.
- [ ] 6.3 [review] Set `replaySafe: true` on the gloam-idle review steps and configure Telegram on the deployment. Confirm a `conductor notify test` message arrives.
