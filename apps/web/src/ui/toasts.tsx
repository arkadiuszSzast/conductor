import { useSyncExternalStore } from "react"
import { dismissToast, getToasts, subscribeToasts } from "./toast-store.ts"
import styles from "./toasts.module.css"

export function Toasts(): React.ReactNode {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  return (
    <div className={styles.wrap} role="status" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.kind]}`} role={toast.kind === "error" ? "alert" : undefined}>
          <div className={styles.message}>{toast.message}</div>
          <button className={styles.dismiss} onClick={() => dismissToast(toast.id)} aria-label={`Dismiss notification: ${toast.message}`}>
            dismiss
          </button>
        </div>
      ))}
    </div>
  )
}
