# Design — control-room-ux-pass

## D1. Stages, not jobs, are the board's columns

A stage is a longest-path dependency layer (`assignLayers`, the same function
the graph canvas uses). Parallel fan-out jobs are one stage, which matches how
an operator thinks about the pipeline ("it's in review") and collapses the
dogfood workflow from 22 columns to 12 stages. Within a stage a card lists
each active job with its current step, so nothing is lost by grouping.

Empty stages stay visible only in the rail (a pip on phones, a dim label on
desktop) so the pipeline shape is still readable; lanes render only for
occupied stages. A job present only in runtime state (stale projection) gets
a trailing stage of its own instead of vanishing.

Alternatives rejected: hiding empty job columns only (still 8 reviewer
columns during review); a pure list view (loses the "where in the pipeline"
reading).

## D2. Liveness is detected by silence, not by socket errors

Mobile browsers freeze backgrounded pages and drop sockets without surfacing
an error to `fetch` readers. The daemon therefore emits a comment frame every
20 s; the client records activity on every chunk and aborts a stream silent
for 50 s (2.5 pings). Foreground events trigger `resume()`: a stale or dead
stream is replaced immediately; a healthy one is resynced, rate-limited to
once per 10 s so focus flicker does not refetch.

Every `hello` after the first is a reconnect and triggers a full resync —
invalidations are stateless and cannot be replayed, so refetching on-screen
resources is the only correct recovery. This keeps "no polling in normal
operation".

## D3. Live-run lookup lives in the plugin, not a new daemon route

`GET /v1/features` already returns each feature's `input`, so the plugin
derives change → live feature itself with the same `change_slug`/`change`
input names it fills on Start work. This keeps the plugin on the public
contract and avoids a single-consumer daemon endpoint. A started queue entry
carrying a `featureId` is a fallback when the runs lookup fails.

## D4. ACP logs reuse the native runner's line vocabulary

`agent` lines carry the agent's reply text coalesced per 1 s window; `tool`
lines carry one phrase per `toolCallId`. The acp-execution spec forbids tool
arguments and thought content in logs, so tool phrases derive from the
declared `ToolKind` only (titles can embed paths and commands), and
`agent_thought_chunk` is ignored. Text passes through `boundDiagnostic`
(redaction + bound) before buffering. Buffers flush on the timer, on turn
completion and on abort; sink failures are swallowed.

## D5. Feature-wide history leaves the step inspector

Findings and timeline are feature-scoped; showing them inside a per-step
inspector implied a filter that did not exist. They move to a History panel
on the feature page. The inspector keeps only step-scoped tabs and opens on
Logs, the question a live step answers.
