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

#### Parser task (task 1.2, landed) — `packages/core/src/parse.ts`

Parser decisions, recorded because they settle the authoring surface and the
parser/validator boundary:

- **Library: `yaml` (eemeli/yaml v2).** The core's first runtime dependency.
  Chosen over `js-yaml`: a typed CST-aware API with per-node ranges, a
  `LineCounter` for line/column positions, built-in `uniqueKeys` detection,
  and `visit` over the parsed tree for the tag/anchor/alias and depth passes.
  `js-yaml` loses source positions on nodes. There is no pure-JS alternative
  with this fidelity; the parser stays pure regardless (string → `ParseResult`,
  no I/O). `yaml` resolves `on` as the string `"on"` (not `true`) with
  `stringKeys`, which is what GHA authors write.
- **Parser owns shape and syntax; `validateWorkflow` owns graph and
  references.** The parser fills empty collections, builds the discriminated
  unions, and rejects any YAML that cannot become a well-formed `WorkflowDef`.
  Everything in `docs/workflow-reference.md` under "Validation" (DAG cycles,
  missing goto/needs/role/rerun targets, unbounded loops, expression and
  reference checks) stays in `validate.ts` — the parser never re-implements
  it. The IR documents this split.
- **Aliases are banned, not bounded.** `yaml`'s `maxAliasCount` caps expansion
  at 100 aliases, but an anchored alias still surfaces in the IR with no
  source position of the *original* definition, and alias-based constructs
  would blur a source-mapped error's location. Rejecting `*alias`/`&anchor`
  outright is stricter than the task requires ("or sharp expansion limit")
  and reads better for a config format whose target users write the YAML by
  hand. Default `parseDocument` options are `uniqueKeys: true` (duplicate
  keys are errors) and `strict: true`. Custom tags are rejected with the
  library's `TAG_RESOLVE_FAILED` warning surfaced as a source-mapped error;
  multiple documents in one file are a `MULTIPLE_DOCS` error.
- **Hard limits: 1 MiB source, 64 nesting levels.** Depth is measured on the
  parsed node path (the document's own structure), so a maliciously deep
  `with:` value or list is caught with a position. Document size is bounded
  because YAML 1.2's merge/alias machinery and our recursive normalisers are
  the only paths that could grow — aliases are already gone, so the size cap
  is belt-and-braces.
- **Unknown-field errors name the block and suggest the closest valid field
  via Levenshtein** (edits ≤ max(2, len/3)). Error messages are actionable:
  `step "confused": a step is exactly one kind — found conflicting keys:
  agent, command`; `input "budget": required and default are mutually
  exclusive`; `unknown field "promt" — did you mean "prompt"?`.
- **"Required xor default" for inputs is enforced in the parser**, matching
  `InputDef`'s structure: a node with both, or neither, is a positioned
  parse error (the docs' "enforced by construction" note). `required: false`
  is likewise rejected — an optional input declares a default.
- **`on` triggers keep the GHA sugar.** `on: [manual]`, `manual` in a list,
  and the mapping forms `{ schedule: { cron, missedFire } }` /
  `{ event: <name> }` are the only trigger shapes. `on` defaults to `[]` when
  omitted. `schedule` requires both `cron` and `missedFire`; event names are
  any string (vocabulary validation, no ingress yet).
- **Step-kind resolution:** a step is exactly one of `agent`/`command`/
  `action`/`human`, so the kind's block carries no `type:` field (the IR's
  `type` is a parser artifact). `human` is fieldless — `human:` and
  `human: {}` both work, anything else is a positioned error. `action.uses`
  is parsed as an opaque string (registry resolution is section 3).
- **Routes and retry are strict about their discriminated-union shape.** A
  route mapping has exactly one of `goto`/`rerun`; `rerun` carries the scope's
  matching id list (`stepIds` xor `jobIds`); a constant backoff rejects
  exponential fields and vice versa. `retry` without `backoff` is a parse
  error (the IR has no `{strategy:"backoff"}` without one). The parser checks
  types and integer-ness (`maxAttempts`, `maxRounds`, `delay`, `initial`,
  `max`, `timeoutMs`) and `timeoutMs ≥ 1`; the *value ranges* the shape
  requires (`maxAttempts ≥ 1`, `maxRounds ≥ 1`, backoff parameter ranges)
  are part of the semantic invariants, so they live with the other
  structural checks in `validate.ts` (`validateRetry`/`validateBackoff`/
  `validateRerunTarget`). `maxElapsed` ISO-8601 format is likewise checked in
  `validate.ts`.
- **`with:` values are preserved generically** (strings/numbers/booleans/
  lists/maps, `null` for empty values) because action inputs are an opaque
  payload until the registry lands; everything else in the dialect is typed.
  Expression validation still reaches into string `with:` values.

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

#### Expression language details (task 2.3, landed)

Recorded here because they decide the grammar, not just its implementation.

- **Status functions are data, not code.** `always()`, `failure()`, … are
  zero-argument and the evaluator never computes them; the caller passes
  precomputed booleans into the context (`functions: { always: true }`).
  The only callable names are the whitelist — anything else (including
  `eval()`) is a parse error, so there is no ambient capability by
  construction.
- **No arithmetic.** The grammar has `!` and unary `-` (negative literals),
  equality/relational/boolean operators and `??`; no `+ - * /`, no string
  concatenation. Job `outputs` compose values via templates instead.
- **Bracket indices are string literals only.** `needs["arch-a"]`, never a
  variable or number — dynamic keys would make references un-validatable.
- **Contexts and hard/soft semantics** as in `docs/expressions.md`:
  `inputs.*`/`steps.*`/`needs.*` are hard (a miss raises and must be
  reported before side effects; `??` can supply a default), `feedback.*` is
  soft (resolves to null/empty outside a rerun by design). The evaluator is
  pure — the caller (engine) builds the `EvalContext` from persisted state
  via `buildEvalContext`, so the interpreter stays free of I/O.
- **Step output names are static only where the step kind fixes them**:
  `agent` publishes exactly `report`, `human` exactly `notes`;
  `command`/`action` outputs are dynamic (runner- or manifest-defined), so
  any output name passes validation and is treated as an unknown type.
- **`needs.X.outputs.Y` requires X in `needs` and Y in X's declared
  `outputs`.** Reference validation is DAG-shaped, not just name-shaped.
- **`feedback.jobs[J][S]` legality is rerun-shaped**: legal in job X iff a
  rerun route targets X; J must be a rerun target or the routing job (S the
  routing step). Step-scope reruns make any step of the routing job legal.
- **Job `outputs` are templates, not bare expressions.** A value is a
  `{{ ... }}` string (the docs' `{{ steps.x.outputs.report }}` form) that
  renders to a string when the job succeeds. A declared output that fails to
  evaluate resolves to `null`, never fails the job — consumers read an
  explicit empty value. This resolves the `NOT YET EVALUATED` gap in
  `JobDef.outputs`/`JobRuntime.outputs` (task 2.2-output-availability).
  Job outputs may read only `inputs.*` and the job's own `steps.*` — not
  `feedback.*` (the post-success resolution has no rerun snapshot) and not
  `needs.*` (re-publishing a dependency's output is a smell; reference the
  producer directly).
- **General `if:` conditions are validated but inert, and say so.** The
  interpreter's readiness cascade still consults only the literal
  `always()`/`failure()`; any other syntactically valid job condition
  produces a validation *warning* ("validated but not evaluated") instead of
  being silently ignored. Evaluating general conditions at readiness time is
  a later engine change.
- **Bare dotted paths are gone.** The old template allowed `{{feature}}`;
  the expression grammar requires a context root, so `{{feature}}` is now a
  validation error naming the available contexts.

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

#### Action registry core (task 3.1, landed) — `packages/core/src/action.ts`

Manifest, validation, resolution and `with:` checking all live in core —
like the workflow parser/validator — because they are pure: string →
manifest → validate → resolve with no I/O and no daemon config. The daemon
only supplies the registry contents and (task 3.2+) executes.

- **Manifest shape.** Authoring surface is a small YAML file:
  `name`, `version` (`major.minor.patch`), optional `description`, `inputs`,
  `outputs`, `capabilities`, `run`. `run` is a list for a subprocess (JSON
  protocol over stdio) or `{ handler: <name> }` for an in-process shipped
  action; the parser normalises both to the discriminated IR
  (`kind: "process" | "inprocess"`). Typed IO mirrors the workflow `InputDef`
  pattern — an input is required or has a default, never both, never neither —
  so the IR is a safe variant, not a bag of optional fields. Input/output
  type vocabulary: `string | number | boolean | string[] | number[] |
  boolean[]`. Array types must be quoted in flow maps (`type: "string[]"`) —
  brackets are YAML flow indicators. `version` values that look numeric
  (`1.2`) must be quoted too or the parser reports a scalar-type error.
- **Capabilities vocabulary** is `filesystem | process | network | git |
  credentials`. The parser rejects undeclared capabilities at shape level
  (source-mapped); `validateActionManifest` re-checks defensively for
  hand-loaded manifests. Declarations are guardrails and audit, not a
  security boundary (see above).
- **Registry model.** `ActionRegistry` is an immutable `name → [{ manifest,
  sourcePath? }]` map; `buildActionRegistry` keys entries by their manifest
  name so key ↔ `uses` lookup stay consistent. `sourcePath` is load-time
  provenance the daemon sets (bundled + configured paths); the resolver never
  reads it, diagnostics quote it. The resolver is config-agnostic: it sees
  only the map.
- **Resolution.** `resolveAction(uses, registry)` parses `name@v<ref>` (`@v1`,
  `@v1.2`, `@v1.2.3`), looks up the name, and picks the highest manifest on
  the matched version line — a major ref tracks the newest minor/patch. It
  returns the matched manifest plus a content digest; `validateWorkflow`
  stays registry-free.
- **Digest lifecycle.** The digest is SHA-256 over the manifest's canonical
  content (stable JSON, keys sorted, insertion-order independent), computed
  at resolution. It pins the exact resolved manifest — identity, version, IO
  contract, capabilities, entry point — so a run reproduces the same
  definition. The daemon records it in run state (task 3.2); hashing the
  implementation *bytes* is a server-side load concern (3.2+) and not part of
  the core digest.
- **Missing-action diagnostics.** Failure messages are built purely in core
  and name the searched registry paths: for a missing name the message lists
  the source paths of every registry entry (or "none — the registry is
  empty") plus what the registry provides; for a missing version it lists the
  matched name's paths and the available versions. This is a daemon pre-start
  check, not part of `validateWorkflow`.
- **`with:` validation happens at reservation.** `validateActionInputs`
  rejects undeclared keys, missing required inputs and literal values of the
  wrong type. A `{{ ... }}` template value defers the type check to
  dispatch-time enforcement (3.2) — its rendered type is unknown pre-run.
- **JSON protocol — envelope types only.** `ActionRunContext` (feature/job/
  step identity, workdir, typed inputs after defaults, declared capabilities)
  and `ActionResult` (`succeeded` + outputs | `failed` + error) are pure
  types. Pending/polling and the wire format are deliberately deferred to the
  polling work (3.2+); `status` stays `succeeded | failed` until then.

#### Action registry server wiring (task 3.1, landed) — `packages/server/src/`

The server owns registry configuration and filesystem I/O. The daemon-facing
config names a base directory, one bundled read-only registry path, and ordered
local paths. Relative paths resolve from the configured base directory; no home
or host path is implied. Search order is bundled first, then local paths in
declaration order. A later path has higher precedence for the same exact
`name@version`; duplicates within one path are deterministic load errors naming
all conflicting manifests.

- **Loader convention.** Registry roots are scanned recursively in lexical
  order for `action.yaml` and `action.yml`. Missing/unreadable paths and files,
  malformed YAML, semantic manifest errors, and same-precedence duplicates are
  aggregated and sorted by source location. A failed load yields no partial
  registry. Symlinks inside a registry root are rejected with a diagnostic so
  traversal stays finite and entries are never silently skipped. Every accepted
  entry carries its absolute manifest `sourcePath`.
- **Pre-start reservation check.** `checkWorkflowReservation` walks every
  action step in workflow/job declaration order, calls core `resolveAction`,
  then `validateActionInputs`, and returns all useful diagnostics before a run
  can start. It remains separate from `validateWorkflow`. Resolution
  diagnostics also name every configured search root because core registry
  entries only retain paths of manifests that were actually found.
- **Reconciler hand-off.** A successful reservation exposes immutable bindings
  keyed by `(jobId, stepId)`, containing the resolved manifest, digest, and
  source provenance. The reconciler receives a read-only lookup seam; action
  execution, capability enforcement, and durable version/digest persistence
  remain task 3.2 work.

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

**Superseded.** The legacy JSON → v1 YAML converter described below was never
built and is now void: `standalone-daemon-extraction` deleted the seed
pipeline format outright (greenfield, no users, no in-flight data to
migrate). Section 5's two conversion tasks in `tasks.md` are marked void for
the same reason. The seed's builtin mechanics live on only as bundled `@v1`
actions (task 3.4) — behavioural parity, not format compatibility.

~~The converter maps a legacy ordered pipeline to one job, preserving step
IDs, explicit routes, roles/models, prompts, gates and params. Builtin names
map to bundled actions. It refuses unsupported/ambiguous shapes rather than
guessing. Converted files are validated and a semantic test runs
representative legacy events through both interpreters until parity is
established.~~

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
  per-step `attempts`/`reruns`/`outputs` replace the seed's single
  `currentStep` + per-feature counters; the interpreter returns `decisions[]`
  + `patch` so fan-out yields multiple decisions for one event.
- **No daemon/opencode coupling in the IR.** Removed from the seed: `PublishDef`
  + `tokenCommand` (publishing is a server concern, not a workflow shape) and
  `RoleDef.session`. `RoleDef` is pure metadata (`agent`, optional `model`,
  `variant`) resolved by the engine.
- **Failure = two separate knobs.** `retry.maxAttempts` is the retry budget
  for the same step (default 1 = no retry; `maxAttempts` counts total
  executions including the first). `onFail` routes only once retries are
  exhausted; with no route, the **job fails** and the DAG reacts (dependents
  skip, `failure()` jobs run, the feature escalates only when nothing else is
  runnable — per `cross-job-loops`). Notification-on-failure is a plain step
  reached via `onFail`, not a shell escape hatch — the interpreter stays pure
  (routing) and the engine owns side effects.
- **Resolved: `onFail` stays `Route?`; no `escalate` route variant.** The
  open question "make `onFail` required with an explicit `escalate` variant
  (total model)" is closed as **no**, for the parser freeze:
  - An `escalate`-immediately variant would bypass the DAG's failure
    reaction — `if: failure()` cleanup/notification jobs would never run,
    which contradicts the settled failure model above. Softening it to
    "escalate after `failure()` jobs finish" is just "job failed and nothing
    else runnable" minus waiting for independent branches — a third,
    subtly different mode with no carrying use case.
  - Failure notifications (e.g. Telegram) have two homes, both orthogonal
    to `onFail`'s shape: a `if: failure()` job inside the workflow (runs in
    the window between job failure and feature escalation), and a daemon
    event subscriber on the `escalated` timeline event
    (`standalone-daemon-extraction`, API/SSE) for install-wide policies.
    Neither is helped nor harmed by a total `onFail` — only by
    escalate-immediate, which is exactly the variant rejected.
  - Totality as an IR-explicitness measure (`onFail: Route | {kind:"fail"}`
    with the parser filling `fail` as the default) remains available later
    as a mechanical, semantics-free change; it is not worth blocking the
    parser on. In YAML, absent `onFail` keeps meaning "job fails, DAG
    reacts".
- **Sealed over nullable.** `BackoffDef` is a discriminated union keyed on
  `strategy` with optional fields carrying defaults; `AgentStep.prompt` is
  required (the IR is self-describing). No `X | null` for absent config.
  (Superseded detail: `maxRounds: number | "unlimited"` became a plain
  required `number ≥ 1` in `cross-job-loops` — every loop is bounded by
  construction.)
- **Retry is a sealed policy, not a bag of nullable fields.**
  `retry?: RetryPolicy` where `RetryPolicy = { strategy: "none" } |
  { strategy: "backoff"; maxAttempts: number; maxElapsed?: string;
  backoff: BackoffDef }` — a "backoff" policy always carries a required
  `backoff`. `BackoffDef` is itself sealed: `{ strategy: "constant"; delay } |
  { strategy: "exponential"; initial; multiplier; max; jitter? }`. The engine
  fills jitter defaults; there is no all-null policy value.
- **Within a job, steps are a path, not a graph.** The path is declaration
  order; loops are explicit route edges (`outcomes`, `onFail`, `rerun` after
  `cross-job-loops` — `then`/`roundsWith` were removed). Parallelism lives at
  the **job** level (`needs`), so step-level fan-out is not in the model —
  adding it would force `currentStep` into a multi-active set. Open question
  for a later change.
- **Resolved gap: cross-job feedback loops.** "Parallel agents → consensus →
  re-run both with the other's output" was not expressible in the original IR.
  The `cross-job-loops` change closed it: completion is
  `step.completed { outcome?, outputs? }` routed via per-step `outcomes`
  maps, loops are `rerun` routes (step scope for review/fix, job scope with
  transitive closure reset for consensus), step outputs are GHA-style named
  maps, and rerun transitions carry a `feedback` snapshot of the pre-reset
  round for re-run prompts. `roundsWith`, `then`, `onVerdict`, `onReject` and
  the separate human events were removed. See
  `openspec/changes/cross-job-loops/design.md` — its decisions supersede the
  step-routing shapes sketched in this document.
