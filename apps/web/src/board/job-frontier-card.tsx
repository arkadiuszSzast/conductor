/**
 * One frontier card — a feature's presence in a single pipeline stage,
 * listing each of its active jobs there with the step it is on. When the
 * feature's frontier spans more jobs than this stage holds, the card
 * carries `parallelCount` so it can mark itself as part of parallel work.
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
  const primaryJob = card.activeJobs[0]?.jobId ?? ""
  const baseHref = `/feature/${card.id}?job=${encodeURIComponent(primaryJob)}`
  const actionHref = card.status === "waiting_human" ? `${baseHref}&open=gate` : card.status === "escalated" ? `${baseHref}&open=recover` : baseHref
  const progressPercent = card.jobsTotal > 0 ? Math.min(100, Math.max(0, (card.jobsDone / card.jobsTotal) * 100)) : 0

  return (
    <div className={`${styles.card} ${styles[cls]} ${attention ? styles.attention : ""} ${card.troubled !== null ? styles.troubledCard : ""}`} data-card-id={card.cardId}>
      <Link href={baseHref} className={styles.cardLink}>
        <div className={styles.head}>
          <span className={`${styles.glyph} ${styles[cls]}`} aria-hidden="true">
            {statusGlyph(card.status)}
          </span>
          <span className={styles.statusLabel}>{card.troubled !== null ? "attention" : STATUS_LABEL[card.status]}</span>
          {card.parallelCount > card.activeJobs.length ? (
            <span className={styles.parallel} title={`Active at ${card.parallelCount} jobs in parallel`}>
              ⑂ ×{card.parallelCount}
            </span>
          ) : null}
          <span className={styles.age}>{card.age}</span>
        </div>
        <div className={styles.title}>{card.title}</div>
      </Link>
      <ul className={styles.jobs}>
        {card.activeJobs.map(job => (
          <li key={job.jobId}>
            <Link href={`/feature/${card.id}?job=${encodeURIComponent(job.jobId)}`} className={`${styles.job} ${styles[`job_${job.status}`] ?? ""}`}>
              <span className={styles.jobGlyph} aria-hidden="true">
                {jobGlyph(job.status)}
              </span>
              <span className={styles.jobId}>{job.jobId}</span>
              {job.stepId !== null ? <span className={styles.stepId}>› {job.stepId}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
      <div className={styles.footer}>
        <div className={styles.progress}>
          <span className={styles.progressTrack} aria-hidden="true">
            <span className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
          </span>
          <span>
            jobs {card.jobsDone}/{card.jobsTotal}
          </span>
        </div>
        {card.frontierKind === "escalated-fallback" ? <div className={styles.failedTag}>✖ job failed</div> : null}
        {card.escalation !== null ? (
          <div className={styles.escalation} title={card.escalation}>
            {card.escalation}
          </div>
        ) : null}
        {card.troubled !== null ? (
          <div className={styles.troubled} title={card.troubled.diagnostic ?? card.troubled.summary}>
            ⚠ {card.troubled.summary}
          </div>
        ) : null}
        {card.findingsNew > 0 ? <div className={styles.findings}>⚑ {card.findingsNew} new</div> : null}
      </div>
      {attention ? (
        <Link href={actionHref} className={`${styles.quickAction} ${card.status === "escalated" ? styles.recoverAction : ""} tap-target`}>
          {card.status === "waiting_human" ? "review →" : "recover →"}
        </Link>
      ) : null}
    </div>
  )
}

function jobGlyph(status: FrontierCardModel["activeJobs"][number]["status"]): string {
  switch (status) {
    case "running":
      return "●"
    case "ready":
      return "○"
    case "failed":
      return "✖"
    default:
      return "·"
  }
}
