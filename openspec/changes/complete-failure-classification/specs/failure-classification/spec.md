## ADDED Requirements

### Requirement: Actions report a structured failure class
An action's failure result SHALL be able to carry a class from the failure taxonomy alongside its human error text, for both in-process and subprocess actions. Conductor SHALL use a valid action-supplied class as the run's failure class. An invented or malformed class SHALL be recorded as `internal`. A failure without any class SHALL fall back to Conductor's own classification of the error. Existing actions that return no class SHALL keep working unchanged.

#### Scenario: Action supplies a valid class
- **WHEN** an action fails and reports class `transient_upstream`
- **THEN** the run's failure class is `transient_upstream` and its source is `action`, regardless of the error text

#### Scenario: Action supplies an unknown class
- **WHEN** a subprocess action returns a failure whose class is not in the taxonomy
- **THEN** the run's failure class is `internal` and the original error text is kept as the bounded diagnostic

#### Scenario: Legacy action returns no class
- **WHEN** an action returns a failure with only an error message
- **THEN** Conductor classifies the failure itself and the run still carries a class

### Requirement: Bundled GitHub and git actions classify recognisable failures
The bundled `github/*` and `git/*` actions SHALL classify failures of their `gh` and `git` invocations as follows:
- HTTP 5xx responses → `transient_upstream`
- HTTP 429 and secondary rate limits → `capacity`
- network-level failures (DNS, connection refused or reset, timeouts reaching the remote) → `transient_transport`
- authentication and permission rejections → `invalid_config`
- a missing executable → `invalid_config`
- semantic rejections by the remote (pull request not mergeable, PR head moved, required checks failed, branch or pull request already exists, non-fast-forward push) → `deterministic_failure`

#### Scenario: GitHub returns 503 while creating a pull request
- **WHEN** `github/pr-create` fails because `gh` reports `HTTP 503`
- **THEN** the run fails with class `transient_upstream`

#### Scenario: Push is rejected for missing credentials
- **WHEN** `git/push` fails with `Permission denied (publickey)`
- **THEN** the run fails with class `invalid_config`

#### Scenario: Required checks failed
- **WHEN** `github/await-checks` observes a failed required check
- **THEN** the run fails with class `deterministic_failure`, even though the reported commit SHA contains digits such as `503`

### Requirement: Fallback classification never reads status codes inside identifiers
When Conductor classifies failure text itself, status-code and exit-code patterns SHALL match only as standalone tokens. They SHALL NOT match digits embedded in commit SHAs, pull request numbers or other identifiers. An exit code SHALL only be recognised from the reported exit status of the process, never from any occurrence of the number in its output.

#### Scenario: SHA contains a rate-limit status code
- **WHEN** an unclassified failure's text is `PR #535 head moved: expected 58c13c37409ff470f4614cc1bde0353c1ceb751d, observed 4cb47e7b…` (the SHA contains `429`)
- **THEN** the failure is not classified as `capacity`

#### Scenario: Output mentions 127 without that exit status
- **WHEN** a process exits with status 1 and its output contains the text `exited 127`
- **THEN** the failure is not classified as `invalid_config` on account of that text

### Requirement: Every failed run carries a failure class
Every run Conductor concludes as failed SHALL record a failure class and source. In particular:
- an action input that cannot be rendered → `invalid_config`
- an action step whose binding is missing → `invalid_config`
- an action run orphaned by a daemon restart → `internal`
- an agent that reports its step as failed → `deterministic_failure` with source `agent`

The class SHALL be visible in run projections like any other failure class.

#### Scenario: Action input fails to render
- **WHEN** an action step's `with:` template references a value that does not exist
- **THEN** the run fails with class `invalid_config` and the render error as its diagnostic

#### Scenario: Agent reports failure
- **WHEN** an agent calls `conductor_report` with outcome `failed`
- **THEN** the run fails with class `deterministic_failure`, source `agent`, and the agent's notes as its diagnostic

#### Scenario: Daemon restarts during an action
- **WHEN** a restarted daemon finds a running action run with no live execution
- **THEN** the run is concluded failed with class `internal`
