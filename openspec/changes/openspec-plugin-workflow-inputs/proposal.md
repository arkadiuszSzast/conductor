## Why

Start-work from the OpenSpec panel calls `POST /v1/features` with only
title/project/description. A workflow that declares a required input —
the dogfood project's `feature-delivery` requires `change_slug` — makes
the call fail with `input "change_slug" is required`, surfaced as a raw
error in the panel. The plugin knows exactly which change it is starting;
it should satisfy the workflow's own convention for receiving it.

## What Changes

- Start-work consults the project's workflow projection
  (`GET /v1/projects/workflow?dir=`) before creating the feature. When
  the workflow declares a string input named `change_slug` (or `change`),
  the plugin sends `inputs: { <name>: <change name> }` on the create
  call. Workflows without such an input get no `inputs` field — existing
  behaviour unchanged.
- Projection fetch failures degrade gracefully: the create call is made
  without inputs (the daemon's own validation still applies, and its
  error message is relayed as today).

Not in scope: a general input-collection UI in the panel (a workflow
requiring other inputs still fails with the daemon's message — honest
and visible); host or daemon changes.

## Capabilities

### Modified Capabilities

- `openspec-plugin`: start-work fills the workflow's `change_slug` /
  `change` string input with the change name when declared.

## Impact

- `plugins/openspec/serve.ts` (+ tests). Nothing else.
