## 1. Action failure class contract

- [ ] 1.1 [core] Add an optional `class` to `ActionResult`'s failed variant (`packages/core/src/action.ts`). Verify with `bun run typecheck`.
- [ ] 1.2 [server] `ActionHostExecuteResult` `ok:false` carries an optional normalized `failureClass`:
  - `toHostResult` normalizes a present class with `normalizeFailureClass` (invented → `internal`) and leaves an absent one absent;
  - `isActionResult` accepts an optional string `class`;
  - `CapabilityDeniedError` maps to `invalid_config` in the host.

  Verify with new `action-host.test.ts` cases: in-process valid class, subprocess invented class → `internal`, no class → absent, capability denied → `invalid_config`.
- [ ] 1.3 [server] `dispatchActionObservation` prefers the host-supplied class. Otherwise it falls back to `classifyThrownBoundary` when that yields a transient class, else `deterministic_failure`. The `capability_denied:` prefix check and `/exited 127/` substring check are removed. Verify with `engine.test.ts`:
  - host class `transient_upstream` → run class `transient_upstream`, source `action`;
  - unclassified `"boom"` → `deterministic_failure`;
  - output containing `exited 127` with no class → not `invalid_config`.

## 2. Bundled action classification

- [ ] 2.1 [server] Add a pure `classifyCliFailure({ tool, code, output })` helper in `packages/server/src/actions/` with anchored patterns:
  - `HTTP 5xx` → `transient_upstream`
  - `HTTP 429` / rate limit → `capacity`
  - DNS / refused / reset / i/o timeout → `transient_transport`
  - publickey / 401 / 403 / auth failed → `invalid_config`
  - exit 127 → `invalid_config`
  - otherwise `undefined`

  Verify with a table-driven unit test, including the real gloam texts (`gh pr create exited 1: HTTP 503: No server is currently available…`, `git push exited 128: git@github.com: Permission denied (publickey)`) and SHA-only texts that must return `undefined`.
- [ ] 2.2 [server] Use the helper at every `gh`/`git` exec failure site in `github-pr-create`, `github-pr-merge`, `github-await-checks` (including the thrown `read`/`verifyHead` path), `git-push`, `git-worktree` and `git-worktree-remove`. Return explicit `deterministic_failure` for semantic rejections:
  - head moved
  - checks failed
  - checks timed out
  - not mergeable
  - expected SHA changed
  - invalid inputs

  Verify with `actions.test.ts` cases: await-checks with a 503 from `gh api` → `transient_upstream`; head moved → `deterministic_failure`; pr-create 503 → `transient_upstream`; push publickey → `invalid_config`.

## 3. Engine fallback and remaining paths

- [ ] 3.1 [server] Anchor `classifyThrownBoundary` status-code matching to HTTP/status context or reason phrases, and anchor `capacity` as a word. Export it for tests, or test through the engine. Verify:
  - `PR #535 head moved: expected 58c13c37409ff470f4614cc1bde0353c1ceb751d…` (contains 429) and `checks failed for 0504fc931c…` (contains 504) are not `capacity`/`transient_upstream`;
  - `HTTP 503`, `Service Unavailable` and `429 Too Many Requests` still classify;
  - the existing `Unable to connect` test still passes.
- [ ] 3.2 [server] Attach envelopes on the remaining conclusion paths:
  - action input render error, in both `executeAction` and `reconcileActionRun` → `invalid_config`/`action`;
  - missing binding in `reconcileActionRun` → `invalid_config`/`action`;
  - restart orphan → `internal`/`daemon`;
  - the run-less missing-binding `step.failed` in `executeAction` carries `failureClass: "invalid_config"`.

  Verify by extending the existing "unparseable rendered number input" and "restart concludes an orphaned running action run" tests to assert `run.failure`.
- [ ] 3.3 [server] `reportAuthorized` with `outcome: "failed"` concludes with envelope `deterministic_failure`/`agent`, diagnostic = bounded notes. Verify:
  - an `engine.test.ts` case asserts `run.failure`;
  - the existing retry tests that report failed still pass. With `retryWorkflow`'s 10 ms backoff, the retry may now be a durable schedule, so adjust tests with clock advance + `reconcile()` where needed.

## 4. Class-default attempts for steps without a retry policy

- [ ] 4.1 [core] `step.failed` in `PipelineEvent` gains optional `failureClass`. `onFailed` uses `behaviourForClass(normalizeRetryPolicy(), failureClass).budget.maxAttempts` when `step.retry.strategy === "none"` and a class is present; otherwise behaviour is unchanged. Verify with `interpret` unit tests:
  - `retry: none` + `transient_upstream` → `execute_step` on attempt 1;
  - `retry: none` + `deterministic_failure` → terminal;
  - `retry: none` + no class → terminal;
  - explicit `maxAttempts: 2` + `transient_upstream` → terminal after attempt 2.
- [ ] 4.2 [server] `concludeAndDispatch` copies `detail.failure.class` onto the `step.failed` event before `interpret`. Verify with engine tests:
  - an action step without `retry:` failing with host class `transient_upstream` gets a scheduled retry episode and is redispatched after clock advance + `reconcile()`;
  - a `deterministic_failure` on the same workflow escalates with no episode;
  - a `transient_transport` failure on `linearWorkflow` no longer escalates on first failure (update the existing "runner resource waits" / classification tests if their expectations relied on single-attempt escalation).
- [ ] 4.3 [server][test] Exhaustion path: a `retry: none` step failing `transient_transport` repeatedly reaches `step.budget_exhausted` / escalation with class and attempts in the reason. Verify with an engine test advancing the clock through the class-default budget.

## 5. Verification and docs

- [ ] 5.1 [test] Run `bun run typecheck` and `bun test` from the repo root; both green.
- [ ] 5.2 [docs] Update `docs/workflow-reference.md`:
  - retry section: class-default attempts apply when `retry:` is omitted;
  - action protocol: optional `class` on a failed result.

  Add a "Status" line to `docs/jev-spike.md` pointing at this change. Verify the docs mention both behaviours.
- [ ] 5.3 [review] Post-implementation review pass:
  - the interpreter stays pure (only reads `event.failureClass`);
  - no new DB columns;
  - redaction/bounding still applies to every new diagnostic.
