## Context

See proposal.md. Existing dirty work implements busy silence, pause credit, directory-scoped status and retry.maxElapsed; preserve it.

## Goals / Non-Goals

Keep the interpreter pure and I/O in the engine. No deployment, commits, external configuration edits or schema migration.

## Decisions

Resolve each limit independently from agent step, daemon setting, then default. Share that resolver across TTL and recovery, passing the resolved nudge budget to logging. Idle recovery requires both existing cycle debounce and silence strictly greater than the idle threshold; expired TTL is checked first. Attempts, including delivery failures, advance durable activity and consume the shared counter before I/O. No new timers or durable columns.

The installed SDK 1.18.16 defines user/assistant messages, assistant time.completed and tool parts with pending/running/completed/error states. Examine the latest assistant ignoring trailing users, including pending/running tools. Do not scan every historical unfinished assistant: a later completed assistant supersedes it. If a bounded timeline contains only users, conservatively return busy rather than infer idle. Explicit runtime status remains authoritative. This fixes a reproducible fallback shape, not a claim about an unknown historical incident.

## Risks / Trade-offs

Conservative busy can delay recovery until busy silence; TTL still bounds it. Five-message fallback remains bounded; user-only windows return busy. Idle cycle state remains process-local while elapsed grace and budget survive restart. Existing engine reconciliation scheduling is unchanged.

## Migration Plan

Later install/reload daemon and runner code, then apply desired workflow overrides and reload workflow configuration. No live changes in this work order. Rollback requires removing new configuration fields before using an older parser.
