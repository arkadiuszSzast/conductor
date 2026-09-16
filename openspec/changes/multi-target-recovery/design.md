# Design — multi-target-recovery

## Context

`Store.recoverStepTargets(featureId, targets[], options)` already
repairs an arbitrary set of targets atomically: per-target job runtime
reset (running/currentStep/attempts cleared), cascade-skipped jobs back
to pending, feature → running, one transition-log row, one recovery-
dispatch outbox row per target, idempotency key recorded in the same
transaction.  The single-target constraint lives entirely in
`Engine.recover()` (picks `candidates[0]` or exactly one match) and the
API/CLI/web request shapes.

The refold incident: 3 parallel jobs failed together; recover #1
re-armed one and flipped the feature to `running`; recovers #2 and #3
were rejected (`not escalated`); the remaining `failed` jobs were
invisible to the UI (recoverable targets are computed only when
`status === "escalated"`) and unreachable by the API.  Manual DB patch
replicated exactly what `recoverStepTargets` would have done.

## Goals / Non-Goals

**Goals**

- One recover call re-arms any subset (or all) of the current
  candidates, atomically.
- The escalation surfaces (CLI error, web panel) present the full
  candidate set and the recover-all affordance.
- Runner-connection failures classify as `transient_transport`.

**Non-Goals**

- No recovery of individual steps while the feature is `running` (the
  invariant "recover applies to escalated features" stays; the fix is
  making one recover sufficient, not loosening the state gate).
- No per-target notes — one note covers the operation.
- No changes to `resume`.

## Decisions

### D1 — Request shape: `target` | `targets` | `all` (exactly one form)

`POST /v1/features/:id/recover` accepts `target` (existing, one),
`targets` (non-empty array), or `all: true`.  More than one form in a
request is `invalid_request`.  `all` resolves to the candidate set
server-side at execution time — under the same `expectedVersion` check,
so "all" can never silently include targets the operator's view did not
show (stale view → `stale_version` rejection).

*Alternative considered*: making `target` accept an array — rejected:
silent shape change breaks the documented single-target contract and
its error modes; explicit fields keep back-compat exact.

### D2 — Wholesale validation, wholesale rejection

Every explicitly named target must be in the current candidate set;
any miss rejects the entire request (`staleTarget`, listing which).
Matches the existing single-target staleness semantics and keeps the
"no partial re-arm" invariant trivially true — the only write path is
one `recoverStepTargets` call with the validated set.

### D3 — Ambiguity error advertises `all`

The `ambiguous` rejection (several candidates, no selection) keeps its
shape and adds the hint + `allowAll: true` so the CLI can print
`--all` and the web panel can render "Recover all".  No behavioural
change for single-candidate features.

### D4 — CLI: repeatable `--job/--step` pairs and `--all`

`conductor recover <id> --all --notes ...` or repeated
`--job X --step Y` pairs (order pairs positionally).  Mixing `--all`
with `--job` is a usage error.

### D5 — Web: checkbox list + Recover all

The escalation panel renders `recoverableTargets` as a checkbox list
(all pre-checked) with one notes field and one submit; the request uses
`targets` (or `all` when everything is checked — indifferent, both are
correct; use `targets` for exactness under the version check).

### D6 — `classifyThrownBoundary` learns runner-connection shapes

Add `/unable to connect|connectionrefused|connection closed|connection error/i`
→ `transient_transport`, placed with the existing ECONNREFUSED branch.
Bun's fetch throws "Unable to connect. Is the computer able to access
the url?" — the exact string from the incident.  Keeps the rule of
matching transport symptoms only, never agent prose: these strings come
from the engine's own HTTP boundary (`SessionClient`), not from model
output.

## Risks / Trade-offs

- [Recover-all after partial provider recovery] `all` may re-arm a step
  whose upstream is still broken — it just fails again into its fresh
  finite budget and re-escalates; bounded by design.
- [Broader transport regex] "connection closed" could theoretically
  appear inside an agent's report text — but `classifyThrownBoundary`
  only ever sees thrown boundary errors (runner SDK / fetch), never
  report prose, so the matching-surface rule holds.

## Migration Plan

Engine/API/CLI/web change; no schema migration.  `recoverStepTargets`
untouched.  Single-target requests behave byte-identically.

## Open Questions

None.
