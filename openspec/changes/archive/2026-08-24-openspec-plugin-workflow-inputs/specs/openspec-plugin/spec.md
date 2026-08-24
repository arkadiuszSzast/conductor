## MODIFIED Requirements

### Requirement: Work can be started from the panel

The panel SHALL offer a start-work action for a change. Invoking it
SHALL create a Conductor feature through the daemon's existing public
feature-creation API (title derived from the change name and description
from the proposal), then navigate the Control Room to the created
feature via the host bridge. Before creating, the plugin SHALL consult
the project's workflow projection: when the workflow declares a string
input named `change_slug` or `change`, the creation request SHALL carry
`inputs` with that input set to the change's name; otherwise the request
SHALL carry no `inputs` field. A projection that cannot be fetched SHALL
NOT block the attempt — the creation proceeds without inputs and any
daemon-side validation failure surfaces as an error. Failures SHALL
surface the API error envelope's message in the panel.

#### Scenario: Start work creates a feature and navigates

- **WHEN** the user triggers start-work for change `retry-policy`
- **THEN** a feature is created via the public API with the change's
  context, and the Control Room navigates to the new feature

#### Scenario: Workflow's change input is filled automatically

- **WHEN** the project's workflow declares a required string input
  `change_slug` and the user triggers start-work for `todo-filtering`
- **THEN** the creation request carries
  `inputs: { "change_slug": "todo-filtering" }` and succeeds without
  the user typing anything

#### Scenario: No matching input, no inputs field

- **WHEN** the workflow declares no `change_slug`/`change` input
- **THEN** the creation request carries no `inputs` field

#### Scenario: API failure is shown inline

- **WHEN** the feature-creation call fails
- **THEN** the panel shows the error message from the response envelope
  and no navigation occurs
