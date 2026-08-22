## ADDED Requirements

### Requirement: Manual starts resolve declared workflow inputs

A manual feature start MAY supply an `inputs` object whose keys correspond to the selected workflow's declared inputs. Before creating the feature or performing any workflow side effect, Conductor SHALL reject unknown keys, missing required keys, values whose JSON types do not exactly match `string`, finite `number`, or `boolean` declarations, and non-object input payloads. It SHALL apply declared defaults for omitted optional inputs and SHALL persist the fully resolved input map in the feature's durable state before dispatching `feature.start`.

Input validation and default resolution SHALL be deterministic and shared independently of the initiating client. The feature title and description SHALL remain feature metadata and SHALL NOT implicitly populate workflow inputs. Existing manual starts that omit `inputs` SHALL remain valid when the workflow declares no required inputs.

#### Scenario: Required inputs reach the first step

- **WHEN** a workflow declares required typed inputs and a manual client supplies matching values
- **THEN** the feature is created with those values in its durable input map
- **AND** the first step can render them through the `inputs` expression context

#### Scenario: Optional defaults are persisted before dispatch

- **WHEN** a manual start omits an input that declares a default
- **THEN** the default is present in the feature's durable input map before the first workflow step is dispatched

#### Scenario: Missing required input has no side effects

- **WHEN** a manual start omits a required workflow input
- **THEN** the start is rejected with a diagnostic naming the missing input
- **AND** no feature, run, session, command, or action is created

#### Scenario: Unknown or mistyped input has no side effects

- **WHEN** a manual start supplies an undeclared input or a value of the wrong declared type
- **THEN** the start is rejected with a diagnostic naming the invalid input and expected type
- **AND** no feature is created

#### Scenario: Existing no-input workflow remains compatible

- **WHEN** a manual client omits `inputs` for a workflow with no required inputs
- **THEN** the feature starts with declared defaults applied and no compatibility migration is required

### Requirement: Workflow discovery exposes safe input definitions

The project workflow structure projection SHALL include the workflow's input definitions as a name-keyed map containing only each input's type, required/optional presence, and optional default. The projection SHALL continue to exclude prompts, expressions, role bindings, model names, action payloads, retry policies, and other workflow authoring content. Valid and stale projections SHALL expose the input definitions from the exact workflow snapshot they serve.

#### Scenario: Client discovers a start form schema

- **WHEN** a project workflow declares required and defaulted inputs
- **THEN** its structure projection returns each input's name, type, presence, and default when present
- **AND** a manual client can construct typed controls without reading `conductor.yaml`

#### Scenario: Discovery does not reveal runtime bindings

- **WHEN** the workflow also declares roles, models, prompts, expressions, and action payloads
- **THEN** the structure projection exposes none of those values alongside the input definitions
