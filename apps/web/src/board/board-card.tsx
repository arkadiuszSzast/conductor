import { statusGlyph as boardGlyph, type BoardCardModel } from "./card-model.ts"
import styles from "./board-card.module.css"

const STATUS_LABEL: Record<BoardCardModel["status"], string> = {
  waiting_human: "waiting",
  escalated: "escalated",
  running: "running",
  paused: "paused",
  done: "done",
  abandoned: "abandoned",
}

const STATUS_CLASS: Record<BoardCardModel["status"], string> = {
  waiting_human: "waiting",
  escalated: "escalated",
  running: "running",
  paused: "paused",
  done: "terminal",
  abandoned: "terminal",
}

export interface BoardCardProps {
  readonly card: BoardCardModel
  readonly selected: boolean
  readonly onSelect: (id: string) => void
}

export function BoardCard({ card, selected, onSelect }: BoardCardProps): React.ReactNode {
  const findings = card.findingsNew > 0 ? `⚑ ${card.findingsNew} new` : null
  return (
    <div
      className={`${styles.card} ${styles[STATUS_CLASS[card.status]]} ${selected ? styles.selected : ""}`}
      onClick={() => onSelect(card.id)}
    >
      <div className={styles.head}>
        <span className={`${styles.glyph} ${styles[STATUS_CLASS[card.status]]}`}>{boardGlyph(card.status)}</span>
        <span className={styles.statusLabel}>{STATUS_LABEL[card.status]}</span>
        <span className={styles.age}>{card.age}</span>
      </div>
      <div className={styles.title}>{card.title}</div>
      <div className={styles.meta}>
        {card.project} · {card.workflow}
      </div>
      {card.currentStep !== null ? <div className={styles.step}>gate/step: {card.currentStep}</div> : null}
      <div className={styles.progress}>
        ▓▓○○ jobs {card.jobsDone}/{card.jobsTotal}
      </div>
      {findings !== null ? (
        <div className={`${styles.findings} ${card.findingsNew === 0 ? styles.zero : ""}`}>{findings}</div>
      ) : null}
      {card.escalation !== null ? <div className={styles.escalation}>{card.escalation}</div> : null}
    </div>
  )
}
