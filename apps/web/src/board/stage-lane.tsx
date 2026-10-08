import type { StageColumnModel } from "./workflow-board.ts"
import { isAttentionStatus } from "./workflow-board.ts"
import { JobFrontierCard } from "./job-frontier-card.tsx"
import styles from "./stage-lane.module.css"

export function StageLane({ stage, total }: { readonly stage: StageColumnModel; readonly total: number }): React.ReactNode {
  const attention = stage.cards.some(card => isAttentionStatus(card.status))
  return (
    <section className={styles.lane} data-stage-index={stage.index} aria-label={`Stage ${stage.index + 1}: ${stage.label}`}>
      <header className={`${styles.head} ${attention ? styles.attention : ""}`}>
        <span className={styles.step}>
          {stage.index + 1}/{total}
        </span>
        {attention ? <span className={styles.dot} aria-hidden="true" /> : null}
        <span className={styles.label} title={stage.jobIds.join(", ")}>
          {stage.label}
        </span>
        <span className={styles.count}>{stage.cards.length}</span>
      </header>
      <div className={styles.cards}>
        {stage.cards.map(card => (
          <JobFrontierCard key={card.cardId} card={card} />
        ))}
      </div>
    </section>
  )
}
