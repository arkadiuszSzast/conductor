## Why

The seed's pipelines are data, but they are mostly ordered JSON lists with
`goto` loops and engine-owned "builtin" names. They cannot express independent
jobs, fan-out/fan-in, reusable versioned actions or event triggers. Extending
the system means adding code to the engine rather than composing capabilities.

Conductor needs a workflow format that feels immediately familiar to someone
who knows GitHub Actions, while preserving the seed's agent-native semantics:
explicit reports, verdict routing, findings, human gates, bounded loops and
worktree context. This change defines and implements that format.

## What Changes

- `conductor.yaml` with GHA-style `name`, `on`, `jobs`, `needs`, `if`, `steps`,
  `uses`, `with`, `run`, `env` and expression contexts.
- Job DAG execution: dependencies, fan-out/fan-in, skip propagation and
  deterministic readiness; simple single-job linear workflows stay simple.
- Step kinds: versioned local `action`, `agent`, `command`, and `human` gate.
- Local action registry for v1 (`actions/<name>@v1`) with manifests, typed
  inputs/outputs, capability declarations and process isolation. Git-based
  action resolution is deferred.
- Triggers: manual and schedule in v1; webhook event names are validated and
  represented but transport/ingress arrives later.
- A converter from legacy conductor JSON to YAML preserving semantics.

## Non-goals

- No arbitrary JavaScript action marketplace or git action resolver in v1.
- No hosted execution, containers or distributed job runners.
- No prompt/agent-loop DSL — agent runtimes own their loops.
- No LLM-based routing; conditions are deterministic expressions.
