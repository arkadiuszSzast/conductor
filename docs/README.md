# Conductor documentation

Conductor drives AI coding agents through configurable workflows the way CI
systems drive builds. Workflows are data (YAML, GitHub-Actions-style), state
is durable (SQLite), and every routing decision is made by a pure, tested
interpreter.

## Where to start

| Document | What it covers |
|---|---|
| [Install](install.md) | Installing from the repo (dev `bun link`, compiled binary), running `conductor daemon`, connecting the opencode runner, first feature, troubleshooting. |
| [Concepts](concepts.md) | The execution model: features, jobs, steps, outcomes vs failures, loops, retries/failure classes, pausing/escalation/recovery, interactive answer delivery. Read this first. |
| [Workflow reference](workflow-reference.md) | Every YAML field, with types, defaults and examples — the `conductor.yaml` counterpart to GHA's workflow syntax reference. |
| [Expressions](expressions.md) | The `{{ }}` template contexts: `inputs`, `steps`, `needs`, `feedback` — what resolves when, and what is validated. |
| [HTTP API](http-api.md) | The daemon's REST + SSE control surface: routes, feature payload projections, workflow structure endpoint, static UI serving. |
| [Plugins](plugins.md) | The plugin system: manifest format, directory layout and scopes, the backend and proxy contract, the panel/bridge protocol, the trust model, and an install walkthrough for the bundled OpenSpec plugin. |

## Status of this documentation

The YAML dialect documented here is the **authoring surface** for the
canonical IR defined in `packages/core/src/types.ts`. The IR, interpreter and
validation are implemented and tested; the YAML **parser** and the
**expression evaluator** are in progress (see
`openspec/changes/workflow-format/tasks.md`). Where a documented behaviour is
not yet wired end-to-end it is marked **(planned)** — the semantics are
decided and the data model supports them, but the resolving code has not
landed.

For design rationale and the decision log, see the OpenSpec changes:

- `openspec/changes/workflow-format/` — the YAML dialect, parser, expressions,
  action registry, triggers.
- `openspec/changes/cross-job-loops/` — outcomes, `rerun` loops, feedback,
  the normalised IR, DAG failure semantics.
- `openspec/changes/retry-policy/` — failure classification, retry/resource-wait
  budgets, the pause scheduling barrier, and operator recovery.
- `openspec/changes/harden-interactive-answer-delivery/` — the accepted/
  delivered split for answering a mid-step question.
- `openspec/changes/plugin-system/` — the plugin manifest, registry,
  supervisor/proxy, panel rail and bridge, and the bundled OpenSpec plugin.
