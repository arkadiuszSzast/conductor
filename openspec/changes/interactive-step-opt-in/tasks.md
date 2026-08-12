# Tasks — interactive step opt-in

## 1. Core: IR + parser

- [ ] 1.1 [core] `AgentStep.interactive?: boolean`; parser accepts the
      field on agent bodies only (boolean, type-checked), absent → false
- [ ] 1.2 [test] Parse tests: accepted on agent, rejected on
      command/action/human bodies, non-boolean → parse error

## 2. Server: enforcement + projection

- [ ] 2.1 [server] `Engine.report` ask branch: resolve the step via the
      feature's workflow snapshot; refuse (no state change, run stays
      running) unless it is an agent step with `interactive: true`;
      missing step → same refusal
- [ ] 2.2 [server] Workflow projection: `interactive: true` on
      interactive agent step entries
- [ ] 2.3 [test] Engine tests: interactive step asks fine; autonomous
      step's ask refused with instructive text and zero state change;
      step-vanished refusal; projection carries the flag

## 3. Runner + docs

- [ ] 3.1 [runner] `conductor_ask` description: works only on steps the
      workflow marks `interactive: true`; on refusal, decide and report
- [ ] 3.2 [docs] workflow-reference: `interactive` row in the agent step
      table + asking-mid-step section updated; concepts: opt-in noted
