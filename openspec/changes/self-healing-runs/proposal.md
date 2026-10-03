## Why

A 13-minute host stall (journald watchdog, frozen event loop) made one ACP `session/new` time out. Conductor fenced the run as uncertain and escalated the whole feature. The pipeline then stopped until an operator noticed it on the dashboard, even though no session ever existed, the process was confirmed dead, and the step was a read-only review. Escalating every uncertain execution is safe, but it turns host weather into manual work. The operator also only learns about it by opening the board.

## What Changes

- **Safe-replay classification of uncertain executions.** When a run is fenced, Conductor classifies it from durable evidence:
  - `no_effect`: no session id was ever bound, so no prompt was sent, and the process cleanup is `confirmed_terminated`.
  - `replay_safe`: a prompt may have been delivered, the step declares `replaySafe: true`, and cleanup is `confirmed_terminated`.
  - `unsafe`: everything else, including any case where cleanup is unconfirmed.
- **Automatic healing retries.** `no_effect` and `replay_safe` fences resolve themselves. Conductor writes an audited system recovery and schedules a fresh attempt. Backoff is exponential with full jitter, starting at 1 minute and capped at 30 minutes. There is no attempt limit; the operator can always pause or abandon. Healing attempts do not consume the step's ordinary `retry` budget.
- **`unsafe` fences** keep today's behaviour: escalate and require an acknowledged recovery. They now also notify.
- **New `attention` feature status.** After a configurable number of consecutive failed healing attempts (default 3), the feature shows `attention` (still progressing, needs a look). Retries continue. The first success clears it.
- **Notification subsystem.** The engine's existing `notify` hook becomes a durable notification outbox with deduplication and rate limiting. Telegram is the first channel, configured under `notifications` in `daemon.yaml` with the bot token taken from the environment.
- **Notified events:** `attention` entered, `recovered` (left `attention`), `escalated`, `waiting_human` (gate or question), and feature `done`.
- **BREAKING (spec):** `runner-execution-safety` no longer forbids every automatic replay after uncertainty. It permits replay for evidence-proven `no_effect` and for opted-in `replay_safe` steps.

## Capabilities

### New Capabilities
- `self-healing-runs`: classification of fenced executions, healing-retry scheduling and backoff, `attention` status lifecycle, system recovery audit.
- `notifications`: durable notification outbox, event catalogue, dedup/rate limiting, Telegram channel, daemon configuration.

### Modified Capabilities
- `runner-execution-safety`: "Unknown effects are fenced outside automatic failure routing" and "Unknown observation is distinct from idle or missing" are relaxed. Proven `no_effect` and opted-in `replay_safe` fences may be auto-recovered after confirmed cleanup.
- `workflow-definition`: agent steps gain an optional `replaySafe: boolean` (default `false`).

## Impact

- **core:**
  - `FeatureStatus` gains `attention`.
  - `AgentStep.replaySafe` is added: parse, validate and IR.
  - The interpreter handles a new `step.healing_scheduled` event and attention transitions.
  - A pure `classifyFence` is added.
- **server:**
  - The fence path classifies after cleanup evidence lands.
  - New healing scheduler, which reuses `retry_episode` with a new `schedule_source = 'healing'`.
  - System recovery reuses the `recoverStepTargets` audit path.
  - New notification outbox table, dispatcher and Telegram adapter.
  - The API exposes `attention`, healing state and next attempt.
- **cli:** `daemon.yaml` gains a `notifications` section (strict parser); `status` shows `attention`.
- **web:** `attention` gets a badge and visual treatment like `escalated`, but marked as still progressing; the next healing attempt time is shown.
- **DB:** new migrations add a `feature.status` CHECK expansion, a `notification_outbox` table, and `runner_fence.classification`. This is greenfield, so there is no backfill beyond defaults.
- **gloam-idle config:** review steps should set `replaySafe: true`. Telegram bot token goes in the `CONDUCTOR_TELEGRAM_BOT_TOKEN` environment variable, and the chat id goes in `daemon.yaml`.
- **Carry-over:** none from `opencode-conductor`. This builds on the existing fence and retry-episode machinery.
