import { useState } from "react"
import type { TransitionEntry } from "../api/types.ts"
import { formatClock } from "../lib/time.ts"
import styles from "./workspace-panels.module.css"

const EVENT_LABEL: Record<string, { readonly text: string; readonly tone: "ok" | "bad" | "warn" | "info" }> = {
  "feature.start": { text: "started", tone: "info" },
  "step.completed": { text: "completed", tone: "ok" },
  "step.failed": { text: "failed", tone: "bad" },
  "step.budget_exhausted": { text: "budget exhausted", tone: "bad" },
  "step.execution_unknown": { text: "outcome unknown", tone: "warn" },
  "step.fence_classified": { text: "fence classified", tone: "warn" },
  "human.paused": { text: "paused", tone: "warn" },
  "human.resumed": { text: "resumed", tone: "info" },
  "human.abandoned": { text: "abandoned", tone: "bad" },
}

function describe(kind: string): { readonly text: string; readonly tone: "ok" | "bad" | "warn" | "info" } {
  return EVENT_LABEL[kind] ?? { text: kind.replace(/[._]/g, " "), tone: "info" }
}

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
          const outcome = typeof entry.event["outcome"] === "string" ? entry.event["outcome"] : null
          const label = describe(entry.event.kind)
          return (
            <div key={i} className={styles.tlEntry} title={entry.event.kind}>
              <span className={styles.tlTime}>{formatClock(entry.time)}</span>
              {jobId !== null ? (
                <code className={styles.tlTarget}>
                  {jobId}
                  {stepId !== null ? `/${stepId}` : ""}
                </code>
              ) : null}
              <span className={`${styles.tlKind} ${styles[`tone_${label.tone}`]}`}>{label.text}</span>
              {outcome !== null ? <span className={styles.tlOutcome}>{outcome}</span> : null}
              {reason !== null ? <Reason text={reason} /> : null}
            </div>
          )
        })
      )}
    </div>
  )
}

/** Failure reasons can carry a whole command line and stack trace —
 *  clamp to a few lines, expand on demand. */
function Reason({ text }: { readonly text: string }): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 240 || text.split("\n").length > 3
  return (
    <span className={`${styles.tlReason} ${long && !expanded ? styles.tlClamped : ""}`}>
      {text}
      {long ? (
        <button type="button" className={styles.tlMore} onClick={() => setExpanded(value => !value)}>
          {expanded ? "less" : "more"}
        </button>
      ) : null}
    </span>
  )
}
