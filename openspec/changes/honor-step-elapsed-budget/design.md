# Design — step elapsed budget

## Precedence

`planFailureDisposition` already resolves `maxAttempts` and `backoff` by
preferring the step's own `retry` policy over the failure class's default. The
elapsed axis is completed the same way:

```ts
const maxElapsedMs =
  step?.retry.strategy === "backoff" && step.retry.maxElapsed !== undefined
    ? parseIsoDurationMs(step.retry.maxElapsed) ?? classBehaviour.budget.maxElapsedMs
    : classBehaviour.budget.maxElapsedMs
```

- **Present and valid** → the step's duration is the deadline.
- **Present but unparseable** → fall back to the class default. Validation
  already rejects malformed durations at load time, so this only guards a
  hand-built IR; falling back is safer than an unbounded/NaN budget.
- **Absent** → class default (today's behaviour), so no existing workflow
  changes meaning.

The parser lives in `packages/core` next to the other pure budget arithmetic.
`validateRetry` calls `parseIsoDurationMs` directly as its validity check
(`undefined` ⇒ invalid) rather than maintaining a second, hand-written regex
in parallel — one canonical grammar, so validation and the runtime can never
silently diverge. It accepts `P…T…` (e.g. `PT10M`, `PT6H`, `P1DT2H`) with any
subset of components; a syntactically valid but componentless duration
("P", "PT") and a non-finite total (component values large enough to
overflow) both yield `undefined`, same as genuinely malformed input.

## Episode anchor and pause accounting are unchanged

`maxElapsedMs` only replaces the value compared against
`elapsedBudgetMs(state, now)`; the episode anchor (first attempt dispatch time),
the pause-time fold and the "deadline bounds when an attempt may START" rule
are untouched. This keeps the `retry-budget` semantics intact.

## Recovery

`resetRetryEpisodeForRecover` mints the fresh episode's budget. It uses the
same precedence so a recovered long step keeps its extended deadline instead of
being reset to the 10-minute class default — otherwise recovery would re-fail
on the first long attempt.

## Out of scope

- The pending-prompt-delivery retry path (`engine.ts` transient delivery) keeps
  the class budget: it is infrastructure retry, not the step's declared policy.
- Making the class budgets themselves configurable (a separate concern).
