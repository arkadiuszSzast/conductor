# Tasks — retry-policy

## 1. Failure model and policy validation

- [ ] [core] Define the stable v1 failure taxonomy, retry hints and normalized tries+elapsed policy with per-class overrides.
- [ ] [core] Implement policy precedence/validation and pure exhaustion/routing decisions.
- [ ] [runner][server] Map opencode/provider, transport, shell/action, validation and cancellation failures into the taxonomy.
- [ ] [test] Add exhaustive classification and invalid-policy contract tests; prove no routing parses human message text.

## 2. Pure scheduling

- [ ] [core] Implement overflow-safe exponential backoff, bounded jitter, retry-after clamping and remaining-budget checks using injected clock/random.
- [ ] [test] Add table/property tests for growth/cap/jitter bounds, deadline edges, clock skew and deterministic seeded schedules.

## 3. Durable retry state

- [ ] [db] Add additive retry episode/state/history columns/tables and indexes for due-work queries.
- [ ] [server] Persist failed attempt + schedule atomically; implement transactional due-retry claim and restart recovery.
- [ ] [test][db] Cover crash before/after scheduling, restart before/after due time and two-reconciler duplicate prevention.

## 4. Escalation and operations

- [ ] [server] Persist structured budget-exhaustion summaries and implement audited human resume with reset/override.
- [ ] [cli] Expose retry state/budget in status/logs and resume override flags with safe confirmation.
- [ ] [server] Add structured retry logs and bounded-cardinality metrics hooks.
- [ ] [test] Simulate prolonged provider outage/recovery and deterministic failure; verify patient retry versus immediate route.
- [ ] [docs] Publish failure taxonomy, defaults, configuration recipes and outage/runbook guidance.
- [ ] [review] Review retry storms, clock behavior, budget off-by-one semantics and secret-safe diagnostics.
