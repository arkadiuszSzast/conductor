## Purpose

Ensure workflow progress is grounded in exact commit identity, complete declared CI evidence, and durable repair diagnostics rather than stale execution state.

## ADDED Requirements

### Requirement: Push returns the exact published commit

The push action SHALL resolve the named local branch before publication, publish that immutable commit to the named remote branch without force, and return that SHA. It SHALL preserve optional upstream setup and fail explicitly on invalid refs or execution errors.

#### Scenario: Checkout differs and branch moves
- **WHEN** the checkout is on another branch and the requested branch moves after resolution
- **THEN** the action publishes and returns the resolved requested-branch commit, not ambient HEAD or the moved branch

### Requirement: Checks are bound to declared commit and required names

The check gate MUST require an expected full SHA and nonempty required check names. It SHALL observe check runs and latest status contexts for that exact SHA, verify PR head before and after observation, and fail explicitly if the PR head differs. All matching observations for each required name MUST pass; completed success, neutral, or skipped check runs count as passing, but missing, pending, malformed, or unknown evidence MUST NOT pass. Irrelevant names SHALL NOT block. Empty results SHALL remain pending until the durable deadline, then fail. Check polling SHALL retain its original deadline across restart.

#### Scenario: Old green checks and absent new checks
- **WHEN** old-head checks are green but required checks for the expected head are absent or incomplete
- **THEN** the gate stays pending and eventually times out rather than succeeding

#### Scenario: Relevant failures and skipped checks
- **WHEN** a required check fails
- **THEN** the gate fails naming it
- **WHEN** every required check is completed success, neutral, or skipped and unrelated checks fail
- **THEN** the gate succeeds for the expected SHA

#### Scenario: Head changes during observation
- **WHEN** the PR head changes before or during a poll
- **THEN** the gate fails explicitly and does not silently follow the new head

### Requirement: Command reruns carry durable step-specific diagnostics

A failed command routing to rerun SHALL attach bounded redacted actual command/exit/error evidence as `feedback.jobs[job][step].diagnostic`. This SHALL persist with the rerun transition, remain available after restart even when command outputs are empty, and not overwrite user command outputs. New evidence SHALL replace stale diagnostic data for that routing step.

#### Scenario: Quality command fails without outputs
- **WHEN** a quality command fails with an actual compiler error and routes back to implementation without emitting outputs
- **THEN** the repair prompt referencing the quality step diagnostic receives that error and exit code, including after restart

### Requirement: Completion replay respects current execution state

Replayed execution decisions SHALL NOT dispatch a step which is no longer the job's current running step. Existing active-run uniqueness SHALL remain enforced.

#### Scenario: Completed reviewer outlives its unhandled predecessor
- **WHEN** a predecessor completion remains unhandled after its dispatched reviewer has completed and advanced the job
- **THEN** replay does not create another reviewer run or session
