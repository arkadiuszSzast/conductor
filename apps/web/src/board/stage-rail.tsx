/**
 * Pipeline rail — every stage of the workflow in order as one compact
 * strip, so the whole pipeline stays legible while the lanes below only
 * show stages that actually hold work. Empty stages collapse to a dim
 * pip; occupied ones show their count and jump to their lane.
 */

import type { StageColumnModel } from "./workflow-board.ts"
import { isAttentionStatus } from "./workflow-board.ts"
import styles from "./stage-rail.module.css"

export interface StageRailProps {
  readonly stages: readonly StageColumnModel[]
  readonly onSelect: (stageIndex: number) => void
}

export function StageRail({ stages, onSelect }: StageRailProps): React.ReactNode {
  return (
    <nav className={styles.rail} aria-label="Pipeline stages">
      <ol className={styles.list}>
        {stages.map(stage => {
          const count = stage.cards.length
          const attention = stage.cards.some(card => isAttentionStatus(card.status))
          const title = `${stage.jobIds.join(", ")}${count > 0 ? ` — ${count} active` : ""}`
          return (
            <li key={stage.index} className={styles.item}>
              {count === 0 ? (
                <span className={styles.empty} title={title}>
                  <span className={styles.pip} aria-hidden="true" />
                  <span className={styles.emptyLabel}>{stage.label}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className={`${styles.stage} ${attention ? styles.attention : ""}`}
                  title={title}
                  onClick={() => onSelect(stage.index)}
                >
                  {attention ? <span className={styles.dot} aria-hidden="true" /> : null}
                  <span className={styles.label}>{stage.label}</span>
                  <span className={styles.count}>{count}</span>
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
