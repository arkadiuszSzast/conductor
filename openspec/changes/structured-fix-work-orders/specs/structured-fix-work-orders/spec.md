## Purpose

Make accepted review work explicit and durable so fix rounds act on scoped blocking findings instead of repeating implementation narratives.

## ADDED Requirements

### Requirement: Opt-in validated review completion
A structured review gate SHALL accept only a schema-valid report associated with its configured reviewed head. Explicit blocking decisions SHALL determine approved versus changes_requested consistency, independently of severity. Unconfigured workflows SHALL retain narrative reporting. Invalid reports MUST leave the run active without finding or routing side effects.

#### Scenario: Invalid or contradictory review
- **WHEN** a gate submits malformed findings, a mismatched head, or approval with active blockers
- **THEN** the report is rejected without concluding the run or changing findings

#### Scenario: Plain report
- **WHEN** an unconfigured agent reports ordinary notes
- **THEN** existing reporting behavior is unchanged and prose is not parsed into findings

#### Scenario: Runner tool structured report
- **WHEN** a runner agent submits an optional review object using conductor_report
- **THEN** the actual plugin schema and transport preserve the HTTP report shape and the daemon applies the same head, verdict and lifecycle checks before completion
- **AND** omitted review payloads retain the existing non-opt-in report behavior

### Requirement: Durable stable finding lifecycle
Accepted gate findings SHALL use feature-local stable IDs and explicit blocking/nonblocking decisions, locations, acceptance tests, source run and reviewed head. Previously accepted findings from that gate MUST be explicitly carried forward or resolved/dismissed. Reopening a fixed or dismissed ID MUST require a reason. Finding updates, run completion and routing MUST be atomic and duplicate-safe.

#### Scenario: Reuse across rounds
- **WHEN** the next review resolves, dismisses or reopens an existing finding with valid disposition
- **THEN** its ID is preserved and the previous accepted round remains available in run outputs

#### Scenario: Scope isolation
- **WHEN** a gate attempts to update another gate's or feature's finding
- **THEN** the report is rejected without mutation

### Requirement: Deterministic scoped fix execution
An opted-in implementation step SHALL use its full original prompt initially and a separate concise fix prompt for a configured accepted work order or quality diagnostic in the current feedback snapshot. Fix input MUST include only active accepted blockers with acceptance tests, locations, stable IDs and previous reviewed head/source run; it MUST NOT inject prior implementation narrative. Recovery notes SHALL retain their existing retry inheritance behavior.

#### Scenario: Initial full implementation
- **WHEN** no configured work order or quality diagnostic exists in feedback
- **THEN** the original implementation prompt is used unchanged

#### Scenario: Blocking fixes
- **WHEN** current feedback contains an accepted work order from the configured gate
- **THEN** the concise fix prompt includes its active blockers and reviewed head but not nonblocking findings or prior implementation narrative

#### Scenario: No blockers
- **WHEN** a configured accepted work order has no active blockers
- **THEN** the fix prompt states that no blocking review work remains rather than repeating full implementation

#### Scenario: Quality and recovery
- **WHEN** the configured quality step failed and the implementation run carries operator recovery notes
- **THEN** the fix prompt includes that step's diagnostic and the recovery header without unrelated stage feedback

#### Scenario: Later round isolation
- **WHEN** the current feedback snapshot no longer contains the configured gate or diagnostic
- **THEN** no older work order or unrelated stage report is injected
