## ADDED Requirements

### Requirement: Effort selection survives model selection
When a role binding configures both a model and an effort or variant option, the adapter SHALL apply the model selection first and the effort selection last, and SHALL confirm the effective effort before the first prompt. A role-level variant SHALL take precedence over the binding's effort option.

#### Scenario: Model switch resets effort
- **WHEN** an agent resets effort to its default on a model change
- **THEN** the configured effort is still effective for the first prompt

#### Scenario: Role variant overrides binding
- **WHEN** the role specifies variant `low` and the binding specifies effort `medium`
- **THEN** the session runs with effort `low`
