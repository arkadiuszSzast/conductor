# Interactive steps are opt-in per step

## Why

`interactive-agent-steps` shipped ask/answer with no workflow-level
control: every agent step can ask, and the only guard is the ask tool's
description. That inverts the intended default — most steps should be
autonomous and self-sufficient, and a mid-pipeline `implement` step that
"asks instead of finishing" stalls the whole feature until a human
notices. The workflow author, not the agent, should decide which steps
may interrogate a human.

## What Changes

- **Workflow format**: agent steps gain an optional boolean
  `interactive` (default `false`). Only an `interactive: true` step may
  ask; the IR stays self-describing about where human conversation can
  happen.
- **Engine**: an `ask` reported by a run of a non-interactive step is
  rejected — the run stays running and the agent gets an instructive
  refusal ("this step is autonomous: decide and report"). No state
  changes, no feature flip.
- **Surfaces**: the workflow projection marks interactive steps so the
  web graph and docs can show where a pipeline can stop for questions.

## Capabilities

### Modified Capabilities

- `interactive-steps`: asking becomes conditional on the step's
  `interactive` flag; refusal semantics added. (The `agent` step IR
  change rides here — the `workflow-definition` capability is still an
  open change, not a main spec, so this delta owns the field.)

## Impact

- `packages/core`: `AgentStep.interactive`, parser field, no validation
  changes beyond type (boolean).
- `packages/server`: engine guard in the `ask` path; workflow projection
  carries the flag.
- `docs/`: workflow-reference (`agent` step table), concepts note.
- No migration, no API shape changes (the refusal rides the existing
  report response text).
