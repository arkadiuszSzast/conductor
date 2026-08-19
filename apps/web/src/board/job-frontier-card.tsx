/**
 * One frontier card — a feature's presence at a single job column. When a
 * feature has more than one active job, every instance carries the same
 * `parallelCount` so the card can mark itself as part of parallel work
 * without pretending one job is more "primary" than the other.
 *
 * The quick-review/recover links carry an `open=` query param the feature
 * workspace reads on mount to surface the right sheet immediately — the
 * primary human action is reachable directly from the card without a
 * second click once the workspace loads.
 */

import { Link } from "wouter"
import type { FrontierCardModel } from "./workflow-board.ts"
import { statusGlyph } from "./card-model.ts"
import styles from "./job-frontier-card.module.css"

export interface JobFrontierCardProps {
  readonly card: FrontierCardModel
}

const STATUS_LABEL: Record<FrontierCardModel["status"], string> = {
  waiting_human: "waiting human",
  escalated: "escalated",
  running: "running",
  paused: "paused",
  done: "done",
  abandoned: "abandoned",
}

const STATUS_CLASS: Record<FrontierCardModel["status"], string> = {
  waiting_human: "waiting",
  escalated: "escalated",
  running: "running",
  paused: "paused",
  done: "terminal",
  abandoned: "terminal",
}

export function JobFrontierCard({ card }: JobFrontierCardProps): React.ReactNode {
  const cls = STATUS_CLASS[card.status]
  const attention = card.status === "waiting_human" || card.status === "escalated"
  const baseHref = `/feature/${card.id}?job=${encodeURIComponent(card.jobId)}`
  const actionHref = card.status === "waiting_human" ? `${baseHref}&open=gate` : card.status === "escalated" ? `${baseHref}&open=recover` : baseHref
  const progressPercent = card.jobsTotal > 0 ? Math.min(100, Math.max(0, (card.jobsDone / card.jobsTotal) * 100)) : 0

  return (
    <div className={`${styles.card} ${styles[cls]} ${attention ? styles.attention : ""}`} data-card-id={card.cardId}>
      <Link href={baseHref} className={styles.cardLink}>
        <div className={styles.head}>
          <span className={`${styles.glyph} ${styles[cls]}`} aria-hidden="true">
            {statusGlyph(card.status)}
          </span>
          <span className={styles.statusLabel}>{STATUS_LABEL[card.status]}</span>
          {card.parallelCount > 1 ? (
            <span className={styles.parallel} title={`Active at ${card.parallelCount} jobs in parallel`}>
              ⑂ ×{card.parallelCount}
            </span>
          ) : null}
          <span className={styles.age}>{card.age}</span>
        </div>
        <div className={styles.title}>{card.title}</div>
        <div className={styles.meta}>
          {card.project} · {card.workflow}
        </div>
        <div className={styles.progress}>
          <span className={styles.progressTrack} aria-hidden="true">
            <span className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
          </span>
          <span>
            jobs {card.jobsDone}/{card.jobsTotal}
          </span>
        </div>
        {card.frontierKind === "escalated-fallback" ? <div className={styles.failedTag}>✖ job failed</div> : null}
        {card.escalation !== null ? <div className={styles.escalation}>{card.escalation}</div> : null}
        {card.findingsNew > 0 ? <div className={styles.findings}>⚑ {card.findingsNew} new</div> : null}
      </Link>
      {attention ? (
        <Link href={actionHref} className={`${styles.quickAction} ${card.status === "escalated" ? styles.recoverAction : ""} tap-target`}>
          {card.status === "waiting_human" ? "review →" : "recover →"}
        </Link>
      ) : null}
    </div>
  )
}
