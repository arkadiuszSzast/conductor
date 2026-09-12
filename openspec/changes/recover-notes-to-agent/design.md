# Design — recover-notes-to-agent

## Context and decisions

The API and engine require notes but the engine drops them before calling the store. Neither the existing transition event nor dispatch intent records them.

Persist notes with the recovery intent and audit event in the DAG-repair transaction. Migration 0019 adds nullable `run.recover_notes`, nullable `recovery_dispatch.notes`, and `recovery_dispatch.notes_consumed` defaulting to zero. Existing rows remain valid and notes remain null.

Run insertion copies the matching target's unconsumed intent notes and sets its consumption marker in the same transaction. The engine prepends the notes as literal text to the existing dispatch header, after rendering the workflow prompt. No new expression root or syntax is introduced; feedback and all existing template contexts remain unchanged. Command/action runs record notes for audit but do not inject them into commands or action inputs.

Dispatch-intent handling and note consumption are separate: the reconciler may handle an intent after creating a resource wait, before any run exists. The notes must remain available until that wait dispatches a run. Once consumed they must not leak into later runs. The existing active-run unique index protects concurrent insertion. No runner protocol changes are needed: SessionClient.prompt already transports text.

## Alternatives

A closure-only argument loses notes across restart. Feature-global feedback would overwrite rerun context and leak across targets. A new template field would require author opt-in and cannot guarantee delivery for existing workflows. Run-only storage cannot cover a recovery committed before a run can be created; hence the durable outbox bridge.

## Durability and scope

All writes stay in the store/engine; the interpreter remains pure. Target selection, notes validation, version checks, idempotency and retry budgets retain their existing contracts. This preserves the useful seed confirmation-of-effect behavior without introducing its obsolete workflow format.

Migrations run when the updated daemon opens the database. This task does not restart or deploy a service, change model settings, or recover any live feature. No workflow/config edits are needed. Tests cover API delivery, multi-target selection, migration, restart, delayed runner availability, and adapter text transport.
