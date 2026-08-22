## Why

A human answer is currently removed from durable state before Conductor delivers it to the live agent session. A daemon crash in that interval can acknowledge the operator action while permanently losing the binding decision, violating the durability expected of interactive steps.

## What Changes

- Persist an accepted answer as durable pending delivery before attempting the runner side effect.
- Reconcile pending answer deliveries after restart until the existing session accepts the answer or is confirmed lost.
- Clear the visible question and mark the answer delivered only after confirmation of effect, while preserving exactly-once operator acceptance under concurrent or repeated requests.
- Route confirmed session loss or terminal delivery failure through the existing failed-step and retry semantics without dropping the accepted notes.
- Keep the HTTP/CLI answer contract and the same-session continuation behavior; no new runner capability is required.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `interactive-steps`: Strengthen answer acceptance and same-session delivery so accepted notes survive daemon crashes and reconcile to a confirmed outcome.

## Impact

- Affects `packages/server` migrations, store transactions, answer handling, reconciliation, and crash-boundary tests; API, CLI, and web payload shapes remain unchanged.
- Adds SQLite state additively so existing asking runs remain readable and in-flight features survive upgrade; rollback requires draining pending answer deliveries or returning to the upgraded daemon.
- Carries over the seed's confirmation-of-effect and durable reconciler disciplines because session prompts are external side effects that must not be represented as complete before confirmation.
- Does not change workflow YAML, gloam-idle configuration, the runner abstraction, or any confirmed architecture decision. The interpreter remains pure and the engine continues to own runner I/O.
