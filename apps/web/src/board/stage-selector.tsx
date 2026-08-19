/**
 * Mobile job-stage selector — below the mobile breakpoint the board shows
 * one job column's feature list at a time with horizontal stage
 * navigation instead of shrinking every column past a usable width.
 */

import styles from "./stage-selector.module.css"

export interface StageOption {
  readonly jobId: string
  readonly count: number
  readonly hasAttention: boolean
}

export interface StageSelectorProps {
  readonly stages: readonly StageOption[]
  readonly selected: string | null
  readonly onSelect: (jobId: string) => void
}

export function StageSelector({ stages, selected, onSelect }: StageSelectorProps): React.ReactNode {
  return (
    <div className={styles.wrap} role="group" aria-label="Workflow job stage">
      {stages.map(stage => {
        const isSelected = stage.jobId === selected
        return (
          <button
            key={stage.jobId}
            type="button"
            aria-pressed={isSelected}
            className={`${styles.stage} ${isSelected ? styles.selected : ""} ${stage.hasAttention ? styles.attention : ""}`}
            onClick={() => onSelect(stage.jobId)}
          >
            {stage.hasAttention ? <span className={styles.dot} aria-hidden="true" /> : null}
            {stage.jobId}
            <span className={styles.count}>{stage.count}</span>
          </button>
        )
      })}
    </div>
  )
}
