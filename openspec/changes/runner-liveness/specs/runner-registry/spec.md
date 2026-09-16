## ADDED Requirements

### Requirement: Registrations have bounded endpoint leases

The daemon SHALL expire registrations 60 seconds after their last announce. Same-endpoint refresh SHALL retain the id and union projects. Different endpoints SHALL NOT supersede each other based on host or PID.

#### Scenario: Runner restart uses a fresh port
- **WHEN** a runner restarts on another port and only the new endpoint keeps announcing
- **THEN** the old endpoint expires while the new endpoint and other live same-host runners remain eligible

### Requirement: Writes are protected by authenticated health probes

The daemon SHALL probe authenticated callback GET /v1/health before each write. Only definitive pre-connect failures SHALL permit skipping an endpoint. A failed inconclusive probe SHALL prevent writes and open resource waiting. Ambiguous POST failures SHALL NOT be replayed against another endpoint by the transport.

#### Scenario: Dead first endpoint
- **WHEN** the first candidate refuses the health connection and another is healthy
- **THEN** dispatch uses the healthy candidate without sending a write to the dead endpoint or consuming an attempt for it

#### Scenario: POST response is lost
- **WHEN** a create, prompt or note POST resets or times out
- **THEN** the transport propagates the failure without another POST and without disguising uncertainty as an undelivered dispatch

#### Scenario: Health authentication fails
- **WHEN** the callback rejects the health probe
- **THEN** no write is sent and dispatch enters bounded runner resource waiting

### Requirement: Session reads preserve uncertainty

An unavailable, invalid or failed candidate SHALL NOT count as a negative session answer. A known owner's valid answer MAY be authoritative; unknown-owner reads SHALL remain conservative when a registration has disappeared.

#### Scenario: Unavailable owner and negative peer
- **WHEN** one candidate is unavailable and another disavows a session without known ownership
- **THEN** existence remains true and status busy, including subsequent reads after eviction or expiry

### Requirement: Undelivered dispatch uses a durable bounded wait

NoLiveRunnerError SHALL atomically conclude any claimed run with a transient_transport diagnostic and open or resume the runner resource wait without advancing workflow attempts. Repeated unavailable dispatches SHALL preserve the original deadline and observation backoff.

#### Scenario: Fresh registrations remain unhealthy
- **WHEN** runners keep announcing but health probes fail on successive observations across engine restarts
- **THEN** one wait retains its deadline and eventually exhausts rather than extending indefinitely

#### Scenario: Runner recovers
- **WHEN** a runner becomes healthy before the wait deadline
- **THEN** the next due observation dispatches once and closes the wait

### Requirement: Lease freshness is observable without credentials

The runner listing SHALL expose expiresAt and SHALL omit callback tokens. Daemon runner availability SHALL reflect unexpired registrations, not a guarantee of probe success.

#### Scenario: All leases expire
- **WHEN** no runner refreshes before its lease expires
- **THEN** the listing is empty and daemon runner availability is unavailable
