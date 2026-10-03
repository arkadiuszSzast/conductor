# Jev spike — fast classifier for engine decisions

Spike run 2026-10-02 against gloam-idle production history (code, datasets and full reports:
`/root/Projects/jev-spike`). Question: can a fast, calibrated "System One" classifier (TypeSafe Jev,
`jev-1.13.0`) improve engine decisions that today rely on regexes and timers?

## Results

| Decision | Today | Jev | Verdict |
|---|---|---|---|
| Failure class of command/action/runner errors (25 distinct, 92 occurrences) | regex 60% (74% weighted); class stored in DB 44% | 92% (95% weighted), 19/20 correct at confidence ≥ 0.8 | useful, but the fixes below come first |
| Stuck-session state at first nudge (104 nudged + 132 healthy) | timers only | 62%, poorly calibrated | no-go |

## Deterministic bugs the spike surfaced (no model needed)

Status: items 1–3 are addressed by the OpenSpec change `complete-failure-classification`.

1. `classifyThrownBoundary` (`packages/server/src/engine.ts`) matches `429|502|503|504` anywhere in the message, including inside
   commit SHAs. The spike's offline replay showed this; in production those action errors never reach the regex (actions are classified
   separately), so it is a latent bug for thrown boundaries rather than an observed misroute.
2. Action failures are classified by a three-way string check (`capability_denied:` / `exited 127` / everything else
   `deterministic_failure`), so `gh … exited 1: HTTP 503` is recorded as deterministic and a GitHub outage is never retried.
3. Some paths still conclude without a class: action input render errors, missing bindings during reconciliation, actions orphaned by
   a restart, and agent self-reported failures. Older NULL rows (`no runner registered`, `capability_denied`, early "Unable to connect")
   predate fixes already shipped. Separately, a transient failure on a step without `retry:` escalates on the first attempt because the
   interpreter's single-attempt default wins before class policy applies.
4. Nudge/reap: of 114 nudged-then-reaped native runs, 76 sessions contain only the prompt and the nudges — the model never produced a single
   part (dead dispatch). Of the remaining 36, 13 ended in repeated provider errors (502 / "stream ended"), 18 stopped after a tool-call step,
   2 had written a final answer without reporting. 17.7 h passed between first nudge and reap on those 36. All of this is visible
   structurally in the session at nudge time: no assistant parts → redispatch; trailing provider errors → treat as `transient_upstream`
   with backoff; `finish=stop` without report → targeted "report now" nudge.

## Where a classifier still fits

- Fallback for failure texts no deterministic rule recognises (today: `internal`), gated on confidence, emitting a `FailureClass` —
  the interpreter stays pure, the class is just data.
- Triage of agent self-reported failures (`blocker_kind`: scope/time vs external prerequisite vs concurrent writer vs design question)
  to decide between automatic retry and escalation. Looked plausible on 44 reports; needs gold labels before relying on it.
- Not for transcript-level judgments of liveness: the signal is wall-clock silence and part structure, which the engine already has.

Any integration must keep the provider pluggable (no hardcoded gateway) and treat the classifier as a fallback behind deterministic rules.
