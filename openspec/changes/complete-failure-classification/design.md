## Context

Failure classes enter the system in three places today:

- **Commands:** `classifyProcessExit` on the exit code.
- **Runners / thrown boundaries:** `classifyThrownBoundary`, a regex chain over the error message. It also covers ACP `not_sent` errors without a structural class.
- **Actions:** an inline three-way check in `dispatchActionObservation` (`capability_denied:` prefix, the substring `exited 127`, everything else `deterministic_failure`). `ActionResult` / `ActionHostExecuteResult` carry only an error string.

`planFailureDisposition` applies class-aware backoff and budgets, but only when two things hold:

1. the conclusion carries a `FailureEnvelope`, and
2. the interpreter already decided to retry the step.

The interpreter decides that from `step.retry` alone. A step with `retry: { strategy: none }` uses `DEFAULT_MAX_ATTEMPTS = 1`, so a transient failure there routes terminally before any class policy is consulted. A probe confirmed it: a `transient_transport` failure on such a step escalates with no retry episode.

Several conclusion paths pass no envelope at all:

- action input render (`executeAction`, `reconcileActionRun`)
- missing binding in `reconcileActionRun`
- the restart orphan path
- agent `report(outcome: failed)`

## Goals / Non-Goals

**Goals:**
- One classification contract for actions, mirroring runners: an adapter may assert a class, and the engine falls back otherwise.
- Make class-default budgets actually govern steps without an explicit retry policy, without making the interpreter impure.
- Make every failed run carry a class.

**Non-Goals:**
- Model-based (LLM/Jev) classification.
- Nudge/reap behaviour, ACP diagnostics.
- Per-workflow `perClass` configuration in YAML. `normalizeRetryPolicy()` is still called with no config. Exposing it is a separate change.
- Backfilling historical NULL classes.
- Classifying an agent's self-reported failure more finely than `deterministic_failure`.

## Decisions

### D1. Actions carry an optional class on the failed result

- `ActionResult`'s failed variant gains `class?: string`, and `ActionHostExecuteResult` `ok:false` gains `failureClass?: FailureClass`.
- `ActionHost` normalizes with `normalizeFailureClass` only when a class is present, so a missing class stays missing and the engine falls back. An invented class becomes `internal`, per spec.
- `isActionResult` accepts an optional string `class` from subprocess actions.
- `CapabilityDeniedError` is classified by the host itself (`invalid_config`) instead of by the engine string-matching a prefix.
- *Alternative:* keep classifying in the engine from text. Rejected. It is exactly the brittle path that produced `HTTP 503 → deterministic_failure`. Only the action knows which `gh` call failed and why, and the runner side already went the structured way (`RunnerOperationError.failureClass`).

### D2. A shared `classifyCliFailure` helper for bundled actions

- A pure function in `packages/server/src/actions/` takes `{ tool: "gh" | "git", code, output }` and returns a class or `undefined`.
- Bundled actions call it at each `exec` failure site. Semantic failures they detect themselves (head moved, checks failed, not mergeable, already exists, invalid input) return `deterministic_failure` explicitly.
- Patterns are anchored to the CLI's actual message shapes:
  - `HTTP 5\d\d` / `HTTP 429`
  - `secondary rate limit` / `API rate limit exceeded`
  - `Could not resolve host` / `Connection refused` / `connection reset` / `i/o timeout` / `TLS handshake timeout`
  - `Permission denied (publickey)` / `HTTP 401` / `HTTP 403` without rate-limit text / `authentication failed`
  - exit 127 → `invalid_config`
- *Alternative:* classify only in the engine fallback. Rejected, as in D1.

### D3. Engine fallback matches tokens in context, never bare digits

`classifyThrownBoundary` is fixed for text that still reaches it (thrown boundaries, unclassified actions):

- Status codes only match with HTTP/status context: `\bHTTP[/ ]?(?:\d(?:\.\d)?\s+)?(429|50[234])\b`, `\bstatus(?: code)?[: ]+(429|50[234])\b`, or the reason phrases (`Too Many Requests`, `Bad Gateway`, `Service Unavailable`, `Gateway Timeout`).
- The `capacity` alternation `capacity` is also anchored as a word.
- The unclassified-action fallback becomes: host-supplied class → `classifyThrownBoundary(error)` if it yields a transient class → otherwise `deterministic_failure`. This keeps today's default for unknown action failures while catching transient text that third-party actions do not classify.
- The `exited 127` substring check is removed. Exit 127 is classified where the exit status is known: the D2 helper and `classifyProcessExit`.
- *Alternative:* `\b(429|50[234])\b` alone. Rejected: it still matches PR numbers (`PR #504`) and line numbers. The spike's failing cases were all identifiers.

### D4. Class travels on `step.failed`, interpreter applies class-default attempts

- `PipelineEvent` `step.failed` gains optional `failureClass?: FailureClass`.
- `concludeAndDispatch` sets it from `detail.failure` before calling `interpret`.
- In `onFailed`: when `step.retry.strategy === "none"` and `failureClass` is present, `retryMaxAttempts = behaviourForClass(normalizeRetryPolicy(), failureClass).budget.maxAttempts`. `retry-policy.ts` is already pure and lives in core. An explicit `backoff` policy and an absent class keep today's logic.
- The engine's `planFailureDisposition` already falls back to class backoff and elapsed budget when `stepRetry` is undefined, so delays and the elapsed deadline need no new code. Recovery (`resetRetryEpisodeForRecover`) already uses the same fallback.
- *Alternative A:* the engine overrides the interpreter's terminal decision. Rejected: that moves routing out of the pure function, which AGENTS.md forbids.
- *Alternative B:* `parse.ts` defaults omitted `retry:` to a backoff policy. Rejected: it would apply transient budgets to deterministic failures, and the class split is the point.
- Replaying old `step.failed` events without `failureClass` keeps today's behaviour.

### D5. Classes for the remaining conclusion paths

| Path | Class | Source |
|---|---|---|
| Action input render, both sites | `invalid_config` | `action` |
| Missing binding in `reconcileActionRun` | `invalid_config` | `action` |
| Restart orphan | `internal` | `daemon` |
| Agent `report(outcome: failed)` | `deterministic_failure` | `agent` |

- The restart orphan gets one delayed retry under the internal default; today it gets none on `retry: none` steps.
- The missing-binding path in `executeAction` inserts no run row and dispatches `step.failed` directly. It gains `failureClass: "invalid_config"` on the event only; there is no run to annotate.

**Consequence for agent steps with an explicit `retry:`** (all gloam agent steps: `maxAttempts 2`, constant 60 s backoff). Today a self-reported failure skips `planFailureDisposition`, because there is no envelope, and retries immediately. With an envelope, the step's declared 60 s backoff now applies. This honours the declared config. Steps without `retry:` are unchanged (deterministic → single attempt).

### Concurrency, durability, side effects

- Classification happens in adapters (action handlers, host) and in the engine before conclusion. The interpreter only reads a value on the event.
- No new tables or columns. The envelope persists through the existing `concludeRun` transaction and retry-episode rows, so a scheduled retry survives restart like today's classified retries.
- `run.failure_source` gains the values `agent` and `daemon`. The column is free text.

## Risks / Trade-offs

- **[Risk] A misclassified permanent `gh` failure as transient wastes up to 10 minutes of retries before escalating.** → Mitigation: the class budget is finite. Patterns are anchored to explicit HTTP and network text, and auth/permission errors map to `invalid_config` first.
- **[Risk] gloam steps without `retry:` (`push`, `pr_create`, `fix_push`, `await_checks`) start retrying, and a re-run `gh pr create` could duplicate a PR.** → Mitigation: `pr-create` already recovers "already exists" via `gh pr view`. `git push` of the same SHA is idempotent. `await-checks` is a read.
- **[Risk] Agent self-reported failures now honour the declared backoff, slowing the retry by 60 s on gloam.** → Accepted: it is the declared configuration.
- **[Trade-off] An agent's failure is always `deterministic_failure`, even when the agent says it was blocked by an outage.** → A finer split (e.g. an optional class on `conductor_report`) is deferred until there is evidence it matters; the spike's agent reports were scope or prerequisite blockers.

## Migration Plan

- No schema migration.
- Deploy is a daemon restart. In-flight retry episodes keep their stored budgets.
- Rollback is reverting the code. Rows written with the new sources/classes stay valid under the existing CHECK constraint.
