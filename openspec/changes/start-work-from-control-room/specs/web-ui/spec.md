## ADDED Requirements

### Requirement: Operators can start work from Control Room

The authenticated Control Room shell SHALL expose a persistent "Start work" action on every route, and useful board empty states SHALL expose the same action. Activating it SHALL open an application-owned start surface that renders as an accessible dialog on wide viewports and a bottom sheet on narrow viewports. The surface SHALL collect a configured project/workflow target, a required feature title, an optional multiline task description, an optional existing pull-request number, and values for the selected workflow's declared inputs.

The surface SHALL manage focus, restore focus to its trigger, close through an explicit control or Escape while idle, keep actions reachable within the dynamic mobile viewport and safe-area insets, and remain usable from 320 CSS pixels without document-level horizontal overflow. Agent and model selection SHALL NOT appear in this surface because workflow roles own those bindings.

#### Scenario: Start action is available from the board

- **WHEN** an authenticated operator opens the Control Room board
- **THEN** a visible "Start work" action is available without using the CLI
- **AND** activating it opens the start surface with focus moved to its first actionable control

#### Scenario: Start action remains available in a feature workspace

- **WHEN** an authenticated operator is inspecting an existing feature
- **THEN** the same global "Start work" action remains available

#### Scenario: Start surface fits a narrow mobile viewport

- **WHEN** the start surface opens at 320 CSS pixels and a text field receives focus
- **THEN** its content scrolls within the surface rather than the document
- **AND** its cancel and submit controls remain reachable above the software keyboard and safe-area inset

### Requirement: Start-work targets reflect registered project workflows

The start surface SHALL derive selectable targets from daemon health and the selected project's current workflow projection rather than from existing feature cards. Projects in `valid` state SHALL be selectable. Projects in `stale` state SHALL remain selectable using their last valid workflow snapshot and SHALL display the reload diagnostics as a warning. Projects in `invalid` or `unregistered` state SHALL NOT be startable and SHALL display why. Runner unavailability SHALL be a visible warning but SHALL NOT block durable feature creation.

Each configured project currently contributes exactly one project/workflow target. Selecting a project SHALL load and display that workflow; the UI SHALL NOT imply that multiple workflow files can be chosen within one project. If exactly one eligible target exists it SHALL be preselected; if multiple eligible targets exist the operator SHALL make or confirm an explicit selection. The workflow name observed by the form SHALL be submitted with the request so a configuration change before submission fails visibly instead of starting under a different workflow.

#### Scenario: Operator selects between configured targets

- **WHEN** health reports multiple valid projects with different registered workflows
- **THEN** the start surface presents each project/workflow target distinctly
- **AND** requires the operator to choose or confirm which target receives the work

#### Scenario: One eligible target is preselected

- **WHEN** health reports exactly one valid or stale project
- **THEN** that project's workflow target is selected automatically

#### Scenario: Stale target remains startable with warning

- **WHEN** a project retains a last valid workflow snapshot after a failed reload
- **THEN** the target remains selectable
- **AND** the start surface explains that the last valid snapshot will be used and shows its diagnostics

#### Scenario: Invalid target cannot start work

- **WHEN** a registered project has no valid workflow snapshot
- **THEN** the start surface displays the project as unavailable with diagnostics
- **AND** does not enable submission for that target

#### Scenario: Runner unavailability does not discard a task

- **WHEN** the selected workflow is valid but daemon health reports no available runner
- **THEN** the start surface warns that execution may wait for a runner
- **AND** still permits the operator to create the durable feature

### Requirement: Start surface renders declared workflow inputs

The start surface SHALL render one labeled control for every input definition exposed by the selected workflow. String, number, and boolean definitions SHALL use controls that preserve their declared type. Required inputs SHALL be identified textually and omitted required values SHALL block submission. Inputs with defaults SHALL initialize from those defaults and MAY be left unchanged. Client validation SHALL provide immediate feedback, while the daemon remains authoritative for input names, types, required values, and defaults.

Changing the selected target SHALL replace the input controls with the newly selected workflow's definitions without reinterpreting values from the previous workflow. The operator's feature description SHALL remain separate from workflow inputs and SHALL NOT be copied implicitly into a similarly named input.

#### Scenario: Required typed inputs are collected

- **WHEN** the selected workflow declares a required string, number, and boolean input
- **THEN** the start surface renders labeled controls for all three definitions
- **AND** submits values with their corresponding JSON types

#### Scenario: Defaults initialize optional inputs

- **WHEN** the selected workflow declares optional inputs with defaults
- **THEN** each control initially displays its declared default
- **AND** an unchanged submission resolves to those default values

#### Scenario: Switching targets replaces workflow-specific fields

- **WHEN** the operator enters values for one workflow and selects another project/workflow target
- **THEN** the surface renders only the new workflow's input definitions
- **AND** does not submit fields belonging only to the previous workflow

### Requirement: Feature creation is authoritative and preserves operator intent

Submitting a valid start form SHALL create the feature through the daemon's canonical manual-start operation. While the request is unresolved, the form SHALL disable repeated submission and SHALL prevent accidental dismissal. The browser SHALL NOT optimistically invent a feature or feature id.

On success, the browser SHALL apply the returned feature detail as authoritative state, reconcile list-backed views without allowing an older in-flight response to remove the new feature, close the surface, and navigate directly to the new feature workspace. A list-refresh failure after a successful creation SHALL NOT present the creation itself as failed. On validation, configuration-race, authentication, network, or server failure, the surface SHALL preserve all operator-entered fields, show an actionable inline error, and SHALL NOT navigate. A `401` from creation or discovery SHALL return the application to the auth gate like any other authenticated request.

#### Scenario: Successful start opens the feature workspace

- **WHEN** the daemon accepts a start request and returns a created feature
- **THEN** the surface closes and the browser navigates to that feature's workspace
- **AND** the returned detail is available immediately without waiting for an SSE invalidation

#### Scenario: Duplicate submit is blocked while pending

- **WHEN** a start request is in flight
- **THEN** further submit activation sends no additional start request
- **AND** Escape, backdrop, and close controls do not discard the pending form

#### Scenario: Server rejection preserves the form

- **WHEN** the daemon rejects workflow inputs or reports that the selected workflow changed
- **THEN** the surface remains open with the title, description, pull-request number, and input values preserved
- **AND** displays the server error and refreshes affected target metadata where configuration may have changed

#### Scenario: Post-create list refresh fails

- **WHEN** feature creation succeeds but the following feature-list refresh fails
- **THEN** the browser still treats creation as successful and opens the returned feature
- **AND** retains or inserts that feature in the current list projection until later reconciliation
