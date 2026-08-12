# Interactive agent steps — ask/answer within one session

## Why

An agent step is atomic today: the session runs to completion and reports.
When the work genuinely needs a human decision mid-step (openspec-explore
style clarifying questions), the only workaround is a rerun loop through a
human gate — every round is a fresh session that loses the conversation
context whose continuity is the whole value of an exploration session. The
gate-prompts change delivered the answering surface; this change lets a
*running* step use it without dying.

## What Changes

- **Runner protocol**: an agent can report `ask` instead of an outcome —
  questions travel as the payload (the `conductor-questions` convention).
  The opencode runner plugin grows a `conductor_ask` tool.
- **Engine**: an asking run stays alive (session preserved). The feature
  becomes `waiting_human`; the pending question is persisted on the run
  (restart-safe). While waiting, idle nudging/reaping is suspended for
  that run; a separate answer timeout (default: none) can conclude the
  step as failed if configured.
- **Answering**: a new API endpoint answers a run's question with notes;
  the engine forwards the notes into the *same session* as a prompt (the
  nudge transport) and the feature returns to `running`. The web UI reuses
  the gate answer form (options + custom answer) on features waiting on an
  asking run; the CLI gets `conductor answer <run-id> --notes`.
- **Interpreter**: untouched — asking is an engine/run-level state, not a
  workflow routing event. No workflow YAML changes; any agent step can ask.

## Capabilities

### New Capabilities

- `interactive-steps`: the ask/answer lifecycle of a running agent step —
  runner protocol event, engine state, persistence, answering surfaces,
  and timeout/reaping semantics.

### Modified Capabilities

<!-- gate-prompts stays as-is: the answer form convention is reused
     verbatim; no requirement there changes. -->

## Impact

- `packages/server`: run store (pending question columns), engine (ask
  handling, answer path, nudge/reap exemption), API (`POST
  /v1/runs/:id/answer`, question in projections), runner transport reuse.
- `packages/runner-opencode`: `conductor_ask` tool in the plugin.
- `apps/web`: gate answer form also renders for asking runs.
- `packages/cli`: `conductor answer`, question in `status`.
- `packages/core`: no interpreter changes; no workflow format changes.
- `docs/`: runner protocol and concepts updates.
