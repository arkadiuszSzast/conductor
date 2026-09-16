# Design — recover-notes-to-agent

## Context and decisions

The API and engine require notes but the engine drops them before calling the store. Neither the existing transition event nor dispatch intent records them.

Persist notes with the recovery intent and audit event in the DAG-repair transaction. Migration 0019 adds nullable `run.recover_notes`, nullable `recovery_dispatch.notes`, and `recovery_dispatch.notes_consumed` defaulting to zero. Existing rows remain valid and notes remain null.

Run insertion copies the matching target's open recovery episode notes in its transaction. The recovery-dispatch ID identifies the episode; migration 0020 adds a durable `episode_closed` marker independent of dispatch handling and first consumption. The engine reads the inserted run's snapshot and prepends the notes as literal text to the existing dispatch header, after rendering the workflow prompt. No new expression root or syntax is introduced; feedback and all existing template contexts remain unchanged. Command/action runs record notes for audit but do not inject them into commands or action inputs.

Dispatch-intent handling and episode lifetime are separate: the reconciler may handle an intent after creating a resource wait, before any run exists. Notes remain available through immediate retries, scheduled retries, restarts and resource waits, including runner loss after run insertion. Transition application closes the episode atomically when the target completes, leaves its active frontier, follows terminal failure routing, or participates in a rerun reset; feature termination also closes episodes. A subsequent recovery closes the selected target's older intent and replaces its guidance, including null guidance at the store boundary. No historical latest-run fallback is used. The existing active-run unique index protects concurrent insertion. No runner protocol changes are needed: SessionClient.prompt already transports text.

Migration 0020 conservatively closes already-consumed historical intents and keeps unconsumed intent available. It does not infer episode membership from timestamps or reactivate previously delivered guidance: pre-upgrade consumed episodes require a separately authorized new recovery if guidance must be re-established. Existing run snapshots remain unchanged.

## Alternatives

A closure-only argument loses notes across restart. Feature-global feedback would overwrite rerun context and leak across targets. A new template field would require author opt-in and cannot guarantee delivery for existing workflows. Run-only storage cannot cover a recovery committed before a run can be created; hence the durable outbox bridge.

## Durability and scope

All writes stay in the store/engine; the interpreter remains pure. Target selection, notes validation, version checks, idempotency and retry budgets retain their existing contracts. This preserves the useful seed confirmation-of-effect behavior without introducing its obsolete workflow format.

Migrations run when the updated daemon opens the database. This task does not restart or deploy a service, change model settings, or recover any live feature. No workflow/config edits are needed. Tests cover API delivery, multi-target selection, migration, restart, delayed runner availability, and adapter text transport.
