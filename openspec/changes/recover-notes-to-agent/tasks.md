# Tasks — recover-notes-to-agent

- [x] [db] Add nullable run recovery notes and outbox notes, plus a durable notes-consumption marker; preserve existing rows.
- [x] [server][db] Persist accepted notes with recovery intent and audit event; atomically copy and consume notes when inserting the target run.
- [x] [server][core] Inject literal notes into the agent dispatch header without changing the pure interpreter or supported template contexts.
- [x] [test] Cover API acceptance, required-note rejection, multi-target propagation, normal prompt isolation and run persistence.
- [x] [test] Cover migration, restart before dispatch, and recovery waiting for a runner after the dispatch intent is handled.
- [x] [runner][test] Verify recovery prompt text reaches the OpenCode adapter's agent message unchanged.
- [x] [docs] Document the API run field and automatic header propagation in docs/http-api.md.
- [x] [test] Run typecheck, complete test script and lint on the isolated change.
- [x] [server][db] Keep recovery intent active for the target's automatic retry episode; close it atomically on completion, terminal routing, rerun/reset or replacement recovery, independently of dispatch handling.
- [x] [test] Verify immediate and scheduled retry prompts, database reopen, resource waits including post-insertion runner loss, replacement notes, target isolation and successful recovery followed by a later rerun.
- [x] [docs] Update episode lifetime and conservative migration/deployment semantics.
- [x] [test][review] Run typecheck, lint and full test script; review the fix without changing existing runner-liveness work.
