import { useEffect, useMemo, useState } from "react"
import { useApp } from "../app-context.ts"
import { useCommand, useFeatureDetail } from "../api/hooks.ts"
import { mapGateError, selectGateSurface, validateGateDecision, type GateAction, type GateDecision } from "./gate-logic.ts"
import {
  answersComplete,
  composeAnswerNotes,
  parseGateQuestions,
  type GateAnswer,
} from "./gate-questions.ts"
import { pushToast } from "../ui/toast-store.ts"
import styles from "./gate-actions.module.css"

export interface GateActionsProps {
  readonly featureId: string
  readonly showChangeNoteInline?: boolean
}

export function GateActions({ featureId, showChangeNoteInline = true }: GateActionsProps): React.ReactNode {
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const runCommand = useCommand(store)
  const [pending, setPending] = useState(false)
  const [notes, setNotes] = useState("")
  const [pendingAction, setPendingAction] = useState<GateAction | null>(null)
  const [inlineError, setInlineError] = useState<string | null>(null)

  const detail = detailState.data?.feature
  const waiting = detail?.status === "waiting_human"

  // The rendered prompt of the waiting gate step, when one exists.
  const gatePrompt = useMemo(() => {
    if (!waiting || !detail) return null
    for (const jobRuntime of Object.values(detail.jobs)) {
      for (const stepRuntime of Object.values(jobRuntime.steps)) {
        if (stepRuntime.status === "waiting_human" && stepRuntime.prompt !== undefined) {
          return stepRuntime.prompt
        }
      }
    }
    return null
  }, [waiting, detail])

  const activeRun = detailState.data?.activeRun ?? null
  const surface = selectGateSurface(waiting, gatePrompt, activeRun)
  const askingRun = surface?.kind === "ask" ? surface : null
  const panelPrompt = surface?.prompt ?? null

  const parsedQuestions = useMemo(
    () => (panelPrompt !== null ? parseGateQuestions(panelPrompt) : null),
    [panelPrompt],
  )
  const [answers, setAnswers] = useState<readonly GateAnswer[]>([])

  // Reset drafts when the feature or the gate's rendered prompt changes —
  // the panel instance survives a board selection switch and a rerun
  // re-arm, and stale answers must never be submittable against a
  // different gate's questions.
  useEffect(() => {
    setAnswers([])
    setNotes("")
    setInlineError(null)
  }, [featureId, panelPrompt])

  const setAnswer = (index: number, answer: GateAnswer): void => {
    setAnswers(previous => {
      const next = [...previous]
      while (next.length <= index) next.push({ chosen: null, custom: "" })
      next[index] = answer
      return next
    })
  }

  const submitAnswer = async (): Promise<void> => {
    if (askingRun === null) return
    const composed = parsedQuestions !== null
      ? [composeAnswerNotes(parsedQuestions.questions, answers), notes.trim()].filter(part => part !== "").join("\n\n")
      : notes.trim()
    if (composed === "") {
      setInlineError("an answer is required")
      return
    }
    setInlineError(null)
    setPending(true)
    try {
      await runCommand(featureId, client => client.answerRun(askingRun.runId, composed))
      setNotes("")
      setAnswers([])
    } catch (err) {
      const handled = mapGateError(err)
      if (handled.inline) {
        setInlineError(handled.toast !== "" ? handled.toast : "invalid request")
      } else if (handled.toast !== "") {
        pushToast(handled.toast)
      }
      if (handled.refetch) store.refetchFeatureDetail(featureId)
    } finally {
      setPending(false)
    }
  }

  const submit = async (action: GateAction): Promise<void> => {
    const composed = parsedQuestions !== null && action === "approve"
      ? [composeAnswerNotes(parsedQuestions.questions, answers), notes.trim()].filter(part => part !== "").join("\n\n")
      : notes
    const decision: GateDecision = { action, notes: composed }
    const validationError = validateGateDecision(decision)
    if (validationError !== null) {
      setInlineError(validationError)
      return
    }
    setInlineError(null)
    setPending(true)
    setPendingAction(action)
    try {
      await runCommand(featureId, client =>
        action === "approve"
          ? client.approve(featureId, composed.trim() !== "" ? composed.trim() : undefined)
          : client.requestChanges(featureId, composed.trim()),
      )
      setNotes("")
      setAnswers([])
    } catch (err) {
      const handled = mapGateError(err)
      if (handled.inline) {
        setInlineError(handled.toast !== "" ? handled.toast : "invalid request")
      } else if (handled.toast !== "") {
        pushToast(handled.toast)
      }
      if (handled.refetch) store.refetchFeatureDetail(featureId)
    } finally {
      setPending(false)
      setPendingAction(null)
    }
  }

  if (!waiting) return null

  const questionsIncomplete =
    parsedQuestions !== null && !answersComplete(parsedQuestions.questions, answers)

  return (
    <div className={styles.gateRow}>
      <div className={styles.meta}>
        ≡ {askingRun !== null ? `${askingRun.stepId} (question)` : detail?.currentStep ?? "gate"} · ⚑ {detail?.findingCounts?.new ?? 0} new
      </div>
      {parsedQuestions !== null ? (
        <>
          {parsedQuestions.text !== "" ? <div className={styles.prompt}>{parsedQuestions.text}</div> : null}
          {parsedQuestions.questions.map((question, index) => {
            const answer = answers[index] ?? { chosen: null, custom: "" }
            return (
              <div key={index} className={styles.question}>
                <div className={styles.questionText}>{question.question}</div>
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
                    value={answer.custom}
                    onChange={e => setAnswer(index, { chosen: null, custom: e.target.value })}
                    disabled={pending}
                  />
                </label>
              </div>
            )
          })}
        </>
      ) : panelPrompt !== null ? (
        <div className={styles.prompt}>{panelPrompt}</div>
      ) : null}
      {showChangeNoteInline ? (
        <div className={styles.row}>
          <input
            className={styles.note}
            placeholder={askingRun !== null ? "answer (free text)" : "note (required to request changes)"}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            disabled={pending}
          />
        </div>
      ) : null}
      {askingRun !== null ? (
        <div className={styles.actions}>
          <button
            className="primary"
            disabled={pending || questionsIncomplete}
            onClick={() => void submitAnswer()}
          >
            {pending ? "…" : "↩ Send answer"}
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            className="primary"
            disabled={pending || questionsIncomplete}
            onClick={() => submit("approve")}
          >
            {pending && pendingAction === "approve" ? "…" : "✓ Approve"}
          </button>
          <button
            className="danger"
            disabled={pending || (showChangeNoteInline && notes.trim() === "")}
            onClick={() => submit("request-changes")}
          >
            {pending && pendingAction === "request-changes" ? "…" : "✎ Request changes"}
          </button>
        </div>
      )}
      {inlineError !== null ? <div className={styles.inlineError}>{inlineError}</div> : null}
    </div>
  )
}
