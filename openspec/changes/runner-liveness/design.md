## Context

Endpoint registrations survived runner restarts indefinitely. The hub already re-announces every 15 seconds. Hostname/PID cannot identify a runner across restart and host-wide supersession would evict independent live runners.

## Decisions

- Endpoint-upsert registrations expire 60 seconds after their last announce. Listing, lookup and availability lazily prune expired entries. No background poller, persistent registry, instance identity or host-wide eviction is needed.
- Before each write the transport sends authenticated GET /v1/health with a 10-second timeout and rejects redirects. Only definitive pre-connect failures (Bun ConnectionRefused, ECONNREFUSED, ENOTFOUND, EAI_AGAIN, including nested causes) permit skipping an endpoint. An inconclusive or rejected health probe stops dispatch with NoLiveRunnerError before sending any write. HTTP write errors propagate normally.
- POST reset/timeout and response decode failures propagate without replay or eviction. Existing engine failure policy remains responsible for ambiguous delivery; this change does not promise exactly-once execution.
- A bounded 1024-entry session-owner cache routes writes owner-first and allows authoritative owner reads. Unknown-owner reads retain uncertainty if any candidate fails or any registration has disappeared. One constant-size registry uncertainty flag deliberately persists until daemon restart; this favors TTL reaping over falsely declaring an unknown-owner session missing. Read failures themselves do not evict registrations. Cache loss falls back conservatively.
- Definitive dead endpoint removal compares the captured registration object, preventing an old in-flight failure from deleting a refreshed registration.
- NoLiveRunnerError alone opens a runner resource wait. Run conclusion and wait creation/reopening are one SQLite transaction; no interpreter failure event or attempt increment occurs. Re-observation keeps the claimed wait open until dispatch succeeds or normal failure handles the run. Repeated failed probes preserve the original wait deadline and exponential observation schedule, including after engine recreation.
- API listing exposes expiresAt; daemon availability means an unexpired registration exists, not that a health probe succeeded. No secret is projected.

## Trade-offs and alternatives

Lease expiration is simpler than process identity or periodic daemon probes and handles new ports after real process restarts. Expired endpoints can coexist with new ones for at most 60 seconds; pre-write probing handles the gap. Conservative unknown-owner reads may remain busy until run TTL after a runner disappears. Registration freshness alone cannot prove health, so dispatch probes remain necessary. All I/O stays in the engine/transport/store; the interpreter is unchanged.

## Deployment

No DB migration or configuration change. Deploy the runner callback health route before the daemon or update both together. Old runners lacking the route cause safe bounded waits. Caller owns build/deployment and service reloads; none are performed by this change.
