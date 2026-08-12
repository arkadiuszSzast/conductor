# Design — feature context in templates

## Context

- `EvalContext` (expression.ts) is `{inputs, steps, needs, feedback?,
  functions?}`; `evaluatePath` hard-errors on `inputs|steps|needs`
  misses, soft-nulls `feedback`.
- The validator whitelists roots per position (`allowedRoots`) and
  resolves types via per-position `typeOfPath` functions; everything the
  renderer can see, the validator must know statically.
- `buildEvalContext(workflow, state, jobId, feedback?)` already holds the
  full `FeatureState` — title/slug/description/pr are right there.

## Goals / Non-Goals

**Goals**: feature fields readable and statically typed in every template
position; misuse caught at load.

**Non-Goals**: exposing mutable/runtime fields (`status`, `worktree`,
`sessionId` — worktree paths flow through step outputs by design);
feature inputs machinery (deliberately out; `inputs:` declarations stay
for future event/schedule triggers).

## Decisions

### D1 — Fixed field set, typed statically

`feature` is not a bag: exactly `title: string`, `slug: string`,
`description: string`, `pr: number`. A static map in validate.ts gives
`typeOfPath` answers; unknown fields fail load with the list. This keeps
the validator honest and autocompletable, unlike a pass-through of
`FeatureState`.

### D2 — Hardness mirrors data reality

`title`/`slug` always exist → hard (MissingValueError semantics never
actually fire, but the classification matches `inputs`).
`description`/`pr` are legitimately absent → soft like `feedback`:
`description` renders as `""` when null (the store keeps `null`, the
context carries `""` — templates overwhelmingly want interpolation, not
null-checks), `pr` resolves to `null` so `{{ feature.pr ?? "none" }}`
works.

### D3 — Context is built once in buildEvalContext

One line-site: `buildEvalContext` adds `feature: {title, slug,
description: state.description ?? "", pr: state.pr}`. Everything
downstream (agent prompts, gate prompts, command render, action inputs,
job outputs) uses that function already — no per-call-site work.

### D4 — Validator: add the root everywhere `inputs` is allowed

All six `allowedRoots` sets gain `"feature"`; a shared
`typeOfFeaturePath` handles the segments in each `typeOf*` function.
Job-`if` included — `feature.*` is known before any job runs.

## Risks / Trade-offs

- **`description` as `""` vs null**: interpolation-friendly but makes
  `??` useless for description (empty string is not null). Accepted:
  prompts read better with a possibly-empty line than with `null`
  rendering; authors needing a default can use explicit conditionals
  later if the need ever materialises.

## Open Questions

None.
