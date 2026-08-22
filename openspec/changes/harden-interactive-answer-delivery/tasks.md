## 1. Durable Answer State

- [x] 1.1 [db][server] Add an additive answer-delivery migration and typed store projection with accepted notes, target session, delivery token, lifecycle state, timestamps, and bounded failure detail.
- [x] 1.2 [db][server] Implement transactional answer acceptance that guards the active question, accepts exactly one concurrent answer, preserves aggregate `waiting_human`, and records an auditable transition.
- [x] 1.3 [db][server] Implement conditional claim, lease/release, confirmed-delivery, terminal-failure, and stale-target operations for answer deliveries.
- [x] 1.4 [test][db] Cover concurrent acceptance, restart persistence, claim races, aggregate human attention, and migration compatibility with existing asking runs.

## 2. Engine Delivery and Reconciliation

- [x] 2.1 [server] Route `Engine.answer` through durable acceptance and the shared delivery worker while preserving the current answer API result contract.
- [x] 2.2 [server] Reconcile pending answer deliveries on startup and heartbeat, using the existing session for prompt I/O and a stable delivery token.
- [x] 2.3 [server] Classify missing-session and prompt failures, retaining accepted notes while routing terminal failure through normal run conclusion and retry/onFail semantics.
- [x] 2.4 [test][server] Simulate crashes before acceptance, after acceptance, after runner prompt, and after delivery confirmation; verify restart recovery and document the runner-level at-least-once edge.

## 3. Projection, Operations, and Review

- [x] 3.1 [server][web][cli] Project accepted-pending delivery so answering surfaces disable resubmission without falsely reporting the feature as running; keep existing HTTP/CLI payload compatibility.
- [x] 3.2 [docs] Document answer delivery states, restart behavior, operator-visible outcomes, rollback constraints, and runner idempotency limitations. (Done: `docs/concepts.md` "Answer delivery: accepted durably before it is delivered" under Interactive steps — acceptance/delivery split, `answerDelivery` projection, at-least-once redelivery + delivery-token dedup hook, pause interaction, rollback constraint; `docs/http-api.md`'s `/v1/runs/:id/answer` section and new `answerDelivery` projection subsection.)
- [x] 3.3 [review] Review durability, claim atomicity, pause/conclusion races, secret-safe notes and diagnostics, and ownership boundaries with runner-protocol.
- [x] 3.4 [fix][test] Run typecheck, lint, full tests, production build, and a daemon-restart dogfood scenario before archive.
