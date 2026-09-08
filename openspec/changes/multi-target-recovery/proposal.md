# Multi-target recovery — one recover re-arms every selected failed step

## Why

The refold-bestiary-into-journal escalation exposed the gap: three
parallel architect jobs failed together (provider outage), but `recover`
re-arms exactly ONE step and flips the feature to `running` — after
which a second `recover` is rejected (`feature is not escalated`).  The
other two jobs stayed `failed`, invisible to the UI (recoverable targets
are only computed for `escalated` features), and the pipeline could
never reach its fan-in.  Manual DB surgery was required.  The store
layer (`recoverStepTargets`) already accepts an array of targets and
repairs them atomically — the single-target constraint is artificial,
imposed by the engine/API layer.

A second, compounding bug: the runner-down failure ("Unable to connect.
Is the computer able to access the url?", thrown by the runner SDK) is
classified `internal` because `classifyThrownBoundary` has no pattern
for it — so a dead runner burns the step's retry budget instead of
entering a resource wait / transient backoff.

## What Changes

- **`recover` accepts multiple targets.** API/engine: `target` (one,
  back-compat) or `targets` (list) or `all: true` (every currently
  recoverable candidate).  All selected targets are re-armed in ONE
  `recoverStepTargets` transaction (one idempotency key, one version
  check).  Ambiguity handling changes: several candidates without a
  selection is still rejected, but the error now also offers `all`.
- **CLI**: `conductor recover <id> --all --notes ...` and repeatable
  `--job X --step Y` pairs.
- **Web UI**: the escalation panel lists every recoverable target with
  checkboxes and a "Recover all" action, submitting one request.
- **Failure classification**: `classifyThrownBoundary` learns the
  runner-SDK connection-failure shapes ("Unable to connect",
  "ConnectionRefused", "Connection closed") → `transient_transport`,
  so a dead runner triggers transient backoff instead of burning the
  attempt budget as `internal`.

## Capabilities

### Modified Capabilities

- `retry-budget`: multi-target recovery requirement replaces the
  single-target constraint ("Parallel failures require a selected
  target" becomes "Parallel failures recover together or by explicit
  selection"); runner-connection failures classify as transient
  transport.

## Impact

- `packages/server/src/engine.ts`: `recover()` target selection,
  `classifyThrownBoundary` patterns.
- `packages/server/src/api.ts`: request schema (`targets`, `all`).
- `packages/cli`: `recover` flags.
- `apps/web`: escalation panel target list + recover-all.
- `packages/server/src/store.ts`: no change (already takes an array).
