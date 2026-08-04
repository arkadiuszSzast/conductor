# Expressions and template contexts

Workflow strings may embed `{{ ... }}` expressions. This page defines every
context, what resolves when, and what validation guarantees. *(The expression
evaluator is in progress — `workflow-format` task 2.3. Contexts and
semantics below are settled; the resolving code has not landed.)*

## Design constraints

Expressions are deterministic and bounded: property lookup, literals,
equality/relational/boolean operators, null coalescing, and whitelisted
status functions (`always()`, `failure()`, …). No ambient filesystem,
network, clock, randomness or code evaluation. Expressions are parsed and
type-checked at validation time and evaluated in the pure core against
persisted state.

## Contexts at a glance

| Context | Scope | Reads | Guarantee |
|---|---|---|---|
| `inputs.*` | everywhere | trigger inputs | **Hard** — typed and validated at trigger time |
| `steps.*` | within a job | earlier steps of the same job, live | **Hard** — declaration order guarantees existence |
| `needs.*` | within a job | declared outputs of dependency jobs, live | **Hard** — the DAG guarantees the dependency finished |
| `feedback.*` | re-run steps | the previous round, snapshot | **Soft** — empty outside a rerun *by design* |

"Hard" means a reference that fails to resolve is an error caught before
side effects ("missing required value fails before the job's first step
executes"). "Soft" means an empty result is a legal, meaningful state.

---

## `inputs` — trigger inputs

```yaml
prompt: "Zaimplementuj {{ inputs.feature }}"
```

Available everywhere. Typed per the workflow's `inputs` declaration;
required inputs are guaranteed present, optional ones carry their default.

## `steps` — earlier steps in the same job

```yaml
- id: openspec
  agent:
    prompt: "Pracuj w {{ steps.worktree.outputs.path }}"
```

`steps.<stepId>.outputs.<name>` reads a named output of an **earlier step in
the same job**. Existence is guaranteed by declaration order; referencing a
later step is a validation error.

Output names by step kind:

| Kind | Names |
|---|---|
| `command` | whatever it wrote to `$CONDUCTOR_OUTPUT` (`name=value` lines) |
| `action` | per the action's manifest (e.g. `git/push@v1` → `sha`, `url`) |
| `agent` | `report` |
| `human` | `notes` |

## `needs` — declared outputs of dependencies

```yaml
consensus:
  needs: [architect-a, architect-b]
  steps:
    - id: agree
      agent:
        prompt: |
          A: {{ needs["architect-a"].outputs.design }}
          B: {{ needs["architect-b"].outputs.design }}
```

`needs.<jobId>.outputs.<name>` reads an output the dependency **declared**
in its `outputs:` map. Two static checks apply:

1. `<jobId>` must be listed in this job's `needs` — the DAG edge is the read
   permission;
2. `<name>` must be declared in that job's `outputs` — step outputs are
   private; the declaration is the contract.

A typo in either is a validation error, not an empty string at runtime.
Values are **live**: always the current round (relevant when a `rerun`
resets and re-runs the producers — the consumer re-runs after them and sees
the new values).

## `feedback` — the previous round

Available in steps re-executed by a `rerun` route. The rerun transition
snapshots, **before** resetting anything:

- the named outputs of every step of the rerun's targets
  (`scope: jobs` → the target jobs; `scope: steps` → the routing job), and
- the routing step's own outputs, and
- the route reason.

```
feedback.jobs.<jobId>.<stepId>.<name>    named output from the previous round
feedback.message                         why the loop fired
```

Example — round 2 of a consensus loop, inside `architect-a`'s prompt:

```yaml
prompt: |
  Twoja poprzednia propozycja:
  {{ feedback.jobs["architect-a"]["design"]["report"] }}
  Propozycja drugiego architekta:
  {{ feedback.jobs["architect-b"]["design"]["report"] }}
  Uwagi sędziego:
  {{ feedback.jobs["consensus"]["agree"]["report"] }}
  Powód zwrotki: {{ feedback.message }}
```

### Why `feedback` is soft

A loop has two phases by construction: round 1 has no previous round.
Outside a rerun the whole namespace is empty and references render as empty
strings — this is intended, not an error. Write prompts accordingly
("previous proposal — empty in round 1"). The alternative (separate
round-1/round-2 prompts) doubles every definition for no gain; agents handle
"section empty = first iteration" naturally.

### Why `feedback` is not `needs`

The DAG must stay acyclic: `architect-a` cannot list `consensus` in `needs`
(consensus needs architect-a — that would be a cycle). The loop edge is the
**`rerun` route itself**, declared on the routing step. That declaration is
also what makes `feedback` references checkable:

> `feedback.jobs[J][S]` in job X is legal iff some `rerun` route targets X,
> and J is one of that rerun's targets or its routing job (with S the
> routing step).

So in the consensus example, inside the architects the legal references are
exactly: both architects' steps, and `consensus`/`agree`. Anything else —
a typo, a job outside the loop — is a validation error. *(planned — this
check lands with the evaluator)*

## Runner-populated environment

Not expressions, but part of the same data flow:

| Variable | In | Purpose |
|---|---|---|
| `$CONDUCTOR_OUTPUT` | `command` steps | File to append `name=value` output lines to (mirror of `$GITHUB_OUTPUT`). |
