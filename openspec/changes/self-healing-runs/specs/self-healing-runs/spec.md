## Purpose

Lets pipelines survive host or runner weather without operator intervention. Conductor automatically retries uncertain executions that it can prove safe to replay. It keeps retrying with patient backoff and surfaces a visible `attention` state while doing so.

## ADDED Requirements

### Requirement: Fenced executions are classified from durable evidence
When a run is fenced as uncertain, Conductor SHALL classify it as `no_effect`, `replay_safe` or `unsafe`. The classification SHALL use only durable evidence, and it SHALL NOT be computed before cleanup evidence for the fenced process is recorded or its bounded wait expires.

- **`no_effect`:** no runner session identifier was ever bound to the run, no prompt operation for the run left the `prepared` phase, and process cleanup is `confirmed_terminated`.
- **`replay_safe`:** the step declares `replaySafe: true` and process cleanup is `confirmed_terminated`.
- **`unsafe`:** every other fence, including any fence whose cleanup is not `confirmed_terminated` and any fence carrying a pending answer delivery.

The classification and its evidence SHALL be persisted on the fence and exposed through the API.

#### Scenario: Session creation lost during a host stall
- **WHEN** `session/new` times out, no session id was bound, and the ACP process group is confirmed terminated
- **THEN** the fence is classified `no_effect`

#### Scenario: Prompt possibly delivered on a non-replay-safe step
- **WHEN** a prompt's outcome is unknown on a step without `replaySafe: true`
- **THEN** the fence is classified `unsafe`

#### Scenario: Cleanup not confirmed
- **WHEN** cleanup evidence is `unconfirmed` for any fence
- **THEN** the fence is classified `unsafe` regardless of step declaration or session state

### Requirement: Safe fences heal automatically with patient backoff
Conductor SHALL resolve fences classified `no_effect` or `replay_safe` without operator input. It SHALL record an audited system recovery that names the classification and diagnostic, and schedule a fresh attempt with new credentials.

- **Backoff:** delays SHALL follow exponential backoff with full jitter, starting at 1 minute, doubling, and capped at 30 minutes. The bounds SHALL be configurable per daemon.
- **Budget:** healing attempts SHALL NOT consume the step's ordinary retry budget. They SHALL NOT be limited by attempt count or elapsed time.
- **Counter:** the consecutive-failure counter SHALL reset only when an attempt for the target completes successfully.
- **Pause and abandon:** pausing a feature SHALL suspend pending healing attempts. Abandoning SHALL cancel them.
- **Old run:** the old fenced run and its operations SHALL be retained unchanged and SHALL never be resent.

#### Scenario: Healing after a lost create
- **WHEN** a `no_effect` fence is recorded for a review step
- **THEN** a healing attempt is scheduled about 1 minute later, the feature is not escalated, and the old run remains `uncertain` in history

#### Scenario: Repeated failures back off
- **WHEN** successive healing attempts for one target keep producing safe fences
- **THEN** each delay grows exponentially (with jitter) until it reaches the 30-minute cap and continues at the cap

#### Scenario: Paused feature
- **WHEN** an operator pauses a feature with a pending healing attempt
- **THEN** no attempt is dispatched until resume, and resume reschedules it without counting paused time against backoff

### Requirement: Unsafe fences escalate as before
A fence classified `unsafe` SHALL escalate the feature and require acknowledged operator recovery, unchanged from `runner-execution-safety`. Any pending healing schedule for that target SHALL be closed.

#### Scenario: Unsafe fence during healing
- **WHEN** a healing attempt itself is fenced and classified `unsafe`
- **THEN** the feature becomes `escalated`, healing stops for that target, and an escalation notification is emitted

### Requirement: Attention status signals persistent trouble without stopping progress
A feature SHALL enter the `attention` status when any of its targets reaches the configured number of consecutive failed healing attempts (default 3) or when its ordinary transient retries exhaust half their budget.

- **While in `attention`:** retries SHALL continue, and reconciliation SHALL treat the feature as active.
- **Leaving `attention`:** the feature SHALL return to `running` once no target satisfies the attention condition, for example after a successful attempt.
- **Precedence:** `attention` SHALL never override `escalated`, `waiting_human`, `paused`, `done` or `abandoned`.
- **Visibility:** the API, CLI and UI SHALL show `attention` with the affected targets, last diagnostic, consecutive failure count and next attempt time.

#### Scenario: Third consecutive failure
- **WHEN** the third consecutive healing attempt for a target fails safely
- **THEN** the feature status becomes `attention`, an attention notification is emitted, and the fourth attempt is still scheduled

#### Scenario: Recovery clears attention
- **WHEN** a later attempt for the only troubled target completes successfully
- **THEN** the feature returns to `running` and a recovered notification is emitted
