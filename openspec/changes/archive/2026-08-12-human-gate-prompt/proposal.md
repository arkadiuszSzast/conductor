# Human gate prompts — question/answer flows through gates

## Why

A `human` gate today is a bare decision point: the approver sees which step
is waiting but not *what is being asked*. This blocks the gate-with-questions
pattern — an agent step lists open questions in its report, a human answers
them at a gate, and the next agent step reads the answers from
`steps.<gate>.outputs.notes`. The mechanics already exist (notes flow into
step outputs and feedback); what is missing is the question reaching the
human. The workflow reference has carried this as "(planned)" since the
format landed.

## What Changes

- `human` steps accept an optional `prompt` field — a template with the same
  expression contexts as agent prompts (`inputs.*`, `steps.*`, `needs.*`),
  so a gate can quote an earlier agent's report (e.g. its questions) to the
  approver.
- The engine renders the prompt when the gate arms (step becomes
  `waiting_human`) and persists the rendered text on the feature.
- The API exposes the rendered gate prompt in the feature detail projection;
  the web UI shows it above the approve/reject controls; `conductor status
  <feature-id>` prints it.
- **Structured questions**: a rendered prompt may embed a fenced
  `conductor-questions` JSON block (typically produced by an earlier agent
  step and quoted into the prompt). Surfaces that recognise the block render
  an answer form — suggested options per question plus a free-text "own
  answer" field — and serialise the answers into the decision notes as
  readable question/answer pairs. Surfaces that do not recognise it fall
  back to plain text; notes remain free text end to end.
- Validation covers the new field: expression syntax, context references
  (same rules as agent prompts — earlier steps of the same job, declared
  outputs of `needs` dependencies).

## Capabilities

### New Capabilities

- `gate-prompts`: the definition, rendering, persistence and presentation of
  human-gate prompts — from YAML field to approver-facing surfaces (API, web
  UI, CLI).

### Modified Capabilities

<!-- workflow-definition and api specs live in active changes
     (workflow-format, api-ui-projections), not yet in main specs; the
     gate-prompts spec is self-contained and references them. -->

## Impact

- `packages/core`: `HumanStep` IR gains `prompt?`; parser, validation
  (expression checks), no interpreter changes (routing is untouched).
- `packages/server`: engine renders the prompt at gate-arm time and stores
  it; API feature-detail projection carries it.
- `apps/web`: gate actions panel renders the prompt text; when the prompt
  carries a `conductor-questions` block, it renders the option-picker form
  and composes the notes.
- `packages/cli`: `status <feature-id>` prints the pending gate prompt
  (questions included, as text).
- `docs/workflow-reference.md`: replace the "(planned)" note with the field
  reference.
- No breaking changes: the field is optional; existing workflows are
  unaffected.
