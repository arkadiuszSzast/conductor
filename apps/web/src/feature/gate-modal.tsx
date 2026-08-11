import { Link } from "wouter"
import { useApp } from "../app-context.ts"
import { useFeatureDetail, useFindings } from "../api/hooks.ts"
import { GateActions } from "../gate/gate-actions.tsx"
import type { FindingView } from "../api/types.ts"
import styles from "./gate-modal.module.css"

export interface GateModalProps {
  readonly featureId: string
  readonly onClose: () => void
}

export function GateModal({ featureId, onClose }: GateModalProps): React.ReactNode {
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const findingsState = useFindings(store, featureId)
  const detail = detailState.data?.feature
  const findings = findingsState.data ?? []

  const reportExcerpt = detail?.jobs
    ? Object.values(detail.jobs)
        .flatMap(job => Object.values(job.steps))
        .filter(step => step.status === "succeeded" || step.status === "failed")
        .flatMap(step => Object.values(step.outputs))
        .join("\n\n")
    : ""

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h2>review gate — {detail?.currentStep ?? "gate"}</h2>
        <div className={styles.hint}>{detail?.title}</div>
        <div className={styles.section}>
          <div className={styles.label}>report excerpt</div>
          <div className={styles.excerpt}>{reportExcerpt || "no step outputs yet"}</div>
        </div>
        <div className={styles.section}>
          <div className={styles.label}>findings ({findings.length})</div>
          <div className={styles.excerpt}>
            {findings.length === 0 ? (
              "none"
            ) : (
              findings.slice(0, 12).map((finding: FindingView) => (
                <div key={finding.id}>
                  [{finding.severity}] {finding.body}
                </div>
              ))
            )}
          </div>
        </div>
        <GateActions featureId={featureId} showChangeNoteInline={true} />
        <Link href={`/feature/${featureId}`} className={styles.close} onClick={onClose}>
          open full view
        </Link>
      </div>
    </div>
  )
}
