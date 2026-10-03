## ADDED Requirements

### Requirement: Agent steps can declare replay safety
An agent step MAY declare `replaySafe: true`. The declaration asserts that re-running the step from scratch after a possibly delivered prompt cannot cause harm, for example a review that only reads the worktree and reports.

- **Default:** absent means `false`.
- **Other step types:** `replaySafe` on a non-agent step SHALL be a validation error.
- **Interactive steps:** declaring `replaySafe: true` on an `interactive: true` step SHALL be a validation error, because an answered question may already have influenced external effects.

#### Scenario: Review step opts in
- **WHEN** a workflow declares `replaySafe: true` on a review agent step
- **THEN** the loaded workflow exposes the flag and uncertain executions of that step may be classified `replay_safe`

#### Scenario: Invalid placement
- **WHEN** `replaySafe` is set on a command step or on an interactive agent step
- **THEN** workflow validation fails with an error naming the step
