## Why

Operators see features escalate on GitHub outages that would have healed by themselves. The gloam-idle history examined by the Jev spike (`docs/jev-spike.md`) shows the cause: action failures are classified by a three-way string check in the engine (`capability_denied:` → `invalid_config`, `exited 127` anywhere → `invalid_config`, everything else → `deterministic_failure`). As a result, `gh … exited 1: HTTP 503` is recorded as a deterministic failure and is never retried. Some failure paths still record no class at all: action input render errors, missing action bindings, orphaned action runs after a restart, and agent self-reported failures. Without a class, a failure bypasses class-aware retry policy entirely. And a transient failure on a step without an explicit `retry:` block escalates on the first attempt, because the interpreter's single-attempt default wins before the class policy is consulted.

The outcome for operators: transient weather (GitHub 5xx, rate limits, network) heals under patient backoff, and only genuine defects escalate. Every failed run carries a class that projections can show.

## What Changes

- Actions may return a structured failure class with their failure, using the same taxonomy as runners and commands. The engine prefers a valid adapter-supplied class over its own fallback. An invented class normalizes to `internal`.
- The bundled `github/*` and `git/*` actions classify the `gh`/`git` failures they recognise:
  - HTTP 5xx → `transient_upstream`
  - 429 or secondary rate limit → `capacity`
  - network errors → `transient_transport`
  - authentication and permission errors → `invalid_config`
  - semantic rejections (not mergeable, head moved, checks failed, branch exists) → `deterministic_failure`
- The engine's fallback classification of unclassified action, command and thrown-boundary text matches status codes only as standalone tokens, never inside hex identifiers. Exit-code-127 detection anchors on the reported exit code, not any substring.
- Every failure path that concludes a run attaches an envelope:
  - action input render error → `invalid_config`
  - missing action binding → `invalid_config`
  - action orphaned by a daemon restart → `internal`
  - agent `conductor_report outcome=failed` → `deterministic_failure` (source `agent`)
- A step without an explicit `retry:` policy follows the class-default budget of its failure's class instead of always making a single attempt:
  - transient classes (`transient_upstream`, `transient_transport`, `capacity`, `timeout`) retry with patient backoff, up to 5 attempts within 10 minutes;
  - `internal` gets one delayed retry;
  - deterministic, invalid-config, missing-session and cancelled failures keep today's single attempt;
  - steps with an explicit `retry:` policy are unchanged.
- No LLM or external classifier is introduced. The spike showed deterministic rules close the observed gaps; a model-based fallback stays out of scope.

Mapping to product commitments: this is "Resilience with patience — per-failure-class retry policies". It changes no confirmed decision. The interpreter stays pure: it only reads the failure class carried on the event, and all classification remains in adapters and the engine.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `failure-classification` (introduced by the unarchived `retry-policy` change; this delta adds to it):
  - adds adapter-supplied classes for actions
  - adds token-anchored fallback classification
  - adds the requirement that every concluded failed run carries a class
- `retry-budget` (also from `retry-policy`): transient-class failures on steps without an explicit retry policy use the class-default budget.

## Impact

- **Code**:
  - `packages/core`: `ActionResult` failed variant gains an optional class; the `step.failed` event carries the class so the interpreter can apply the class-default attempt count.
  - `packages/server`: `action-host.ts`, the bundled actions, the engine's failure paths and fallback classification.
- **Database**: no migration. The `run.failure_class` column and its CHECK constraint already cover the taxonomy, and historical NULL rows stay as they are.
- **Subprocess actions**: may add an optional `class` to their JSON `ActionResult`. Malformed values normalize to `internal`. Existing actions keep working.
- **gloam-idle config**: no change required. Its `push`, `pr_create`, `fix_push` and `await_checks` steps have no `retry:` block, so after this change they gain patient retries on GitHub 5xx and network errors (class default: 5 attempts within 10 minutes). Steps with explicit `retry:` blocks behave as before.
- **Carry-over from opencode-conductor**: none. The seed had no failure taxonomy.
- **Out of scope** (possible follow-up): nudge/reap diagnostics. The spike's dead-dispatch and provider-error evidence comes from the native runner era. gloam now runs on ACP, where peer errors are redacted and only one nudged run exists so far, so that needs its own evidence before a proposal.
