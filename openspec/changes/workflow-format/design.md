# Design — workflow-format

## Context

The seed format is JSON with an ordered `pipeline` array. Routing uses `then`,
`on_fail.goto`, `on_verdict`, `rounds_with`, `requires_human`. This is readable
for linear flows and its pure interpreter is well tested, but it conflates
workflow definition, runtime bindings and engine action names. DAG semantics
must be added without throwing away the loop/gate/finding semantics that make
the seed useful.

## Decisions

### Document shape

Use YAML with a deliberately small GHA-shaped dialect: `name`, `on`, `inputs`,
`jobs`; each job has `needs`, `if`, `runs-on`/runner selection, `steps`,
`outputs`; steps have a stable `id` plus one of `uses`, `agent`, `run`, `human`.
The parser converts YAML into a versioned canonical IR; engine/interpreter only
see IR, never YAML nodes.

Use a schema version field (`conductor: v1`) for evolution. Validation is
strict and source-mapped: unknown keys are errors. YAML aliases/custom tags
are disabled; duplicate keys are errors; input size and nesting are bounded.
This avoids surprising parser semantics and denial-of-service shapes.

### Graph interpretation

Jobs are DAG nodes; ordered steps remain linear subgraphs by default. The pure
interpreter consumes `(workflow IR, persisted run state, event)` and returns a
**set of decisions + state patch** because fan-out may make multiple jobs ready.
The engine claims ready jobs transactionally subject to concurrency policy.
Fan-in evaluates only after every `needs` node is terminal. Stable sorted job
IDs break ties solely for reproducible audit output, never for correctness.

Existing loops compile to explicit counted back-edges inside a job or between
named steps. Every back-edge carries a retry/round budget (tries + wall time).
This preserves review/fix loops without permitting free cycles in the job DAG.

### Expressions

Implement a small expression grammar rather than `eval` or embedding JS.
Allowed operations: literals, property lookup, equality/relational/boolean
operators, null coalescing, and whitelisted status functions (`success`,
`failure`, `cancelled`, `always`). Context is immutable persisted data.
Templates in strings remain `{{ ... }}` for migration continuity. Parse and
type-check expressions during validation; evaluate in the pure core.

### Local actions

Registry search paths are explicit daemon config, with a bundled read-only
registry plus project/local paths. `uses: git/worktree@v1` resolves to a
manifest and implementation. Resolution records content digest and semantic
version in the run for reproducibility. v1 supports in-process trusted shipped
actions and subprocess actions through a JSON protocol; capability policy is
validated at dispatch. Untrusted hard sandboxing is not promised until a
container/OS isolation design exists — capability declarations are guardrails
and audit, not a false security boundary.

Seed built-ins migrate action-by-action with their existing tests. There is no
`switch(actionName)` in the engine; registry dispatch is uniform.

### Triggers

Manual API events and cron schedules write a durable `trigger_event` first,
unique on `(source, delivery_id)`, then transactionally create a run. Scheduler
stores next fire time and an explicit missed-fire policy. Webhook names are
schema vocabulary now but inactive until ingress exists; this allows workflow
files to be portable without pretending ingress is implemented.

## Alternatives considered

1. **Reuse GitHub Actions workflow parser/runner** — rejected: GHA's execution
   model has no agent report protocol, human gates, findings or durable
   reconciler semantics, and its expression/runtime surface is much larger.
2. **Keep JSON** — rejected: poor authoring ergonomics and misses the explicit
   GHA UX benchmark.
3. **General graph DSL** — rejected: makes simple flows hard to read. Jobs +
   needs, ordered steps and bounded route loops cover the required shapes.
4. **JavaScript expressions/actions** — rejected for v1: unbounded execution,
   unclear security and non-determinism.

## Durability, concurrency and observability

Graph state (job/step status, dependencies, outputs, resolved action digest) is
persisted. A transactional claim prevents duplicate execution after concurrent
reconcile passes. Action and expression failures are classified. Timeline
events include why a job became ready/skipped/blocked, dependency snapshots
and action resolution identity. The scheduler never makes graph decisions;
it only submits durable trigger events.

## Migration

The converter maps a legacy ordered pipeline to one job, preserving step IDs,
explicit routes, roles/models, prompts, gates and params. Builtin names map to
bundled actions. It refuses unsupported/ambiguous shapes rather than guessing.
Converted files are validated and a semantic test runs representative legacy
events through both interpreters until parity is established.

## Confirmed: canonical IR shape

- **No flat pipeline.** Every workflow is `jobs: { <id>: JobDef }`; a linear
  workflow is one job with ordered steps. The interpreter is DAG-aware from
  the start (`onJobDone` unblocks dependents), so later fan-out/fan-in work
  does not re-shape state.
- **No builtin action names in the engine.** Step kinds are exactly `agent`,
  `action` (with `uses`), `command`, `human`. Engine "builtin" names from the
  seed (e.g. `git/pr-merge`) are external `uses` targets, resolved by the
  action registry later.
- **State is durable and job-scoped.** `FeatureState.jobs[].currentStep` +
  per-step `attempts`/`rounds`/`outputs` replace the seed's single
  `currentStep` + per-feature counters; the interpreter returns `decisions[]`
  + `patch` so fan-out yields multiple decisions for one event.
