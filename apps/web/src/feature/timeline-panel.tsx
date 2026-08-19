import type { TransitionEntry } from "../api/types.ts"
import { formatClock } from "../lib/time.ts"
import styles from "./workspace-panels.module.css"

export function TimelinePanel({ entries }: { readonly entries: TransitionEntry[] | undefined }): React.ReactNode {
  return (
    <div className={styles.panel}>
      {entries === undefined ? (
        <div className={styles.empty}>loading…</div>
      ) : entries.length === 0 ? (
        <div className={styles.empty}>no timeline entries</div>
      ) : (
        entries.map((entry, i) => {
          const jobId = typeof entry.event["jobId"] === "string" ? entry.event["jobId"] : null
          const stepId = typeof entry.event["stepId"] === "string" ? entry.event["stepId"] : null
          const reason = typeof entry.event["reason"] === "string" ? entry.event["reason"] : null
          return (
            <div key={i} className={styles.tlEntry}>
              <span className={styles.tlTime}>{formatClock(entry.time)}</span>
              {entry.event.kind}
              {jobId !== null ? (
                <code className={styles.tlTarget}>
                  {jobId}
                  {stepId !== null ? `/${stepId}` : ""}
                </code>
              ) : null}
              {reason !== null ? <span className={styles.tlReason}>{reason}</span> : null}
            </div>
          )
        })
      )}
    </div>
  )
}
