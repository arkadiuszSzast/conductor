## ADDED Requirements

### Requirement: Changes can be queued from the panel

The panel SHALL offer a queue action next to start-work for every active change, plus a dequeue action for a queued change that has not started. Queueing SHALL go through the daemon's public queue API, and a refusal (cycle, unknown dependency) SHALL show the API error message in the panel. The panel SHALL show, for every active change, its declared dependencies and, when queued, its queue state and reason. The panel SHALL expose the project's queue pause/resume control and parallelism limit. Start-work SHALL keep running a change immediately, outside the queue.

#### Scenario: Queue a change

- **WHEN** the user queues `dialogue-node-atomic-commit`, which depends on `unify-content-gates`
- **THEN** the change shows as queued with the reason "waiting for `unify-content-gates`"

#### Scenario: Refusal shown inline

- **WHEN** queueing fails because the change's dependencies contain a cycle
- **THEN** the panel shows the cycle diagnostic from the response and the change is not shown as queued

#### Scenario: Blocked change explains itself

- **WHEN** a queued change is blocked because its dependency's feature escalated
- **THEN** the panel shows the change as blocked and names the escalated dependency
