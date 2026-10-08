# Control Room UX pass: live refresh, stage board, visible agent logs

## Why

Day-to-day use of the Control Room — in particular as an installed PWA on a
phone — surfaced six problems:

- **Views go stale.** A backgrounded mobile PWA loses its SSE stream without
  any error, the app never notices, and on reconnect it only refreshes
  health, so every invalidation sent meanwhile is lost. The daemon sends no
  keep-alive, so idle streams also die silently behind proxies. The OpenSpec
  panel and the workflow projection never refresh at all.
- **The board is one column per job.** The dogfood workflow has 22 jobs (eight
  parallel reviewers, three architects…), so the board is 22 mostly empty
  `name (0) —` columns. On a phone you have to hunt for the active one.
- **RECENT grows without bound.** "show all" expands the strip inside a board
  that cannot scroll, so the extra entries are unreachable; on a phone the
  preview alone takes half the screen.
- **The OpenSpec panel always offers Start work**, even for a change a live
  feature is already delivering, and gives no way to jump to that run.
- **Agent steps have no logs under ACP.** The ACP transport records session
  updates only in an in-memory ring buffer nobody reads; it never writes to
  `run_log`. Every ACP `implement` run in the dogfood database has zero log
  lines, while native-runner runs have tens of thousands.
- **Timeline sits inside the step inspector** although it is feature-wide.

## What Changes

- **Live refresh** — the daemon sends a `: ping` SSE comment every 20 s. The
  client tracks stream activity, aborts a stream silent for 50 s, reconnects
  immediately (no backoff) when the app returns to the foreground
  (`visibilitychange`, `pageshow`, `online`, `focus`), and on every reconnect
  `hello` resyncs the list, health, workflows, plugins and the open feature.
  A healthy stream is still resynced on foreground, at most every 10 s.
- **PWA manifest** — `manifest.webmanifest`, icon, theme colour and
  standalone display so the installed app behaves like one.
- **Stage board** — columns become pipeline *stages*: every job at the same
  dependency layer shares one stage, labelled by its common stem
  (`review ×8`). A compact rail shows the whole pipeline; only stages with
  work render as lanes; each card lists its active jobs there with their
  current step. On load the first stage needing a human (else the first
  occupied one) is scrolled into view. The phone layout stacks the lanes; the
  per-job stage selector is removed.
- **RECENT** — the board is one vertical scroll region; "show all" opens a
  bounded, internally scrolling list; phones preview two entries.
- **OpenSpec panel** — a new plugin route `GET /runs` maps live features of
  the project to the change they deliver (via the `change_slug`/`change`
  start input). Such a change shows its status and `job › step` and a
  **Show run** button instead of Start work/Queue. The bridge's `navigate`
  message gains an optional `job`. The panel refreshes every 15 s while
  visible, on becoming visible, and on host context changes.
- **ACP run logs** — ACP `agent_message_chunk` text (redacted, coalesced per
  1 s window) and one phrase per tool call (from the tool's declared kind
  only, never its title or arguments) are written to `run_log` as `agent` /
  `tool` lines. Thought content is never written.
- **Inspector & history** — the step inspector opens on Logs, follows the
  tail, shows the run status, and explains an empty log by step kind.
  Findings and timeline move to a feature-level History panel below the
  graph (collapsed on phones); long failure reasons are clamped. A `?job=`
  deep link on a phone opens the inspector sheet.

## Capabilities

### Modified Capabilities

- `web-ui` — live-update resilience, stage board, bounded recent history,
  feature-level history, inspector logs-first.
- `openspec-plugin` — live-run awareness and Show run.
- `acp-execution` — session output reaches the run log.

## Impact

- `packages/server` — `api.ts` (keep-alive), `acp/run-log.ts` (new),
  `acp/sessions.ts`, `runner-router.ts`.
- `apps/web` — store/SSE reader, board (`workflow-board.ts`, new
  `stage-rail`/`stage-lane`, removed `job-column`/`stage-selector`),
  overview strip, feature view, step inspector, new `feature-history`,
  bridge, `public/` manifest.
- `plugins/openspec` — `serve.ts` `/runs`, `ui/app.js`, `ui/style.css`.
- Docs: `docs/http-api.md`, `docs/plugins.md`.
- No database migration; no `@conductor/core` change.
