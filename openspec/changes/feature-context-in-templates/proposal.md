# `feature.*` in the template context

## Why

Workflow templates can read `inputs`/`steps`/`needs`/`feedback` — but not
the feature itself. `feature.title` and `feature.description` (what the
operator typed at `conductor start`) never reach a prompt, and
`feature.slug` (derived from the title, used for session names and logs)
cannot name a branch. Today the only way to hand a task description to
the first agent step is the non-existent inputs machinery; in practice
workflows smuggle it through required `inputs` that nothing actually
populates — `state.input` is always `{}` — so those templates silently
render empty. The simplest honest fix: expose the feature's own fields.

## What Changes

- **Expressions**: a new read-only root `feature` with a fixed, typed
  field set: `title` (string), `slug` (string), `description` (string —
  empty when the operator gave none), `pr` (number — null when absent).
  Hard-reference semantics like `inputs` (missing → error), except
  `description` and `pr` which are soft (null/empty is a legal state,
  `??` works).
- **Validation**: `feature` joins the allowed roots everywhere templates
  render (agent prompts, human prompts, command runs, action `with`, job
  `if`/outputs); unknown fields (`feature.nope`) are compile-time errors
  with the field list in the message.
- **Engine**: `buildEvalContext` carries the feature fields (they all
  already live on `FeatureState`).

## Capabilities

### Modified Capabilities

- `workflow-format`: the expression language gains the `feature` root
  (delta against the open `workflow-format` change's
  `workflow-definition` spec — expressions section).

## Impact

- `packages/core`: `EvalContext.feature`, `evaluatePath`, validator
  roots + `typeOf` for the fixed field set; docs table in
  `docs/expressions.md`.
- `packages/server`: `buildEvalContext` call sites already pass
  `FeatureState` — populate the new context member.
- No API, CLI, storage or migration changes.
