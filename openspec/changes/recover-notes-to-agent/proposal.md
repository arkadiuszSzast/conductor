# Recover notes reach the agent

## Why

Operators must provide non-empty recovery notes, but the engine currently discards them. The recovered agent receives no explanation or guidance and can repeat the same failure.

## What Changes

Persist recovery notes with durable per-target dispatch intent, copy them to the recovered run, and include them verbatim in its agent dispatch header automatically. Preserve notes through restart and runner resource waits. Keep API validation and callers unchanged; add no template syntax.

## Capabilities

### New Capabilities

- `retry-budget`: add a scoped requirement for durable operator guidance delivered to recovered agent steps.

## Impact

Server store/engine, additive migration 0019, focused tests and HTTP API documentation. No core interpreter or runner protocol change is required. This supports the operational resilience pillar and the runtime-agnostic daemon; it adds no agent-authoring DSL. Existing durable-outbox confirmation-of-effect behavior is retained because recovery must survive crashes, not for seed format compatibility. No obsolete seed workflow format is introduced.

Existing database rows receive nullable notes and a consumption marker default. No gloam-idle workflow/config edits, model changes, deployment, service restart or live recovery are part of this change. Recovering the current feature remains a separate explicit instruction.
