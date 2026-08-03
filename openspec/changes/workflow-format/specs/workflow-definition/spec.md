## ADDED Requirements

### Requirement: Workflows are declarative YAML readable as GitHub Actions
A project SHALL define workflows in YAML using the top-level concepts `name`,
`on` and `jobs`; jobs SHALL contain ordered `steps` and MAY declare `needs` and
`if`. A user familiar with GitHub Actions SHALL be able to identify triggers,
dependencies, agents, commands, actions and human gates without Conductor
engine knowledge.

#### Scenario: Minimal linear workflow
- **WHEN** a workflow defines one job with an agent step followed by a command
- **THEN** validation accepts it and execution runs the two steps in order
  without requiring explicit graph syntax

#### Scenario: Unknown field is rejected
- **WHEN** a workflow contains a misspelled execution field
- **THEN** validation fails with its YAML location and suggests the closest
  valid field rather than silently ignoring it

### Requirement: Step kinds are explicit and unambiguous
Each step SHALL be exactly one of: local versioned action (`uses`), agent step
(`agent`), command (`run`) or human gate (`human`). Validation SHALL reject a
step that mixes kinds. Each step has a stable ID within its job for outputs,
audit and retries.

#### Scenario: Mixed step kinds are rejected
- **WHEN** a step contains both `uses` and `run`
- **THEN** validation rejects the workflow naming the step and the conflicting
  keys

#### Scenario: Human gate carries notes
- **WHEN** a human approves or rejects a `human` step with notes
- **THEN** the notes become durable step output available to deterministic
  downstream expressions and agent prompts

### Requirement: Expressions are deterministic and bounded
Workflow values MAY reference a documented expression context containing
workflow input, task/feature metadata, dependency outputs, step outputs,
human notes and configuration. Expressions SHALL have no ambient filesystem,
network, clock, randomness or code-evaluation capability.

#### Scenario: Output reference resolves
- **WHEN** a job references a completed dependency's declared output
- **THEN** the renderer supplies exactly the persisted value

#### Scenario: Missing required value fails before side effects
- **WHEN** a required expression resolves to no value
- **THEN** the job fails validation/readiness with diagnostics before its first
  step executes
