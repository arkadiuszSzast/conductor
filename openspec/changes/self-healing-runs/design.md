## Context

When the outcome of a create or prompt is unknown, `store.fenceRunnerExecution` runs one atomic transaction: run → `uncertain`, a `runner_fence` row, and the pure `step.execution_unknown` transition. The interpreter maps that transition to `escalate`. Afterwards, `Engine.cleanupRunner` asynchronously records `cleanup_state` (`confirmed_terminated` | `unconfirmed`) from the `groupAbsent()` proof.

Operator recovery (`store.recoverStepTargets`) already repairs the DAG, resolves fences, revokes credentials, writes `human.recovered` and a `recovery_dispatch` row, and re-dispatches.

The reconciler heartbeat (5 s) already drives the due `retry_episode` rows. The engine has an unwired `notify(title, message)` hook that is called on escalate, wait_human, question, and the fence outbox drain.

The 2026-10-02 incident had this evidence: `create_response_lost`, `session_id` null, binding `remote_session_id` null, step = read-only review, and no orphan process. Under this design it would classify as `no_effect` and heal at about 1 minute.

## Goals / Non-Goals

**Goals:**
- No operator involvement for host or runner weather when replay is provably harmless or explicitly declared harmless.
- Retries never stop on their own, but they back off to a 30-minute cap so a struggling host is not hammered.
- A visible "still progressing, but troubled" state, plus near-real-time push notifications.
- Reuse the existing retry-episode, recovery-audit and fence machinery rather than build parallel paths.

**Non-Goals:**
- Automatic recovery of `unsafe` fences, or of fences whose cleanup is not confirmed.
- Automatic host remediation, such as killing other processes or restarting the daemon.
- Channels other than Telegram (the interface allows adding them later), and per-user notification routing.
- Healing native (non-ACP) runner failures. These already use ordinary failure classes and retry.

## Decisions

### D1. Classify after cleanup evidence, as a pure function
Add `classifyFence(evidence) → no_effect | replay_safe | unsafe` to `@conductor/core`. The evidence is: `sessionBound`, `promptLeftPrepared`, `cleanupState`, `stepReplaySafe`, and `hasPendingAnswerDelivery`.

The fence transaction itself stays unchanged (still `uncertain`), but it no longer escalates directly:
- `step.execution_unknown` now leaves the job `running` on the same `currentStep` with no live run. The feature stays `running`. An unclassified fence counts as a progress anchor, so the stranded-feature invariant does not escalate it.
- Once `recordRunnerCleanup` writes evidence, or a bounded wait (`cleanupClassifyTimeoutMs`, default 2×`killMs` + 5 s) expires, the engine classifies and dispatches `step.fence_classified { classification }`. A timeout counts as `unconfirmed`, i.e. `unsafe`.
- The interpreter maps `unsafe` → `escalate` (the old behaviour) and `no_effect`/`replay_safe` → `heal`.

*Why not classify inside the fence transaction?* Cleanup evidence does not exist yet at that point, and termination is async by design.

*Alternative considered:* escalate first and auto-recover later. Rejected, because it emits spurious escalation notifications and flips the board status.

**Crash safety:** a fence with `classification IS NULL` is picked up by reconcile, which classifies it once evidence or the timeout is available. After a restart, an in-memory cleanup that never finished means `unconfirmed`, so the fence is `unsafe`. This is conservative.

### D2. "Prompt left prepared" and "session bound" come from the operation journal
- **`sessionBound`:** `run.session_id IS NOT NULL OR runner_binding.remote_session_id IS NOT NULL`.
- **`promptLeftPrepared`:** there exists a `runner_operation` of kind `prompt`/`answer`/`nudge` for the run with a phase other than `prepared` or `not_sent`.

A create in `unknown` with no bound session is `no_effect` only together with confirmed termination: the remote session may exist, but it was never prompted and its process is gone.

### D3. Healing uses a dedicated `healing_episode` table
- **Schema:** `healing_episode(feature, job, step, fence_run_id unique, classification, status scheduled|claimed|closed, consecutive_failures, next_attempt_at, delay_ms, diagnostic)`, with one open row per target.
- *Why not reuse `retry_episode`:* its budget columns, the one-open-row index and the elapsed-budget claim check all encode finite budgets. Mixing in unbounded healing rows would mean special-casing every one of those sites. The claim/close/pause-barrier shape is copied instead.
- **Counter:** `consecutive_failures` is inherited from the target's previous healing episode when that episode closed with `attempt_dispatched` and no success came in between, i.e. while the target still has an attention row or the previous heal was the last thing that happened. A success clears the chain.
- **Budget:** the ordinary step attempt counter is not incremented, because a fence never increments it and the healed target keeps its job `running` with the same `currentStep`.
- **Backoff:** `exponential {initial: 60s, multiplier: 2, max: 30m, jitter: full}`, configurable under `engine.healing` in `daemon.yaml` (`initialMs`, `maxMs`, `attentionAfter`).
- **Dispatch:** when an episode is due, the engine performs a system heal. In one transaction it resolves the fence with the note `auto-heal: <classification>: <diagnostic>` and writes a `system.healed` timeline entry. It then dispatches `execute_step` through the guarded `actDecision`. No DAG repair is needed: a healable fence never failed the job, so its `currentStep` is still the target.

*Alternative considered:* a bespoke healing table. Rejected because it duplicates pause accounting, claim atomicity and restart semantics that already exist.

### D4. `attention` is a projected status over durable per-target trouble
The persisted `feature.status` and the core `FeatureStatus` stay unchanged. A new `feature_attention` table holds troubled targets: `(feature, job, step, source healing|retry, consecutive_failures, last_diagnostic, next_attempt_at)`. The externally visible status is `attention` exactly when the persisted status is `running` and `attention` is non-empty.

*Why not a persisted status?* The interpreter writes `running` on every transition, so a persisted `attention` would be overwritten constantly. Widening the CHECK constraint would force a rebuild of the FK-referenced `feature` table. And every `running` guard in the engine would need touching. A projection keeps routing untouched.

- **Entering:** a target is added or updated in the same transaction that schedules a healing episode with `consecutiveFailures >= attentionAfter`, or a transient retry past 50% of its attempts or elapsed budget.
- **Leaving:** the target is removed when a run for it concludes `succeeded`, when an operator recovers it, or when an unsafe fence escalates it.
- **Precedence:** `escalated`, `waiting_human`, `paused` and terminal statuses win naturally, because the projection only overrides `running`.
- **API:** `status` stays the persisted value, so filters and guards are unchanged. Features gain an `attention` field (`{since, targets: [{jobId, stepId, source, consecutiveFailures, lastDiagnostic, nextAttemptAt}]}` or null), and `activity.state` becomes `attention` while healing or retrying troubled targets. Healing episodes appear as `activity.state: waiting_retry` with `reason: healing:<classification>`.

### D5. Durable notification outbox
The `notification_outbox` table has the columns: `id`, `feature_id`, `kind`, `payload` JSON, `dedup_key`, `channel`, `status` (`pending`|`sent`|`suppressed`|`failed`), `attempts`, `next_attempt_at`, `last_error`, `time_created` and `time_sent`.

- **Writing:** rows are inserted inside the same store transactions that change the status (every status-writing store path calls one `notifyStatusChangeTx` hook, plus the attention set/clear sites), one row per configured channel. The in-process `notify` callback stays as a best-effort hook for embedders and tests. The daemon delivers only through the outbox.
- **Delivery:** a `NotificationDispatcher` runs on its own interval (default 5 s). It claims due rows atomically, applies dedup/rate limits (D6), and delivers via the `NotificationChannel` port `{ id, send(message): Promise<void> }`. Retry backoff runs from 10 s up to a 10-minute cap and gives up after 24 h.
- **Isolation:** the dispatcher never touches engine state.

### D6. Dedup and rate limiting
- **Suppression:** for a `(feature_id, kind, channel)` with a `sent` row inside the window (default 15 min), a new row becomes `suppressed`. `recovered` and `done` are exempt.
- **Folding:** the next delivered message for that feature includes "(N similar suppressed)".
- **Idempotency:** rows are written only on an actual status edge inside the committing transaction. A replayed decision outbox does not re-cross the edge, so it cannot duplicate a row. `dedup_key` is unique per channel as a backstop.

### D7. Telegram channel
- **Config:**
  ```yaml
  notifications:
    publicBaseUrl: https://conductor.example/   # optional
    rateLimitWindowMs: 900000
    telegram:
      chatId: "-100…"
      tokenEnv: CONDUCTOR_TELEGRAM_BOT_TOKEN
      events: [attention, recovered, escalated, waiting_human, done]   # optional
  ```
- **Startup:** the strict parser rejects unknown keys. A missing environment variable fails startup.
- **Sending:** `POST https://api.telegram.org/bot<token>/sendMessage` with `parse_mode: HTML`. Text is escaped, the token is redacted from every error string, and there is a 10 s timeout.
- **Message format:** emoji-free, e.g. `[attention] Server Settled Masterwork Work — review_code_edges/review: 3 consecutive failures; next attempt 00:41 UTC. ACP create outcome unknown [create_response_lost]: session/new exceeded 30000ms deadline (elapsed 774750ms)`.
- **CLI:** `conductor notify test` calls a new `POST /v1/notifications/test` endpoint (bearer auth), which sends synchronously and returns the per-channel result.

### D8. `replaySafe` on agent steps
- **Parsing:** in `readAgentStep`, with validation rules from the spec.
- **Engine use:** the flag is read from the run's pinned workflow snapshot, so it applies to that run even if the workflow changes later.
- **gloam-idle:** set it on all `review_*` steps.

## Risks / Trade-offs

- **[Silent replay of partial work]** A wrongly declared `replaySafe` could re-run a mutating step. *Mitigation:* opt-in per step; interactive steps forbidden; the classification and evidence are visible in the timeline as `system.healed`.
- **[Classification delay]** The board shows "running" for up to about 10 s while waiting for cleanup evidence. This is acceptable.
- **[Unbounded retries]** A permanently broken runner retries every 30 minutes forever. *Mitigation:* `attention` notification; each attempt is cheap at the cap; the operator can pause or abandon.
- **[Notification storms]** Many features failing together (host outage) produce N messages. *Mitigation:* the per-feature window; a global digest is deferred.
- **[Spec reversal]** This relaxes a safety requirement. It is scoped to evidence-proven or opt-in cases, never to unconfirmed cleanup.
- **[Status CHECK migration]** SQLite needs a table rebuild to widen `feature.status`. This follows the existing rebuild pattern (migration 0003-style). Greenfield, so no data risk.
