## 1. Core

- [x] 1.1 [core] Add a pure ISO-8601 duration parser (`parseIsoDurationMs`) next to the budget arithmetic and export it.
- [x] 1.2 [core][test] Unit-test the parser: `PT10M`, `PT6H`, `PT1H30M`, `P1DT2H`, fractional seconds, malformed input and zero.

## 2. Engine

- [x] 2.1 [server] Resolve the elapsed deadline from `step.retry.maxElapsed` in `planFailureDisposition`, falling back to the failure class default.
- [x] 2.2 [server] Apply the same precedence in `resetRetryEpisodeForRecover` so recovery keeps the step's deadline.
- [x] 2.3 [server][test] Engine test: a step deadline above the class default schedules a retry where the class default would escalate; a step deadline below the class default escalates where the default would retry.

## 3. Docs and verification

- [x] 3.1 [docs] Update `docs/workflow-reference.md` (`steps[*].retry`) and the `RetryPolicy.maxElapsed` comment to state the override, not a planned gap.
- [x] 3.2 [test] Run typecheck and the core/server suites.
