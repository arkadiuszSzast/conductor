import { useSyncExternalStore } from "react"
import { dismissToast, getToasts, subscribeToasts } from "./toast-store.ts"
import styles from "./toasts.module.css"

export function Toasts(): React.ReactNode {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  if (toasts.length === 0) return null
  return (
    <div className={styles.wrap}>
      {toasts.map(toast => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.kind]}`}>
          <div className={styles.message}>{toast.message}</div>
          <button className={styles.dismiss} onClick={() => dismissToast(toast.id)}>
            dismiss
          </button>
        </div>
      ))}
    </div>
  )
}
