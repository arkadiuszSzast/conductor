import { useState } from "react"
import { useApp } from "../app-context.ts"
import { useCommand, useFeatureDetail } from "../api/hooks.ts"
import { mapGateError, validateGateDecision, type GateAction, type GateDecision } from "./gate-logic.ts"
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

  const submit = async (action: GateAction): Promise<void> => {
    const decision: GateDecision = { action, notes }
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
          ? client.approve(featureId, notes.trim() !== "" ? notes.trim() : undefined)
          : client.requestChanges(featureId, notes.trim()),
      )
      setNotes("")
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

  return (
    <div className={styles.gateRow}>
      <div className={styles.meta}>
        ≡ {detail?.currentStep ?? "gate"} · ⚑ {detail?.findingCounts.new ?? 0} new
      </div>
      {showChangeNoteInline ? (
        <div className={styles.row}>
          <input
            className={styles.note}
            placeholder="note (required to request changes)"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            disabled={pending}
          />
        </div>
      ) : null}
      <div className={styles.actions}>
        <button
          className="primary"
          disabled={pending}
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
      {inlineError !== null ? <div className={styles.inlineError}>{inlineError}</div> : null}
    </div>
  )
}
