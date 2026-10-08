## ADDED Requirements

### Requirement: OpenCode v2 profiles are explicit and routed per project
The daemon SHALL drive steps through an OpenCode v2 server only for projects explicitly routed to a configured `runners.opencode` profile. A profile SHALL name a base URL, a password source that is an environment variable or a file and never an inline secret, a non-empty list of absolute allowed roots, and a positive concurrency limit. A step whose working directory is outside the profile's allowed roots SHALL fail as a configuration error without contacting the server. The server password SHALL never be logged, persisted in run state or exposed through the API.

#### Scenario: Directory outside allowed roots
- **WHEN** a feature routed to an opencode profile has a worktree outside every allowed root
- **THEN** the step fails with an actionable configuration diagnostic and no HTTP request is sent

#### Scenario: Inline secret in configuration
- **WHEN** the daemon configuration contains an inline password for an opencode profile
- **THEN** configuration loading is rejected

### Requirement: Agent, model and variant are validated before session creation
Before creating a session, the daemon SHALL confirm that the location's agent catalog is loaded and contains the role's agent, and that the selected model and variant are offered by the server. An empty agent catalog SHALL be retried within a bounded startup period, because it is evidence of a cold location and not of a missing agent. An agent, model or variant still absent after the catalog has loaded SHALL fail the step as an invalid configuration, and the step SHALL NOT be retried as a transient error.

#### Scenario: Cold location
- **WHEN** the first catalog read for a location returns no agents and a later read within the startup period returns them
- **THEN** session creation proceeds without failing the step

#### Scenario: Unknown variant
- **WHEN** the role selects a variant the model does not offer
- **THEN** the step fails as invalid configuration before any session is created

### Requirement: Model and variant come from one Conductor-side source
Each session SHALL be created with the complete model reference: provider, model id and variant. The workflow role's model and variant SHALL take precedence. The profile binding for the role's agent SHALL be used only for the fields the role omits. The daemon SHALL NOT rely on the agent definition's default model, and SHALL NOT change model or variant after the initial prompt of an attempt.

#### Scenario: Gate role with low effort
- **WHEN** a role specifies a model with variant `low`
- **THEN** the created session records that model with variant `low`, and every turn of the attempt runs with it

#### Scenario: Role omits the variant
- **WHEN** the role names only an agent and the binding supplies model and variant
- **THEN** the session is created with the binding's model and variant

### Requirement: Session creation and prompting are idempotent per durable operation
Session and prompt identities sent to the server SHALL be derived deterministically from the durable operation identity of the attempt. A create or prompt whose response is lost SHALL be replayed with the same identity, and SHALL NOT produce a second session or a second turn. A reused identity whose server-side record differs from the request, whether the server reports a conflict or returns the original record, SHALL be treated as unknown delivery and fenced, never retried with a fresh identity.

#### Scenario: Lost create response
- **WHEN** session creation times out after the server accepted it and the daemon retries
- **THEN** the retry resolves to the same session and the attempt continues

#### Scenario: Identity conflict
- **WHEN** a replayed prompt identity resolves to a record whose text differs from the request
- **THEN** the run is fenced as unknown delivery and is not automatically re-prompted

### Requirement: Status and abort reflect server evidence
Session status SHALL be busy while the server lists the session as active, idle when it is not active and the session is recorded idle, missing only on a confirmed not-found response, and unknown for every other failure. Abort SHALL interrupt the session without resuming queued input. Aborting an idle or missing session SHALL succeed.

#### Scenario: Server temporarily unavailable
- **WHEN** a status read fails with a connection error or a server error
- **THEN** the status is unknown and the run is neither reaped nor recreated on that evidence

### Requirement: Timeline notes never trigger inference
Notes to a feature's parent session SHALL be delivered so that they do not start an agent turn.

#### Scenario: Step summary note
- **WHEN** the engine appends a step summary to an idle parent session
- **THEN** the note is recorded and the session stays idle with no tokens spent
