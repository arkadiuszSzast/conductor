import type { JobColumnModel } from "./workflow-board.ts"
import { JobFrontierCard } from "./job-frontier-card.tsx"
import styles from "./job-column.module.css"

export function JobColumn({ column }: { readonly column: JobColumnModel }): React.ReactNode {
  const hasAttention = column.cards.some(c => c.status === "waiting_human" || c.status === "escalated")
  return (
    <div className={styles.column}>
      <div className={`${styles.head} ${hasAttention ? styles.attention : ""}`}>
        {hasAttention ? <span className={styles.dot} aria-hidden="true" /> : null}
        <span className={styles.jobId}>{column.jobId}</span>
        <span className={styles.count}>({column.cards.length})</span>
      </div>
      <div className={styles.cards}>
        {column.cards.length === 0 ? (
          <div className={styles.empty}>—</div>
        ) : (
          column.cards.map(card => <JobFrontierCard key={card.cardId} card={card} />)
        )}
      </div>
    </div>
  )
}
