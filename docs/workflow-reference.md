# Workflow reference

Complete reference for `conductor.yaml`. Field semantics are defined by the
canonical IR in `packages/core/src/types.ts`; the YAML shown here is the
authoring surface the parser (`packages/core/src/parse.ts`) normalises into
that IR. Field names and semantics below are settled; sugar/shorthand may
still evolve.

Conventions used below:

- **Required** — must be present in YAML.
- **Default** — value the parser fills when the field is omitted. In the IR
  collections are always present (possibly empty); optionality survives only
  where absence means something an empty value cannot express.
- **(planned)** — semantics decided and representable in the IR, but the
  resolving code (action registry) has not landed yet.

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

> For manually-started features, the operator's task text travels on the
> feature itself — read it as `{{ feature.description }}` (with
> `{{ feature.title }}` / `{{ feature.slug }}` alongside; see
> [Expressions](expressions.md#feature--the-features-own-fields)) instead
> of declaring an input nothing populates.

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

General boolean expressions over these contexts are validated now and
evaluated engine-side with the same grammar (see
[expressions.md](expressions.md)); the interpreter still special-cases
`always()`/`failure()` for skip decisions.

### `jobs.<id>.outputs`

`map<string, expression>`. Default: `{}` — the job publishes nothing.
Named values this job exposes to dependent jobs, as template expressions over
its own steps' outputs:

```yaml
outputs:
  design: "{{ steps.design.outputs.report }}"
  branch: "{{ steps.worktree.outputs.branch }}"
```

Step outputs are the job's private implementation detail; `outputs` is its
published contract. Each value is a `{{ ... }}` template and renders to a
string when the job succeeds. References to `needs.<job>.outputs.<name>` are
validated against these declarations. A declared output that fails to
evaluate (for example a missing earlier step output) resolves to `null`
rather than failing the job, so consumers see an explicit empty value.

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

There is deliberately no `escalate` route variant: an escalate-immediately
edge would bypass the DAG's failure reaction (`if: failure()`
cleanup/notification jobs would never run). Absent `onFail` is the settled
shape — the job fails, the DAG reacts, and escalation arrives only when
nothing else is runnable. Failure notifications belong in an
`if: failure()` job (in-workflow) or a daemon event subscriber on the
escalation event (install-wide); see the decision log in
`openspec/changes/workflow-format/design.md`.

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
| `interactive` | no | Boolean, default `false`. Grants the step the right to pause mid-run and ask the human a question. |

**Outputs:** the agent's report is published as `outputs.report`.

**Asking mid-step.** An `interactive: true` agent step may ask the human a
question without ending its run (the runner reports an `ask` instead of an
outcome — with the opencode runner, via the `conductor_ask` tool). The
feature waits (`waiting_human`), the answer is delivered into the same
live session, and the step continues. Questions render as answer forms in
the web UI when they embed a `conductor-questions` block (see
[`human`](#human) below). Prefer an ask over an explore→gate→re-run loop
whenever the questioner needs to keep its conversation context.

Steps without the flag are autonomous by contract: the daemon refuses
their asks and instructs the agent to decide on its own and report an
outcome (or report `failed` with notes when human input is genuinely
indispensable — normal failure routing then applies). Mark only the steps
where a human conversation is part of the job (exploration, requirements
clarification), and keep delivery steps autonomous so a pipeline never
stalls mid-implementation waiting for a question nobody expected.

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
- id: answer-questions
  human:
    prompt: |
      The explorer has open questions:
      {{ steps.explore.outputs.report }}
      Answer them in the decision notes.
  outcomes:
    approved: next
    rejected:
      rerun: { scope: steps, stepIds: [implement], maxRounds: 3 }
```

| Field | Required | Description |
|---|---|---|
| `prompt` | no | Template shown to the approver; same contexts and validation rules as agent prompts. |

A gate completes like any other step: the decision is an **outcome**
(`approved`, `rejected` — or any names your workflow declares), and the
reviewer's note is published as `outputs.notes`. There is no separate
approval vocabulary in the engine, which is exactly what lets a rejection
route back into a fix loop like any review step.

**Prompt semantics.** The engine renders `prompt` once, when the gate arms
(the step enters `waiting_human`), against the same context an agent step
dispatched at that point would see — including the `feedback.*` snapshot
when the gate re-arms inside a rerun round (each round re-renders). The
rendered text is persisted under the step's reserved `prompt` output and
shown wherever the gate is decided: the web UI gate panel, `conductor
status <feature-id>`, and the feature detail API (on the waiting step's
entry). A render error never blocks the gate — the failed expressions
render empty, the errors are logged, and the gate arms with the partial
text.

**Structured questions.** When the rendered prompt contains a fenced code
block tagged `conductor-questions` — a JSON array of
`{ "question": string, "options"?: string[] }` — the web UI renders an
answer form instead of plain text: each question shows its suggested
options plus a free-text "your own answer" field, and the submitted
decision serialises the answers into the notes as `Q: …\nA: …` pairs.
Anything malformed degrades to the plain-text prompt. The block typically
comes from an earlier agent step: instruct the agent to end its report
with it, then quote the report in the gate prompt:

````yaml
- id: explore
  agent:
    role: explorer
    prompt: |
      Investigate the task. If decisions remain, end your report with a
      fenced block tagged `conductor-questions` containing a JSON array
      of { "question": string, "options": string[] } — suggest the most
      likely options for each question.
- id: answer-questions
  human:
    prompt: "{{ steps.explore.outputs.report }}"
````

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
- shape errors: empty `run` list, empty `uses`;
- expression syntax and type errors in `if`, agent `prompt` and job `outputs`
  (unknown contexts, unknown functions, number/boolean misuse);
- `steps.*` references resolve to **earlier** steps of the same job and to a
  known output name — `report` on agent steps, `notes` on human steps;
  command/action step outputs are dynamic and any name passes;
- `needs.<job>.outputs.<name>` requires `<job>` in `needs` **and** `<name>` in
  that job's declared `outputs`;
- `feedback.jobs[J][S]` in job X requires a `rerun` route targeting X, with J
  one of that rerun's targets or its routing job (S the routing step).

"Required xor default" for inputs is enforced by construction — the IR
cannot represent an input that is both or neither; the parser rejects the
YAML. General boolean `if:` conditions are validated but evaluated engine-side
(see [expressions.md](expressions.md)).

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
