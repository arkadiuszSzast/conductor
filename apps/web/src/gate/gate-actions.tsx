import { useGateActions } from "./use-gate-actions.ts"
import { surfaceItemKey } from "./gate-surfaces.ts"
import styles from "./gate-actions.module.css"

export interface GateActionsProps {
  readonly featureId: string
  readonly showChangeNoteInline?: boolean
  /** Reports pending state to a wrapping container (e.g. an `ActionSheet`)
   *  so it can disable Escape/backdrop dismissal while a command is in
   *  flight, without this component knowing anything about the shell it
   *  renders inside. */
  readonly onPendingChange?: (pending: boolean) => void
  /** Fires after a decision or answer is accepted by the server — lets a
   *  wrapping sheet close itself and show success feedback without this
   *  component duplicating that container's close/toast logic. `remaining`
   *  is how many attention surfaces are still outstanding. */
  readonly onSuccess?: (message: string, remaining: number) => void
}

/**
 * Self-contained gate panel: prompt/questions body plus its own inline
 * action row. Callers that need the actions rendered separately (e.g. in
 * an `ActionSheet`'s sticky footer) use `useGateActions` directly with
 * `GateQuestionBody` and `GateActionButtons` instead of this component —
 * see `GateModal`.
 */
export function GateActions({ featureId, showChangeNoteInline = true, onPendingChange, onSuccess }: GateActionsProps): React.ReactNode {
  const gate = useGateActions({ featureId, onPendingChange, onSuccess })
  if (!gate.waiting) return null

  return (
    <div className={styles.gateRow}>
      <SurfaceNavigator gate={gate} />
      <GateQuestionBody gate={gate} showChangeNoteInline={showChangeNoteInline} />
      <GateActionButtons gate={gate} showChangeNoteInline={showChangeNoteInline} />
      {gate.inlineError !== null ? <div className={styles.inlineError} role="alert">{gate.inlineError}</div> : null}
    </div>
  )
}

export interface GateBodyProps {
  readonly gate: ReturnType<typeof useGateActions>
  readonly showChangeNoteInline?: boolean
}

/**
 * Only rendered once there is more than one concurrent attention surface
 * — a lone gate keeps today's simple UX with no navigator chrome at all.
 */
export function SurfaceNavigator({ gate }: { readonly gate: ReturnType<typeof useGateActions> }): React.ReactNode {
  const { items, selected, selectItem } = gate
  if (items.length <= 1) return null
  return (
    <div className={styles.navigator} role="group" aria-label="Attention surfaces">
      {items.map(item => {
        const key = surfaceItemKey(item)
        const label = item.kind === "gate" ? `${item.jobId}/${item.stepId}` : `${item.jobId}/${item.stepId} (question)`
        const isSelected = selected !== null && surfaceItemKey(selected) === key
        return (
          <button
            key={key}
            type="button"
            aria-pressed={isSelected}
            className={`${styles.navItem} ${isSelected ? styles.navItemActive : ""}`}
            onClick={() => selectItem(item)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/** The prompt/structured-question/notes body — no action buttons. */
export function GateQuestionBody({ gate, showChangeNoteInline = true }: GateBodyProps): React.ReactNode {
  const { detail, selected, surfaces, panelPrompt, parsedQuestions, answers, setAnswer, notes, setNotes, pending } = gate
  const askingRun = selected?.kind === "ask" ? selected : null
  return (
    <>
      <div className={styles.meta}>
        ≡ {askingRun !== null ? `${askingRun.stepId} (question)` : detail?.currentStep ?? "gate"} · ⚑ {detail?.findingCounts?.new ?? 0} new
      </div>
      {askingRun === null && surfaces.gates.length > 1 ? (
        <div className={styles.disclosure}>
          approving or requesting changes here resolves all {surfaces.gates.length} waiting gates:{" "}
          {surfaces.gates.map(g => `${g.jobId}/${g.stepId}`).join(", ")}
        </div>
      ) : null}
      {parsedQuestions !== null ? (
        <>
          {parsedQuestions.text !== "" ? <div className={styles.prompt}>{parsedQuestions.text}</div> : null}
          {parsedQuestions.questions.map((question, index) => {
            const answer = answers[index] ?? { chosen: null, custom: "" }
            return (
              <fieldset key={index} className={styles.question}>
                <legend className={styles.questionText}>{question.question}</legend>
                {question.options.map((option, optionIndex) => (
                  <label key={optionIndex} className={styles.option}>
                    <input
                      type="radio"
                      name={`gate-q-${index}`}
                      checked={answer.chosen === optionIndex}
                      onChange={() => setAnswer(index, { chosen: optionIndex, custom: "" })}
                      disabled={pending}
                    />
                    {option}
                  </label>
                ))}
                <label className={styles.option}>
                  <input
                    type="radio"
                    name={`gate-q-${index}`}
                    checked={answer.chosen === null && answer.custom !== ""}
                    onChange={() => setAnswer(index, { chosen: null, custom: answer.custom })}
                    disabled={pending}
                  />
                  <input
                    className={styles.customInput}
                    placeholder="your own answer"
                    aria-label={`Custom answer for ${question.question}`}
                    value={answer.custom}
                    onChange={e => setAnswer(index, { chosen: null, custom: e.target.value })}
                    disabled={pending}
                  />
                </label>
              </fieldset>
            )
          })}
        </>
      ) : panelPrompt !== null ? (
        <div className={styles.prompt}>{panelPrompt}</div>
      ) : null}
      {showChangeNoteInline ? (
        <label className={styles.noteField}>
          <span className="visually-hidden">{askingRun !== null ? "Free-text answer" : "Decision note"}</span>
          <input
            className={styles.note}
            placeholder={askingRun !== null ? "answer (free text)" : "note (required to request changes)"}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            disabled={pending}
          />
        </label>
      ) : null}
    </>
  )
}

/** The decision/answer buttons alone — placeable in a sticky action row. */
export function GateActionButtons({ gate, showChangeNoteInline = true }: GateBodyProps): React.ReactNode {
  const { selected, pending, pendingAction, questionsIncomplete, notes, submit, submitAnswer } = gate
  const askingRun = selected?.kind === "ask" ? selected : null
  if (askingRun !== null) {
    return (
      <div className={styles.actions}>
        <button className="primary" disabled={pending || questionsIncomplete} onClick={() => void submitAnswer()}>
          {pending ? "…" : "↩ Send answer"}
        </button>
      </div>
    )
  }
  return (
    <div className={styles.actions}>
      <button className="primary" disabled={pending || questionsIncomplete} onClick={() => void submit("approve")}>
        {pending && pendingAction === "approve" ? "…" : "✓ Approve"}
      </button>
      <button
        className="danger"
        disabled={pending || (showChangeNoteInline && notes.trim() === "")}
        onClick={() => void submit("request-changes")}
      >
        {pending && pendingAction === "request-changes" ? "…" : "✎ Request changes"}
      </button>
    </div>
  )
}
