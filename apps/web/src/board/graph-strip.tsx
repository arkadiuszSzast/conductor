import { useEffect, useState } from "react"
import { useApp } from "../app-context.ts"
import { useFeatureDetail, useWorkflow } from "../api/hooks.ts"
import { WorkflowGraph } from "../graph/workflow-graph.tsx"
import { StepInspector } from "../feature/step-inspector.tsx"
import { GateActions } from "../gate/gate-actions.tsx"
import { Link } from "wouter"
import styles from "./graph-strip.module.css"

export interface GraphStripProps {
  readonly featureId: string
  readonly onClose: () => void
}

export function GraphStrip({ featureId, onClose }: GraphStripProps): React.ReactNode {
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const feature = detailState.data?.feature
  const projectDir = feature?.projectDir ?? ""
  const workflowState = useWorkflow(store, projectDir)

  const [inspector, setInspector] = useState<{ jobId: string; stepId: string | null } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    globalThis.addEventListener("keydown", onKey)
    return () => globalThis.removeEventListener("keydown", onKey)
  }, [onClose])

  const detail = detailState.data
  if (feature === undefined || detail === null || detail === undefined) {
    return <div className={styles.strip}><div className={styles.legend}>loading feature…</div></div>
  }
  const workflowRes = workflowState.data

  return (
    <div className={styles.strip}>
      <div className={styles.head}>
        <span className={styles.legend}>
          legend: ✓ done · ● running · ◐ waiting/gate · ○ pending · ⤼ skipped · ⟲ rerun · ⚑ findings
        </span>
        <button className={styles.close} onClick={onClose} title="Collapse the strip (Esc)">
          ✕ close
        </button>
      </div>
      <div className={styles.body}>
        {workflowRes === null ? (
          <div className={styles.diagCard}>loading workflow…</div>
        ) : !workflowRes.ok ? (
          <div className={styles.diagCard}>
            {workflowRes.state === "unregistered" ? "no workflow registered" : `workflow invalid: ${workflowRes.message}`}
          </div>
        ) : (
          <>
            {feature.workflowRef?.stale || workflowRes.workflow.stale ? (
              <div className={styles.stale}>⚠ workflow changed since this feature started</div>
            ) : null}
            <WorkflowGraph
              workflow={workflowRes.workflow}
              detail={feature}
              onNodeClick={(jobId, stepId) => setInspector({ jobId, stepId })}
            />
          </>
        )}
        <div className={styles.decisionRow}>
          <GateActions featureId={featureId} />
          <Link href={`/feature/${featureId}`} className={styles.linkBtn}>
            open full view →
          </Link>
        </div>
      </div>
      {inspector !== null ? (
        <StepInspector
          featureId={featureId}
          jobId={inspector.jobId}
          stepId={inspector.stepId}
          onClose={() => setInspector(null)}
          inline
        />
      ) : null}
    </div>
  )
}
