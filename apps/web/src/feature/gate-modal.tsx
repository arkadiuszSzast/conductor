import { useState } from "react"
import { Link } from "wouter"
import { useApp } from "../app-context.ts"
import { useFeatureDetail, useFindings } from "../api/hooks.ts"
import { GateActionButtons, GateQuestionBody, SurfaceNavigator } from "../gate/gate-actions.tsx"
import { useGateActions } from "../gate/use-gate-actions.ts"
import { ActionSheet } from "../ui/action-sheet.tsx"
import { pushToast } from "../ui/toast-store.ts"
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
  const [pending, setPending] = useState(false)

  const gate = useGateActions({
    featureId,
    onPendingChange: setPending,
    // Close only once nothing is left to review — a feature with several
    // concurrent gates/questions keeps the sheet open (on whatever
    // surface remains) after resolving one of them.
    onSuccess: (message, remaining) => {
      pushToast(message, "info")
      if (remaining === 0) onClose()
    },
  })

  const reportExcerpt = detail?.jobs
    ? Object.values(detail.jobs)
        .flatMap(job => Object.values(job.steps))
        .filter(step => step.status === "succeeded" || step.status === "failed")
        .flatMap(step => Object.values(step.outputs))
        .join("\n\n")
    : ""

  return (
    <ActionSheet
      title={`review gate — ${detail?.currentStep ?? "gate"}`}
      context={detail?.title}
      onClose={onClose}
      closeDisabled={pending}
      actions={gate.waiting ? <GateActionButtons gate={gate} /> : undefined}
    >
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
      {gate.waiting ? <SurfaceNavigator gate={gate} /> : null}
      {gate.waiting ? <GateQuestionBody gate={gate} /> : null}
      {gate.inlineError !== null ? <div className={styles.inlineError} role="alert">{gate.inlineError}</div> : null}
      <Link href={`/feature/${featureId}`} className={styles.close} onClick={onClose}>
        open full view →
      </Link>
    </ActionSheet>
  )
}
