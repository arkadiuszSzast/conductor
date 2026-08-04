# Workflow reference

Complete reference for `conductor.yaml`. Field semantics are defined by the
canonical IR in `packages/core/src/types.ts`; the YAML shown here is the
authoring surface the parser normalises into that IR. *(The YAML parser is in
progress — see `openspec/changes/workflow-format/tasks.md` task 1.2. Field
names and semantics below are settled; sugar/shorthand may still evolve.)*

Conventions used below:

- **Required** — must be present in YAML.
- **Default** — value the parser fills when the field is omitted. In the IR
  collections are always present (possibly empty); optionality survives only
  where absence means something an empty value cannot express.
- **(planned)** — semantics decided and representable in the IR, but the
  resolving code (expression evaluator, action registry) has not landed yet.

---

## Top level

```yaml
name: feature-delivery
on: [manual]
inputs:
  feature: { type: string, required: true }
roles:
  architect: { agent: build, model: prov/architect }
jobs:
  ...
```

### `name`

**Required.** `string`. Display name of the workflow.

### `on`

`list`. Default: `[]` — the workflow can only be started explicitly.
Triggers that start a feature:

| Trigger | Form | Notes |
|---|---|---|
| Manual | `manual` | Started via API/CLI with `inputs`. |
| Schedule | `{ schedule: { cron: "0 6 * * *", missedFire: skip \| catch-up } }` | Durable cron; `missedFire` says what happens when the daemon was down at fire time. |
| Event | `{ event: "<name>" }` | Validated vocabulary now; webhook ingress arrives in a later phase. |

### `inputs`

`map<string, InputDef>`. Default: `{}`. Typed inputs the trigger must (or
may) provide. An input is **either required or has a default — never both,
never neither**:

```yaml
inputs:
  feature:  { type: string, required: true }
  dry-run:  { type: boolean, default: false }
```

| Field | Required | Values |
|---|---|---|
| `type` | yes | `string` \| `number` \| `boolean` |
| `required` | one of the two | `true` |
| `default` | one of the two | a value of `type` |

Referenced in expressions as `{{ inputs.<name> }}`.

### `roles`

`map<string, RoleDef>`. Roles are pure metadata that `agent` steps refer to;
the engine resolves them to a concrete agent runtime:

```yaml
roles:
  reviewer: { agent: review, model: prov/reviewer, variant: careful }
```

| Field | Required | Description |
|---|---|---|
| `agent` | yes | Agent name in the runner (e.g. an opencode agent). |
| `model` | no | `provider/model` override. |
| `variant` | no | Runner-specific model variant. |

### `jobs`

**Required.** `map<string, Job>`. The DAG. Keys are job IDs, referenced by
`needs`, `rerun.jobIds` and the `needs.*` expression context.

---

## Job

```yaml
jobs:
  consensus:
    needs: [architect-a, architect-b]
    if: always()
    outputs:
      decision: "{{ steps.agree.outputs.report }}"
    steps: [ ... ]
```

### `jobs.<id>.needs`

`list<string>`. Default: `[]` — the job starts when the feature starts.
The job waits until **every** listed job is terminal (succeeded, failed or
skipped). If any dependency failed or was skipped, this job is **skipped** —
unless `if` overrides that.

`needs` is also the **data contract**: only jobs listed here are readable
through the `needs.*` expression context.

### `jobs.<id>.if`

`string` (expression). Default: absent — "run when all dependencies
succeeded". Currently recognised conditions:

| Condition | Meaning |
|---|---|
| `always()` | Run when dependencies are terminal, regardless of how they ended. |
| `failure()` | Run **only** when at least one dependency failed or was skipped; skipped when all succeeded. |

General boolean expressions over contexts are **(planned)** with the
expression evaluator.

### `jobs.<id>.outputs`

`map<string, expression>`. Default: `{}` — the job publishes nothing.
Named values this job exposes to dependent jobs, as expressions over its own
steps' outputs:

```yaml
outputs:
  design: "{{ steps.design.outputs.report }}"
  branch: "{{ steps.worktree.outputs.branch }}"
```

Step outputs are the job's private implementation detail; `outputs` is its
published contract. References to `needs.<job>.outputs.<name>` are validated
against these declarations. **(planned)** — resolution requires the
expression evaluator; the declarations are part of the stable IR today.

### `jobs.<id>.steps`

**Required.** `list<Step>`. Ordered — steps execute in declaration order (a
path, not a graph; parallelism lives at the job level). Each step needs a
unique `id` within the job.

---

## Step (common fields)

Every step, regardless of kind, supports:

```yaml
- id: implement
  if: <expression>
  outcomes: { <name>: <route>, ... }
  onFail: <route>
  retry: { maxAttempts: 3, backoff: { strategy: constant, delay: 10000 } }
```

### `steps[*].id`

**Required.** `string`, unique within the job. Referenced by `goto`,
`rerun.stepIds`, the `steps.*` expression context and the audit timeline.

### `steps[*].if`

`string` (expression). Default: absent — always run. **(planned)** at step
granularity.

### `steps[*].outcomes`

`map<string, Route>`. Default: `{}` — any outcome advances along the path.

When the step **completes its work**, it reports an outcome name (default
`done`); the map routes it. Outcome names are workflow-defined — the engine
attaches no meaning to `approved`, `rejected` or anything else. If the step
declares outcomes and reports one that is not in the map, the feature
**escalates**: your vocabulary is the contract.

```yaml
outcomes:
  approved: next
  changes_requested:
    rerun: { scope: steps, stepIds: [implement], maxRounds: 3 }
  needs_spike:
    goto: spike
```

### `steps[*].onFail`

`Route`. Default: absent — when retries are exhausted, the **job fails**
(dependents skip, `failure()` jobs run, independent branches continue; the
feature escalates only if nothing else is runnable).

Routes the step when it **could not do its work** (crash, non-zero exit,
timeout) after the retry budget is spent. This is a different lane from
`outcomes` — see [Outcomes vs failures](concepts.md#outcomes-vs-failures-the-core-distinction).

> Open design question: making `onFail` required with an explicit
> `escalate` route variant (total model instead of absent-means-escalate)
> is under consideration; see the decision log.

### `steps[*].retry`

`RetryPolicy`. Default: `{ strategy: none }` — one attempt, no retry.

```yaml
retry:
  maxAttempts: 3            # total attempts INCLUDING the first
  maxElapsed: PT10M         # optional ISO-8601 wall-clock cap
  backoff:
    strategy: constant      # constant | exponential
    delay: 10000            # ms (constant)
```

```yaml
backoff:
  strategy: exponential
  initial: 1000             # first delay, ms
  multiplier: 2             # per-attempt factor (>= 1)
  max: 60000                # delay cap, ms
  jitter: full              # none | full | equal (default: full)
```

Retry applies only to `step.failed` — an outcome never consumes retry
budget.

---

## Step kinds

Exactly one kind per step; mixing kinds is a validation error.

### `agent`

Performs LLM work.

```yaml
- id: design
  agent:
    role: architect                 # required — key into `roles`
    prompt: |                       # required — the IR is self-describing
      Zaproponuj architekturę dla {{ inputs.feature }}.
```

| Field | Required | Description |
|---|---|---|
| `role` | yes | Must exist in `roles`. |
| `prompt` | yes | Template; see [Expressions](expressions.md). |

**Outputs:** the agent's report is published as `outputs.report`.

### `command`

Runs shell commands.

```yaml
- id: worktree
  command:
    run:
      - |
        name="feature-{{ inputs.feature }}"
        git worktree add "../$name" -b "$name"
        echo "branch=$name"               >> "$CONDUCTOR_OUTPUT"
        echo "path=$(cd ../$name && pwd)" >> "$CONDUCTOR_OUTPUT"
    cwd: packages/core        # optional; default: job working directory
    timeoutMs: 600000         # optional; absent = no timeout
```

| Field | Required | Description |
|---|---|---|
| `run` | yes | List of commands. |
| `cwd` | no | Working directory; absent means the job's. |
| `timeoutMs` | no | Wall-clock timeout; absent means none (`0` would mean "expire immediately" and is invalid). |

**Outputs:** `name=value` lines written to the file at `$CONDUCTOR_OUTPUT`
(the mirror of GHA's `$GITHUB_OUTPUT`). A command may publish any number of
named outputs. Non-zero exit → `step.failed`.

### `action`

Invokes a versioned local action from the registry. **(planned)** — the
registry (`workflow-format` section 3) has not landed; the step kind and its
IR are stable.

```yaml
- id: push
  action:
    uses: git/push@v1
    with: { remote: origin }
```

| Field | Required | Description |
|---|---|---|
| `uses` | yes | `<name>@<version>` resolved against configured registries. |
| `with` | no (default `{}`) | Typed inputs per the action's manifest. |

**Outputs:** the typed outputs the manifest declares (e.g. `git/push@v1` →
`sha`, `url`). Multiple named outputs are the norm, not a workaround.

### `human`

A human gate: the feature waits (`waiting_human`) until a person decides.

```yaml
- id: pr-review
  human: {}
  outcomes:
    approved: next
    rejected:
      rerun: { scope: steps, stepIds: [implement], maxRounds: 3 }
```

A gate completes like any other step: the decision is an **outcome**
(`approved`, `rejected` — or any names your workflow declares), and the
reviewer's note is published as `outputs.notes`. There is no separate
approval vocabulary in the engine, which is exactly what lets a rejection
route back into a fix loop like any review step.

The gate carries no fields today; a `prompt`/description shown to the
approver is **(planned)** — the surface that presents gates (board/CLI) has
not landed.

---

## Routes

A route says where the workflow goes next. Exactly one shape — no bags of
optional targets:

### `next`

Continue along the job's step path (declaration order). The last step's
`next` completes the job.

```yaml
outcomes: { approved: next }
```

### `goto`

Jump to another step **in the same job**.

```yaml
outcomes: { needs_spike: { goto: spike } }
onFail: { goto: cleanup }
```

Counted loops via `goto` back-edges are validated for boundedness.

### `rerun`

Re-execute earlier work as a **bounded loop**. One scope per route:

```yaml
# Step scope: loop inside the routing job (review/fix)
rerun: { scope: steps, stepIds: [implement, quality], maxRounds: 3 }

# Job scope: reset upstream jobs + their downstream closure (consensus)
rerun: { scope: jobs, jobIds: [architect-a, architect-b], maxRounds: 5 }
```

| Field | Required | Constraints |
|---|---|---|
| `scope` | yes | `steps` \| `jobs` |
| `stepIds` | with `steps` | Non-empty; every ID exists in the routing job. |
| `jobIds` | with `jobs` | Non-empty; no duplicates; every ID is a **true ancestor** of the routing job (the routing job transitively depends on it via `needs`) — this is what makes the loop close. |
| `maxRounds` | yes | ≥ 1. On exhaustion the feature escalates. |

Semantics:

- **Step scope** — the named steps are cleared and execution restarts at
  the first of them; the job keeps running.
- **Job scope** — the target jobs and their transitive downstream closure
  (through `needs`, including the routing job) reset to pending; the
  targets' entry steps are dispatched; fan-in re-triggers the routing job.
- The round counter is per routing step, lives on the routing job, and
  **survives the closure reset** — that is what makes `maxRounds` hold
  across rounds.
- Every rerun transition carries a **feedback snapshot** of the pre-reset
  round; see [Expressions § feedback](expressions.md#feedback--the-previous-round).

### Escalation (implicit)

There is deliberately no `escalate` route to spell in YAML today. The
workflow escalates when: a step exhausts retries with no `onFail` and the
job's failure leaves nothing runnable; a `rerun` exhausts `maxRounds`; or a
step reports an outcome its map does not declare. Escalation hands the
feature to a human, who can resume (budget reset) or abandon it.

---

## Validation

Validation checks (implemented in `packages/core/src/validate.ts`):

- duplicate/empty step IDs; at least one step per job;
- missing references: `needs` → job, `goto` → step, `agent.role` → role,
  `rerun` targets → steps/jobs;
- job-DAG acyclicity (`needs` cycles are errors — loops go through `rerun`);
- `rerun` targets: step targets exist in the routing job; job targets are
  duplicate-free, not the routing job itself, and **true ancestors** of it;
  `maxRounds ≥ 1`;
- unbounded step loops: a `goto` cycle with no retry/round budget on any of
  its edges is rejected ("route the loop through rerun with maxRounds");
- retry policy invariants: `maxAttempts ≥ 1`, ISO-8601 `maxElapsed`, backoff
  parameter ranges (`delay/initial/max ≥ 0`, `multiplier ≥ 1`);
- shape errors: empty `run` list, empty `uses`.

"Required xor default" for inputs is enforced by construction — the IR
cannot represent an input that is both or neither; the parser rejects the
YAML. Planned with the evaluator: expression syntax/type checks, `needs.*`
references against declared `outputs`, `feedback.*` references against
`rerun` routes.

---

## Complete example

Two architects design in parallel; a judge loops them until consensus; then
a delivery job creates a worktree, writes a spec, implements with quality
and review loops, pushes and merges after a human gate. This exercises every
construct on this page:

```yaml
name: feature-delivery
on: [manual]

inputs:
  feature: { type: string, required: true }

roles:
  architect:   { agent: build,  model: prov/architect }
  judge:       { agent: review, model: prov/judge }
  implementer: { agent: build,  model: prov/implementer }
  quality:     { agent: review, model: prov/quality }
  reviewer:    { agent: review, model: prov/reviewer }

jobs:
  architect-a:
    outputs:
      design: "{{ steps.design.outputs.report }}"
    steps:
      - id: design
        agent:
          role: architect
          prompt: |
            Zaproponuj architekturę dla {{ inputs.feature }}.

            Twoja poprzednia propozycja (pusta w rundzie 1):
            {{ feedback.jobs["architect-a"]["design"]["report"] }}
            Propozycja drugiego architekta:
            {{ feedback.jobs["architect-b"]["design"]["report"] }}
            Uwagi sędziego: {{ feedback.jobs["consensus"]["agree"]["report"] }}
            Powód zwrotki: {{ feedback.message }}

  architect-b:
    outputs:
      design: "{{ steps.design.outputs.report }}"
    steps:
      - id: design
        agent:
          role: architect
          prompt: |
            Zaproponuj niezależną architekturę dla {{ inputs.feature }}.

            Twoja poprzednia propozycja (pusta w rundzie 1):
            {{ feedback.jobs["architect-b"]["design"]["report"] }}
            Propozycja drugiego architekta:
            {{ feedback.jobs["architect-a"]["design"]["report"] }}
            Uwagi sędziego: {{ feedback.jobs["consensus"]["agree"]["report"] }}

  consensus:
    needs: [architect-a, architect-b]
    outputs:
      decision: "{{ steps.agree.outputs.report }}"
    steps:
      - id: agree
        agent:
          role: judge
          prompt: |
            Porównaj architektury; odpowiedz outcome'em approved albo
            changes_requested. Rozumowanie ZAWSZE w raporcie.

            A: {{ needs["architect-a"].outputs.design }}
            B: {{ needs["architect-b"].outputs.design }}
        outcomes:
          approved: next
          changes_requested:
            rerun: { scope: jobs, jobIds: [architect-a, architect-b], maxRounds: 5 }

  deliver:
    needs: [consensus]
    steps:
      - id: worktree
        command:
          run:
            - |
              name="feature-{{ inputs.feature }}"
              git worktree add "../$name" -b "$name"
              echo "branch=$name"               >> "$CONDUCTOR_OUTPUT"
              echo "path=$(cd ../$name && pwd)" >> "$CONDUCTOR_OUTPUT"

      - id: openspec
        agent:
          role: implementer
          prompt: |
            Napisz zmianę OpenSpec. Pracuj w {{ steps.worktree.outputs.path }}.
            Uzgodniona architektura: {{ needs["consensus"].outputs.decision }}

      - id: implement
        agent:
          role: implementer
          prompt: |
            Zaimplementuj {{ inputs.feature }} według
            {{ steps.openspec.outputs.report }}.

            Poprzednia iteracja: {{ feedback.jobs["deliver"]["implement"]["report"] }}
            Uwagi quality: {{ feedback.jobs["deliver"]["quality"]["report"] }}
            Uwagi review: {{ feedback.jobs["deliver"]["internal-review"]["report"] }}
            Uwagi z PR: {{ feedback.jobs["deliver"]["pr-review"]["notes"] }}

      - id: quality
        agent:
          role: quality
          prompt: "Build, testy, lint. Odpowiedz approved albo issues; problemy w raporcie."
        outcomes:
          approved: next
          issues:
            rerun: { scope: steps, stepIds: [implement], maxRounds: 3 }

      - id: internal-review
        agent:
          role: reviewer
          prompt: "Zreviewuj diff. approved albo changes_requested; uwagi w raporcie."
        outcomes:
          approved: next
          changes_requested:
            rerun: { scope: steps, stepIds: [implement, quality], maxRounds: 3 }

      - id: push
        action: { uses: git/push@v1 }        # outputs: sha, url

      - id: pr-review
        human: {}          # approver sees the feature/step context; a gate
                           # prompt field is (planned)
        outcomes:
          approved: next
          rejected:
            rerun: { scope: steps, stepIds: [implement, quality, internal-review], maxRounds: 3 }

      - id: merge
        action:
          uses: git/pr-merge@v1
          with: { method: squash }
        retry:
          maxAttempts: 3
          backoff: { strategy: constant, delay: 30000 }
```
