/**
 * Gate decision state/commands — extracted from `GateActions` so a
 * container (e.g. `GateModal`) can render the question/prompt body and
 * the submit buttons in different places (a sheet's scrollable body vs.
 * its sticky action row) while every validation, submission, and error
 * rule stays defined exactly once. `GateActions` itself is a thin
 * composition of this hook for callers that want one inline block.
 *
 * A feature can expose more than one attention surface at once —
 * multiple parallel `waiting_human` job/steps, and/or multiple
 * interactive runs each sitting on their own pending question
 * (`gate-surfaces.ts`). `selected` navigates between them; approve/
 * request-changes always resolve every gate listed in `surfaces.gates`
 * (the server iterates every `waiting_human` step in one call — never
 * just the selected one), so the UI must disclose that plainly rather
 * than implying the decision targets only the currently-viewed gate. An
 * answer, in contrast, targets exactly the selected asking run.
 */

import { useEffect, useMemo, useState } from "react"
import { useApp } from "../app-context.ts"
import { useAnswerRun, useCommand, useFeatureDetail } from "../api/hooks.ts"
import { mapGateError, validateGateDecision, type GateAction, type GateDecision } from "./gate-logic.ts"
import { answersComplete, composeAnswerNotes, parseGateQuestions, type GateAnswer, type ParsedGatePrompt } from "./gate-questions.ts"
import {
  allSurfaceItems,
  deriveGateSurfaces,
  pickSurfaceItem,
  surfaceCount,
  surfaceItemKey,
  type GateSurfaceItem,
  type GateSurfaces,
} from "./gate-surfaces.ts"
import { pushToast } from "../ui/toast-store.ts"
import type { FeatureDetail } from "../api/types.ts"

export interface UseGateActionsOptions {
  readonly featureId: string
  readonly onPendingChange?: (pending: boolean) => void
  /** Fires after a decision or answer is accepted. `remaining` is how many
   *  attention surfaces are still outstanding immediately after this
   *  action resolves its target(s) — approve/request-changes resolve
   *  every listed gate but never touch asking runs; an answer resolves
   *  only the selected run. A container (e.g. `GateModal`) uses this to
   *  decide whether to close (nothing left) or stay open so the operator
   *  can keep working through what remains. */
  readonly onSuccess?: (message: string, remaining: number) => void
}

export interface UseGateActionsResult {
  readonly waiting: boolean
  readonly detail: FeatureDetail | undefined
  /** Every concurrent gate/question this feature currently exposes. */
  readonly surfaces: GateSurfaces
  /** Flattened, navigable list — gates first, then asking runs. */
  readonly items: readonly GateSurfaceItem[]
  /** The currently-viewed item, or null when nothing is waiting. */
  readonly selected: GateSurfaceItem | null
  readonly selectItem: (item: GateSurfaceItem) => void
  readonly panelPrompt: string | null
  readonly parsedQuestions: ParsedGatePrompt | null
  readonly answers: readonly GateAnswer[]
  readonly setAnswer: (index: number, answer: GateAnswer) => void
  readonly notes: string
  readonly setNotes: (value: string) => void
  readonly pending: boolean
  readonly pendingAction: GateAction | null
  readonly inlineError: string | null
  readonly questionsIncomplete: boolean
  readonly submitAnswer: () => Promise<void>
  readonly submit: (action: GateAction) => Promise<void>
}

export function useGateActions({ featureId, onPendingChange, onSuccess }: UseGateActionsOptions): UseGateActionsResult {
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const runCommand = useCommand(store)
  const runAnswer = useAnswerRun(store)
  const [pending, setPendingState] = useState(false)
  const [notes, setNotes] = useState("")
  const [pendingAction, setPendingAction] = useState<GateAction | null>(null)
  const [inlineError, setInlineError] = useState<string | null>(null)

  const setPending = (value: boolean): void => {
    setPendingState(value)
    onPendingChange?.(value)
  }

  const detail = detailState.data?.feature
  const waiting = detail?.status === "waiting_human"
  const activeRuns = detailState.data?.activeRuns ?? []

  const surfaces = useMemo(() => deriveGateSurfaces(detail, activeRuns), [detail, activeRuns])
  const items = useMemo(() => allSurfaceItems(surfaces), [surfaces])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selected = useMemo(() => pickSurfaceItem(items, selectedKey), [items, selectedKey])
  if (selected !== null && surfaceItemKey(selected) !== selectedKey) setSelectedKey(surfaceItemKey(selected))
  if (selected === null && selectedKey !== null) setSelectedKey(null)

  const selectItem = (item: GateSurfaceItem): void => setSelectedKey(surfaceItemKey(item))

  const askingRun = selected?.kind === "ask" ? selected : null
  const panelPrompt = selected === null ? null : selected.prompt

  const parsedQuestions = useMemo(() => (panelPrompt !== null ? parseGateQuestions(panelPrompt) : null), [panelPrompt])
  const [answers, setAnswers] = useState<readonly GateAnswer[]>([])

  // Reset drafts when the feature or the selected surface's prompt
  // changes — the panel instance survives a board selection switch and a
  // rerun re-arm, and stale answers must never be submittable against a
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
      await runAnswer(featureId, client => client.answerRun(askingRun.runId, composed))
      setNotes("")
      setAnswers([])
      // Only the selected run's question is resolved — every other gate
      // and asking run this feature already had stays outstanding.
      onSuccess?.("✓ answer sent", surfaceCount(surfaces) - 1)
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
      // Every listed gate is resolved by this one call (resolveGates
      // iterates all waiting_human steps); asking runs are untouched.
      onSuccess?.(action === "approve" ? "✓ approved" : "✓ changes requested", surfaces.askingRuns.length)
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

  const questionsIncomplete = parsedQuestions !== null && !answersComplete(parsedQuestions.questions, answers)

  return {
    waiting,
    detail,
    surfaces,
    items,
    selected,
    selectItem,
    panelPrompt,
    parsedQuestions,
    answers,
    setAnswer,
    notes,
    setNotes,
    pending,
    pendingAction,
    inlineError,
    questionsIncomplete,
    submitAnswer,
    submit,
  }
}
