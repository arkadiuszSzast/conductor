/**
 * Generic destructive-confirmation sheet — used for abandon and any other
 * one-shot irreversible lifecycle action that needs an explicit "yes".
 */

import { useState } from "react"
import { ActionSheet } from "./action-sheet.tsx"
import styles from "./confirm-sheet.module.css"

export interface ConfirmSheetProps {
  readonly title: string
  readonly context?: string
  readonly body: React.ReactNode
  readonly confirmLabel: string
  readonly onConfirm: () => Promise<void>
  readonly onClose: () => void
}

export function ConfirmSheet({ title, context, body, confirmLabel, onConfirm, onClose }: ConfirmSheetProps): React.ReactNode {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <ActionSheet
      title={title}
      context={context}
      onClose={onClose}
      closeDisabled={pending}
      actions={
        <>
          <button onClick={onClose} disabled={pending}>
            cancel
          </button>
          <button className="danger" onClick={() => void confirm()} disabled={pending}>
            {pending ? "…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className={styles.body}>{body}</div>
      {error !== null ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
    </ActionSheet>
  )
}
