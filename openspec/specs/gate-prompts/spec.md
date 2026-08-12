# gate-prompts Specification

## Purpose
TBD - created by archiving change human-gate-prompt. Update Purpose after archive.
## Requirements
### Requirement: Human gates carry an optional prompt template

A `human` step SHALL accept an optional `prompt` field: a template string
using the same expression grammar and contexts as agent prompts —
`inputs.*`, `steps.*` (earlier steps of the same job) and `needs.*`
(declared outputs of dependency jobs). A `human` step without `prompt`
SHALL remain valid and behave exactly as today. Validation SHALL apply the
same reference rules as agent prompts: unknown contexts, later-step
references and undeclared `needs` outputs are validation errors.

#### Scenario: Gate quotes an earlier agent's questions

- **WHEN** a workflow declares a `human` step with
  `prompt: "Answer these questions: {{ steps.explore.outputs.report }}"`
  where `explore` is an earlier agent step in the same job
- **THEN** the workflow validates without errors

#### Scenario: Prompt referencing a later step is rejected

- **WHEN** a `human` step's `prompt` references
  `steps.<later-step>.outputs.report` for a step declared after the gate
- **THEN** validation fails with an error naming the reference

#### Scenario: Gates without prompts stay valid

- **WHEN** a workflow declares `human: {}` with no prompt
- **THEN** the workflow validates and the gate arms exactly as before

### Requirement: The prompt is rendered when the gate arms and persisted

The engine SHALL render the gate's prompt template exactly once, when the
step enters `waiting_human`, against the same evaluation context an agent
step dispatched at that point would receive (live step outputs, dependency
outputs, trigger inputs, feedback when re-armed inside a rerun round). The
rendered text SHALL be persisted with the feature so it survives daemon
restarts. A render error SHALL NOT block the gate: the gate still arms, the
prompt is presented with the unresolved parts empty, and the render errors
are logged.

#### Scenario: Rendered prompt survives a restart

- **WHEN** a gate with a prompt arms and the daemon is restarted while the
  feature is `waiting_human`
- **THEN** the persisted rendered prompt is still available to approver
  surfaces after the restart

#### Scenario: Re-armed gate re-renders with the new round's context

- **WHEN** a gate inside a rerun loop arms again after a rejection round
- **THEN** the prompt is re-rendered against the current round's context
  (including `feedback.*` where declared)

### Requirement: Approver surfaces present the pending gate prompt

The feature detail projection SHALL include the rendered prompt for each
step currently `waiting_human` (absent when the gate declares none). The
web UI gate panel SHALL display the prompt above the decision controls.
The CLI feature-detail view SHALL print the prompt for a feature waiting
on a gate. Surfaces SHALL treat the prompt as plain text.

#### Scenario: API exposes the prompt while waiting

- **WHEN** a feature is `waiting_human` at a gate that declared a prompt
- **THEN** the feature detail response carries the rendered prompt text
  attached to that gate step

#### Scenario: No prompt, no field

- **WHEN** a feature is `waiting_human` at a gate without a prompt
- **THEN** the feature detail response carries no prompt for that step and
  clients render the gate as they do today

#### Scenario: Answers flow to the next step unchanged

- **WHEN** an approver submits a decision with notes at a gate that showed
  a prompt
- **THEN** the notes are published as the gate step's `notes` output,
  readable by later steps as `steps.<gate>.outputs.notes`, exactly as for
  promptless gates

### Requirement: Structured questions render as an answer form

When a rendered gate prompt contains a fenced code block tagged
`conductor-questions` whose body is a JSON array of question objects —
each with a `question` string and an optional `options` array of strings —
the web UI SHALL render an answer form for the gate: per question, the
suggested options as single-choice controls plus a free-text field for a
custom answer. Submitting the decision SHALL serialise the answers into
the decision notes as plain-text question/answer pairs (the custom text
verbatim when provided, the chosen option otherwise). A malformed block
(unparseable JSON, wrong shape) SHALL degrade to the plain-text prompt
rendering — never an error, never a blocked gate. Surfaces without form
support (CLI today) SHALL present the same prompt as text; notes stay
free text at the API boundary either way.

#### Scenario: Options plus custom answer

- **WHEN** a gate prompt embeds a `conductor-questions` block with one
  question offering `["SQLite", "Postgres"]` and the approver picks the
  free-text field and types "DynamoDB"
- **THEN** the submitted notes contain the question paired with
  "DynamoDB"

#### Scenario: Suggested option chosen

- **WHEN** the approver picks the suggested option "SQLite" and submits
- **THEN** the submitted notes contain the question paired with "SQLite",
  and the downstream step reads it via `steps.<gate>.outputs.notes`

#### Scenario: Malformed block degrades to text

- **WHEN** the fenced block's body is not valid JSON
- **THEN** the gate presents the prompt as plain text with the usual
  free-form notes field, and the decision flow is unaffected

