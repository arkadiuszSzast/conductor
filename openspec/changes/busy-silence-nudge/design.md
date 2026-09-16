# Design — busy-silence-nudge

## Context

`reconcileAgentRun` (engine.ts): the `busy`/`retry` branch unconditionally
clears the idle counter and falls through to the TTL check. The idle
branch owns the whole nudge machinery (idle-cycle debounce → nudge →
budget-exhausted reap). Activity-aware TTL (resilient-agent-runs) gave
runs a durable `timeLastActivity`; the nudge counter (`run.nudges`) and
`incrementNudges` already exist and already touch the activity clock.

Both real incidents (hung provider stream; post-reboot cut stream) had
the same signature: status `busy`, activity clock frozen, session
reachable and recoverable by a single prompt.

## Goals / Non-Goals

**Goals**

- Detect and recover a busy-but-dead session at the minutes scale with
  the machinery that already exists (nudge prompt, nudge budget, reap).
- Zero new state: derive everything from `timeLastActivity` + `nudges`.

**Non-Goals**

- No per-step busy-silence override (the engine default is enough until
  proven otherwise; `ttlMs` remains the per-step knob).
- No streaming-liveness probe into the runtime (e.g. asking opencode
  whether the stream is actually moving) — the activity clock is the
  engine's only truth about liveness, by design.
- No change to idle nudging or the ask/answer exemption.

## Decisions

### D1 — Reuse the nudge budget, not a parallel one

Busy-silence nudges and idle nudges share `run.nudges` and `maxNudges`.
One budget means one invariant ("a run gets at most N recovery prompts,
ever") and no new columns. The nudge prompt text is shared too — the
session cannot tell (and need not care) whether the engine saw it idle
or busy-silent; the instruction is identical: finish the step, report.

### D2 — Threshold check inline in the busy branch, before the TTL call

The `busy`/`retry` branch computes `silence = now − max(timeLastActivity,
timeStarted) − pausedCredit` (same formula as `reconcileTtl`). If
`silence > busySilenceNudgeMs`: nudge (budget permitting) or reap
(budget exhausted). Since a nudge touches the activity clock
(`incrementNudges` already does), the threshold naturally re-arms —
no per-run timer state, no idle-cycle-style debounce map. The reap
reuses `reap()` (abort + timeout envelope), and the branch still falls
through to `reconcileTtl` when silence is under the threshold, so
step-level `ttlMs` floors keep working unchanged.

*Alternative considered*: reusing the idle-cycle debounce counter for
busy-silence — rejected: the debounce exists because `idle` is a cheap,
instantaneous status that flickers; a frozen activity clock is already
a time-integrated signal, debouncing it again just delays recovery.

### D3 — `busySilenceNudgeMs` engine option, daemon-config plumbed

Default 10 min (`DEFAULT_BUSY_SILENCE_NUDGE_MS`). Yaml:
`engine: { busySilenceNudgeMs: 600000 }` next to `runTtlMs`. Validation:
positive integer. No interaction with `nudgeIdleCycles` (idle path) —
the two paths stay independent.

## Risks / Trade-offs

- [Nudging a genuinely slow model turn] A single inference turn longer
  than the threshold with zero emitted parts would be nudged mid-turn →
  opencode queues the prompt until the turn ends, so the nudge lands as
  a follow-up message, not an interruption; the agent sees a redundant
  "finish and report" and reports. Cost: one wasted budget slot and a
  few tokens. 10 min of zero streamed parts is already pathological for
  the runtimes we drive.
- [Tool-heavy agents before the runner restart] Until the runner plugin
  that emits `tool` log lines is live, a tool-heavy agent's activity
  clock only moves on text parts — busy-silence nudges could fire
  during legitimate long tool phases. Accepted: the nudge is harmless
  (queued, answered by a report), and the tool-line runner change ships
  first.

## Migration Plan

Engine-only change behind a config default; no schema, no protocol. Ship
with tests; rollback = revert.

## Open Questions

None.
