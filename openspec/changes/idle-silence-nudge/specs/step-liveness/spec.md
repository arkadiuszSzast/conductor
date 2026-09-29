## Purpose

Allow workflow steps to express recovery patience without premature idle recovery or losing durable liveness accounting.

## ADDED Requirements

### Requirement: Step limits inherit independently

Agent steps SHALL accept positive-integer idleSilenceNudgeMs, busySilenceNudgeMs, maxNudges and ttlMs. Omitted values SHALL inherit daemon settings then defaults of 120000, 600000, 2 and 3600000 respectively. Non-agent bodies and invalid values SHALL be rejected.

#### Scenario: Isolated override
- **WHEN** one step overrides its busy threshold and budget
- **THEN** other steps retain inherited limits and the overridden step retains inherited idle and TTL limits

### Requirement: Idle recovery waits for elapsed silence

Each idle nudge or exhausted reap SHALL require both cycle debounce and elapsed silence beyond the idle threshold since latest activity, including failed nudge attempts. Idle and busy recovery SHALL share a durable counter. Expired TTL SHALL win before recovery, pending questions SHALL remain exempt from nudging with TTL protection, and paused silence SHALL remain excluded.

#### Scenario: Adjacent heartbeats
- **WHEN** a nudge was attempted ten seconds ago with the default idle grace
- **THEN** another heartbeat neither nudges nor reaps for exhausted budget

#### Scenario: Restart
- **WHEN** the daemon restarts after a nudge
- **THEN** persisted activity and consumed budget govern further recovery

### Requirement: Trailing users do not hide unfinished work

An absent runtime status SHALL NOT be inferred idle solely from a trailing user message when the latest assistant or its tools remain unfinished. A later completed assistant SHALL supersede earlier unfinished assistants.

#### Scenario: User nudge during tool execution
- **WHEN** the latest assistant has an unfinished tool followed by a user nudge
- **THEN** the timeline fallback reports busy

#### Scenario: Completed later turn
- **WHEN** an old unfinished assistant precedes a later completed assistant with no unfinished tools
- **THEN** the fallback reports idle even with trailing user notes

### Requirement: An empty or unreachable timeline reports busy, never idle

When the runtime status is unlisted and the bounded timeline fallback finds no evidence either way — the transport is unreachable, or the bounded page returns zero messages for a session already confirmed to exist — the fallback SHALL report busy rather than idle. Absence of evidence is never evidence of completion.

#### Scenario: Bounded page returns no messages
- **WHEN** a live session's timeline page returns zero messages
- **THEN** the fallback reports busy, not idle

#### Scenario: Timeline transport unreachable
- **WHEN** the timeline endpoint throws or is unreachable
- **THEN** the fallback reports busy, not idle
