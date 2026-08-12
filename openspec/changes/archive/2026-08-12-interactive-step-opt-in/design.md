# Design — interactive step opt-in

## Context

`interactive-agent-steps` (archived 2026-08-12) let any agent run report
`ask`. The tool description is the only guard. Load-bearing facts:

- `Engine.report`'s ask branch has the run row (`jobId`, `stepId`) and
  the feature; `findStep(snapshot.workflow, jobId, stepId)` is the
  established way to resolve the step def (dispatch and reconcile both
  use it).
- `AgentStep` IR is `{type, role, prompt}` + StepBase; the parser
  whitelists fields per step body (`readFields`), so a new field is a
  one-line whitelist change plus a read.
- The workflow projection (`GET /v1/projects/workflow`) already carries
  per-step `{id, kind}` for the web graph.

## Goals / Non-Goals

**Goals**
- Autonomous by default: a step may ask only if the workflow says so.
- The refusal teaches the agent, not just blocks it.

**Non-Goals**
- No per-role or global toggles (one knob, on the step, where the
  decision belongs).
- No new API surface; no migration.

## Decisions

### D1 — `interactive` is an agent-step field, default false

`agent: { role, prompt, interactive?: boolean }`. Parser accepts only a
boolean (type error otherwise); omitted → absent → false. Only `agent`
bodies get the field — commands/actions have no session to converse
through, humans ARE the conversation.

### D2 — Enforcement lives in the engine's ask branch, not the runner

The daemon is the authority (a runner could be lied to or outdated). In
`Engine.report`, before `setRunQuestion`: load the feature's workflow
snapshot, `findStep(run.jobId, run.stepId)`; unless the step is an agent
step with `interactive === true`, return the refusal text without any
state change. Step missing from the workflow (changed since dispatch) —
refuse the same way: asking is a privilege the current workflow must
grant. The runner plugin's tool description additionally tells agents
the tool only works on interactive steps (defense in depth, better
prompting).

### D3 — Refusal is a normal report response, run keeps running

The refusal must NOT fail the run: the agent simply continues and
reports an outcome. Text: step "X" is not interactive — decide
autonomously using your best judgment and report an outcome; if human
input is truly required, report failed with notes explaining what is
missing. That last clause gives a legitimate escape hatch through the
existing failure/escalation routing.

### D4 — Projection carries `interactive` on agent steps

`GET /v1/projects/workflow` step entries gain `interactive: true` on
interactive agent steps (omitted otherwise), so the web graph can badge
them. Purely additive.

## Risks / Trade-offs

- **Workflow snapshot load per ask**: negligible — asks are rare and the
  registry caches snapshots (same path dispatch uses).
- **Existing conductor-test-todo workflow** must add `interactive: true`
  to its explore step to keep asking — greenfield, acceptable by
  definition.

## Open Questions

None.
