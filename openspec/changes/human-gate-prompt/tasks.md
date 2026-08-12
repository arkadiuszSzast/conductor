# Tasks — human gate prompts

## 1. Core: IR, parser, validation

- [x] 1.1 [core] Add optional `prompt?: string` to `HumanStep` in
      `packages/core/src/types.ts`; document the reserved `prompt` output key
      on `StepRuntime.outputs`
- [x] 1.2 [core] Parse `human: { prompt: ... }` in `parse.ts` (accept string,
      reject non-string with a shaped error; `human: {}` unchanged)
- [x] 1.3 [core] Validate `human.prompt` templates in `validate.ts` with the
      agent-prompt rules (syntax, earlier-step refs, known output names,
      declared `needs` outputs, feedback legality)
- [x] 1.4 [test] Parser + validation coverage: prompt accepted, non-string
      rejected, later-step reference rejected, `needs` output check,
      promptless gate untouched

## 2. Engine: render on arm, persist, preserve on decision

- [x] 2.1 [server] After `applyTransition`, detect steps that entered
      `waiting_human`; when the step declares `prompt`, render via
      `buildEvalContext` (with feedback snapshot when present) and persist
      the text under the step's `prompt` output; log render errors, never
      block the gate
- [x] 2.2 [server] Change `resolveGates` to merge `notes` into existing step
      outputs instead of replacing them (prompt survives the decision)
- [x] 2.3 [test] Engine tests: prompt rendered+persisted on arm; render error
      arms the gate with partial text and logs; rerun re-arm re-renders with
      round context; notes decision preserves the prompt output; restart
      (fresh store read) still sees the prompt

## 3. Surfaces: API, web UI, CLI

- [x] 3.1 [server] Feature detail projection: step entries carry optional
      `prompt` when `waiting_human` and a rendered prompt exists
- [x] 3.2 [web] Gate panel renders the prompt as pre-wrapped plain text above
      the approve/reject controls
- [x] 3.3 [web] Pure parser for the `conductor-questions` fenced block
      (JSON array of `{question, options?}`; anything malformed → null) and
      a notes composer serialising answers to plain-text Q/A pairs
- [x] 3.4 [web] Answer form in the gate panel when the block parses: per
      question, option picker + free-text custom answer; submit composes
      the notes; malformed block falls back to the plain prompt + free-form
      notes
- [x] 3.5 [cli] `conductor status <feature-id>` prints the pending gate
      prompt under the gate line
- [x] 3.6 [test] API projection test (prompt present when waiting, absent for
      promptless gates); parser/composer unit tests (valid, malformed,
      options+custom); gate panel form test; CLI status test

## 4. Docs

- [x] 4.1 [docs] `docs/workflow-reference.md`: replace the human-gate
      "(planned)" note with the `prompt` field reference (contexts, render
      timing, reserved `prompt` output); note in `docs/expressions.md` output
      names table
- [x] 4.2 [docs] Document the `conductor-questions` convention (block format,
      degradation, an example agent-prompt instruction that asks the agent to
      end its report with the block)
