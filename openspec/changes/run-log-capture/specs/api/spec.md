# api — feedback snapshot in feature detail (delta)

## ADDED Requirements

### Requirement: Feature detail exposes the rerun feedback snapshot

The feature **detail** payload (`GET /v1/features/:id`) SHALL include
`feedback` — the feedback snapshot attached by the most recent rerun
transition, exactly as the store holds it, or null when no rerun has ever
occurred. The feature **list** payload SHALL NOT include it. The
lifecycle follows the engine's persistence semantics: the snapshot is
written only by a transition that carries feedback (a rerun) and is never
cleared — after the first rerun it persists for the feature's lifetime,
and a later rerun replaces it. Clients determine whether a rerun loop is
in flight by combining the snapshot with live job state (a feedback
target job active again), not from the snapshot's presence alone.

#### Scenario: Detail carries the snapshot after a rerun

- **WHEN** a review step's rejection triggers a rerun and a client
  requests the feature detail
- **THEN** the payload's `feedback` field carries the persisted snapshot
  (the rerun's source outputs and message)

#### Scenario: Null before any rerun

- **WHEN** a feature has never gone through a rerun transition
- **THEN** the detail payload's `feedback` is null

#### Scenario: Snapshot persists after the loop completes

- **WHEN** the rerun round completes and the feature advances past the
  rerun target jobs
- **THEN** the detail payload's `feedback` still carries the last rerun's
  snapshot (it is never cleared)

#### Scenario: List payload omits it

- **WHEN** a client requests `GET /v1/features`
- **THEN** list items do not include a `feedback` field
