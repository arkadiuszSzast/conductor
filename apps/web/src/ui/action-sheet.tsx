/**
 * Accessible dialog/sheet primitive shared by gate decisions, recovery,
 * and destructive confirmations. Renders as a centered dialog on wide
 * viewports and a bottom sheet on narrow ones (CSS media query, same
 * markup) with a scrollable body and sticky actions so the primary
 * control stays reachable behind a software keyboard.
 *
 * Owns focus management: focus moves into the sheet on open, Tab is
 * trapped within it, Escape closes it, and focus restores to the
 * triggering element on close.
 *
 * `closeDisabled` (set by every caller while its own request is pending)
 * also disables the close button — which means the dialog can end up
 * with EVERY descendant control disabled (a pending start-work submit
 * disables every field plus cancel/close). The dialog container itself
 * therefore carries `tabIndex={-1}` so it remains a valid focus target:
 * whenever no focusable descendant exists — on open, or because pending
 * state disabled whatever was previously focused out from under it — the
 * container itself takes focus instead of leaking focus back to the
 * page/trigger while the dialog is still open. Tab is a no-op (not
 * merely unhandled) in that state so it can never escape the trap.
 * `aria-busy` mirrors `closeDisabled` so assistive tech announces the
 * pending state without relying on visual-only disabled styling.
 */

import { useEffect, useId, useRef } from "react"
import { createPortal } from "react-dom"
import styles from "./action-sheet.module.css"

export interface ActionSheetProps {
  readonly title: string
  readonly context?: string
  readonly onClose: () => void
  readonly children: React.ReactNode
  readonly actions?: React.ReactNode
  /** Disable Escape/backdrop close while a request is pending. Also
   *  disables the close button and sets `aria-busy` on the dialog. */
  readonly closeDisabled?: boolean
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ActionSheet({ title, context, onClose, children, actions, closeDisabled }: ActionSheetProps): React.ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const statusId = useId()
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE)
    if (first !== undefined && first !== null) first.focus()
    else dialog?.focus()
    return () => {
      previouslyFocused.current?.focus?.()
    }
  }, [])

  // If a control disables out from under the currently-focused element
  // (e.g. submit sets `pending`, disabling every field including
  // whatever had focus), some browsers blur to `<body>` immediately;
  // others (and this test environment) leave `activeElement` pointing at
  // the now-disabled node, which the `:not([disabled])` clause in
  // `FOCUSABLE` no longer matches — checking `dialog.contains(...)`
  // alone is not enough, the active element must still MATCH the
  // focusable selector to count as a valid anchor. Re-anchor to the
  // dialog itself (or its first still-focusable descendant) whenever
  // that is not the case, so the trap holds even while every descendant
  // is disabled.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const active = document.activeElement
    const activeIsValid =
      active !== null && active !== document.body && dialog.contains(active) && active.matches(FOCUSABLE)
    if (activeIsValid) return
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
    if (first !== null) first.focus()
    else dialog.focus()
  }, [closeDisabled])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (closeDisabled) return
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== "Tab") return
      const dialog = dialogRef.current
      if (dialog === null) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) {
        // Nothing to cycle between — keep focus pinned to the dialog
        // container itself rather than letting Tab fall through to
        // whatever the browser would focus next in the page behind it.
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onClose, closeDisabled])

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={e => {
        if (e.target === e.currentTarget && !closeDisabled) onClose()
      }}
    >
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={closeDisabled ? statusId : undefined}
        aria-busy={closeDisabled ? true : undefined}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className={styles.head}>
          <div>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {context !== undefined ? <div className={styles.context}>{context}</div> : null}
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
        <div id={statusId} className="visually-hidden" role="status" aria-live="polite">
          {closeDisabled ? "request in progress, please wait" : ""}
        </div>
      </div>
    </div>,
    document.body,
  )
}
