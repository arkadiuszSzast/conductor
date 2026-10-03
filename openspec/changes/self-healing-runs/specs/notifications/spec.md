## Purpose

Pushes operator-relevant pipeline events (trouble, recovery, human gates, completion) to external channels in near real time. Operators then learn about problems without watching the dashboard.

## ADDED Requirements

### Requirement: Notification events are recorded durably
Conductor SHALL record a notification in a durable outbox, in the same transaction as the state change that causes it, for each of these events:
- a feature enters `attention`
- a feature leaves `attention` (recovered)
- a feature becomes `escalated`
- a feature enters `waiting_human` (gate approval or interactive question)
- a feature becomes `done`

Each notification SHALL carry the event kind, feature id and title, project, affected job/step targets, and a bounded, secret-redacted diagnostic. It SHALL also carry a dashboard link when a public base URL is configured.

#### Scenario: Escalation recorded atomically
- **WHEN** a fence escalates a feature
- **THEN** the escalation notification exists in the outbox if and only if the escalation committed

#### Scenario: Crash before delivery
- **WHEN** the daemon stops after recording a notification but before delivering it
- **THEN** the notification is delivered after restart

### Requirement: Delivery is asynchronous, retried and never blocks the pipeline
Notifications SHALL be delivered outside the engine's transactions and reconcile decisions. Failed deliveries SHALL be retried with exponential backoff for a bounded period (default 24 hours), then marked failed and logged. Delivery failure SHALL NOT change feature, job, step or run state.

#### Scenario: Telegram unreachable
- **WHEN** the Telegram API is unreachable
- **THEN** pipeline progress is unaffected and delivery is retried later

### Requirement: Notifications are deduplicated and rate limited
Conductor SHALL deliver each notification at most once per channel under normal operation. It SHALL suppress repeated notifications of the same kind for the same feature within a configurable window (default 15 minutes). `recovered` and `done` SHALL never be suppressed. Suppressed notifications SHALL be counted and the count SHALL be reported in the next delivered notification for that feature.

#### Scenario: Flapping attention
- **WHEN** a feature enters `attention`, recovers and re-enters `attention` within 15 minutes
- **THEN** the second `attention` notification is suppressed while the `recovered` notification is still delivered

### Requirement: Telegram channel
Conductor SHALL support a Telegram channel configured in the daemon configuration file. The configuration SHALL contain a chat id and the name of the environment variable that holds the bot token. The bot token SHALL NOT be accepted inline in the configuration file and SHALL never appear in logs, API responses or diagnostics.

- **Event subset:** an optional event-kind subset SHALL restrict which events a channel receives. If it is absent, the channel receives all events.
- **Startup:** with the channel configured, the daemon SHALL fail to start if the token environment variable is unset.
- **Disabled:** with no `notifications` section, notifications are disabled and nothing is recorded.

#### Scenario: Misconfigured token
- **WHEN** a Telegram channel is configured but its token environment variable is unset
- **THEN** the daemon fails to start with an error naming the missing variable

#### Scenario: Event filtering
- **WHEN** a channel lists only `attention` and `escalated`
- **THEN** `done` notifications are not delivered to that channel

### Requirement: Operators can test the channel
The CLI SHALL provide a command that sends a test notification through every configured channel and reports per-channel success or the failure reason.

#### Scenario: Test message
- **WHEN** an operator runs the notification test command with a valid configuration
- **THEN** a test message arrives in the configured Telegram chat and the command reports success
