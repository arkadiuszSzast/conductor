# workflow-definition Specification

## Purpose
TBD - created by archiving change feature-context-in-templates. Update Purpose after archive.
## Requirements
### Requirement: Templates can read the feature's own fields

Every template position that can read `inputs` SHALL also be able to read
a `feature` root with a fixed field set: `feature.title` (string, the
operator's feature title), `feature.slug` (string, the daemon-derived
slug), `feature.description` (string, empty when the operator gave none)
and `feature.pr` (number, null when no PR is attached). `title` and
`slug` are hard references (always present); `description` and `pr` are
soft — they resolve to their empty/null value rather than erroring, so
`??` supplies defaults. Validation SHALL reject unknown `feature` fields
at load time, naming the available fields.

#### Scenario: Branch named from the slug

- **WHEN** an action input uses `feature/{{ feature.slug }}` and the
  feature's title is "Add todo priorities"
- **THEN** the value renders as `feature/add-todo-priorities`

#### Scenario: Description reaches the first agent prompt

- **WHEN** an agent prompt contains `{{ feature.description }}` and the
  operator started the feature with a description
- **THEN** the rendered prompt contains that description verbatim

#### Scenario: Unknown feature field is a load error

- **WHEN** a workflow references `{{ feature.nope }}`
- **THEN** loading fails with an error naming the available `feature`
  fields

