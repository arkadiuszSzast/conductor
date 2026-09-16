## Implementation

- [x] [server] Replace instance supersession with endpoint leases and refresh-safe dead endpoint removal.
- [x] [server] Add authenticated pre-write probes, definitive pre-connect filtering, bounded ownership routing and conservative reads.
- [x] [runner] Add authenticated callback health route using the existing periodic announce lease refresh.
- [x] [server][db] Atomically conclude undelivered runs into bounded resource waits; preserve deadlines on repeated failed dispatches.
- [x] [server] Expose lease expiry in the token-free runner listing; availability uses the pruned registry.
- [x] [test] Cover leases, pre-connect failover, ambiguous writes, read uncertainty, probe auth and durable bounded waits.
- [x] [docs] Document contracts, trade-offs and deployment ordering.
- [x] [test] Run typecheck, full tests and lint; review final diff.
