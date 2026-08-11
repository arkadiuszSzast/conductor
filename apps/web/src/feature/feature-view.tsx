import { useEffect, useState } from "react"
import { Link, useParams } from "wouter"
import { useApp } from "../app-context.ts"
import { useCommand, useFeatureDetail, useFindings, useTimeline, useWorkflow } from "../api/hooks.ts"
import { WorkflowGraph } from "../graph/workflow-graph.tsx"
import { StepInspector } from "./step-inspector.tsx"
import { GateModal } from "./gate-modal.tsx"
import { projectBasename } from "../graph/merge.ts"
import { formatAge, formatClock } from "../lib/time.ts"
import { mapGateError } from "../gate/gate-logic.ts"
import { pushToast } from "../ui/toast-store.ts"
import type { FindingView, RunSummary, TransitionEntry } from "../api/types.ts"
import styles from "./feature-view.module.css"

const STATUS_PILL: Record<string, string> = {
  waiting_human: "⚠ WAITING HUMAN",
  running: "● running",
  escalated: "✖ escalated",
  paused: "❚❚ paused",
  done: "✓ done",
  abandoned: "✕ abandoned",
}

export function FeatureView(): React.ReactNode {
  const { id } = useParams<{ id: string }>()
  const featureId = id ?? ""
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const projectDir = detailState.data?.feature.projectDir ?? ""
  const workflowState = useWorkflow(store, projectDir)
  const findingsState = useFindings(store, featureId)
  const timelineState = useTimeline(store, featureId)
  const runCommand = useCommand(store)
  const [inspector, setInspector] = useState<{ jobId: string; stepId: string | null } | null>(null)
  const [gateOpen, setGateOpen] = useState(false)
  const [pendingLifecycle, setPendingLifecycle] = useState<string | null>(null)

  useEffect(() => {
    store.setActiveFeature(featureId)
  }, [store, featureId])

  const detail = detailState.data
  const feature = detail?.feature
  if (detail === null || detail === undefined || feature === undefined) {
    if (detailState.error !== null) {
      return <div className={styles.loading}>feature gone: {detailState.error.message}</div>
    }
    return <div className={styles.loading}>loading feature…</div>
  }

  const lifecycle = async (action: "pause" | "resume" | "abandon"): Promise<void> => {
    setPendingLifecycle(action)
    try {
      await runCommand(featureId, client =>
        action === "pause"
          ? client.pause(featureId)
          : action === "resume"
            ? client.resume(featureId)
            : client.abandon(featureId),
      )
    } catch (err) {
      const handled = mapGateError(err)
      if (handled.toast !== "") pushToast(handled.toast)
      if (handled.refetch) store.refetchFeatureDetail(featureId)
    } finally {
      setPendingLifecycle(null)
    }
  }

  const pillClass = `${styles.statusPill} ${styles[feature.status]}`
  const workflowRes = workflowState.data

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Link href="/" className={styles.back}>← board</Link>
        <span className={styles.title}>{feature.title}</span>
        <span className={pillClass}>{STATUS_PILL[feature.status] ?? feature.status}</span>
        <span className={styles.meta}>
          {projectBasename(feature.projectDir)} · {feature.workflow ?? "default"}
          {feature.pr !== null ? ` · pr #${feature.pr}` : ""}
          {feature.branch !== null ? ` · ${feature.branch}` : ""} · {formatAge(Date.now(), feature.updatedAt)}
        </span>
        <div className={styles.actions}>
          {feature.status === "waiting_human" ? (
            <button className="primary" onClick={() => setGateOpen(true)}>
              review gate
            </button>
          ) : null}
          {feature.status === "running" || feature.status === "escalated" ? (
            <button disabled={pendingLifecycle !== null} onClick={() => lifecycle("pause")}>
              {pendingLifecycle === "pause" ? "…" : "pause"}
            </button>
          ) : null}
          {feature.status === "paused" ? (
            <button className="primary" disabled={pendingLifecycle !== null} onClick={() => lifecycle("resume")}>
              {pendingLifecycle === "resume" ? "…" : "resume"}
            </button>
          ) : null}
          {feature.status !== "done" && feature.status !== "abandoned" ? (
            <button className="danger" disabled={pendingLifecycle !== null} onClick={() => lifecycle("abandon")}>
              {pendingLifecycle === "abandon" ? "…" : "abandon"}
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.grid}>
        <div className={styles.graphCol}>
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
                detail={detail.feature}
                selectedJobId={inspector?.jobId}
                onNodeClick={(jobId, stepId) => setInspector({ jobId, stepId })}
              />
            </>
          )}
          {detail.activeRun !== null ? <ActiveRunStrip run={detail.activeRun} /> : null}
        </div>
        <aside className={styles.side}>
          {inspector !== null ? (
            <StepInspector
              featureId={featureId}
              jobId={inspector.jobId}
              stepId={inspector.stepId}
              onClose={() => setInspector(null)}
            />
          ) : (
            <div className={styles.empty}>select a node to inspect its outputs and logs</div>
          )}
        </aside>
      </div>
      <div className={styles.lower}>
        <FindingsList findings={findingsState.data ?? undefined} />
        <Timeline entries={timelineState.data ?? undefined} />
      </div>
      {gateOpen ? <GateModal featureId={featureId} onClose={() => setGateOpen(false)} /> : null}
    </div>
  )
}

function ActiveRunStrip({ run }: { readonly run: RunSummary }): React.ReactNode {
  return (
    <div className={styles.activeRun}>
      ACTIVE RUN — session {run.sessionId ?? "—"} · nudges {run.nudges} · {formatAge(Date.now(), run.timeStarted)} · {run.status}
      {run.reason !== null ? ` · ${run.reason}` : ""}
    </div>
  )
}

function FindingsList({ findings }: { readonly findings: FindingView[] | undefined }): React.ReactNode {
  return (
    <div className={styles.findings}>
      <h3>findings</h3>
      {findings === undefined ? (
        <div className={styles.empty}>loading…</div>
      ) : findings.length === 0 ? (
        <div className={styles.empty}>none</div>
      ) : (
        findings.map(finding => (
          <div key={finding.id} className={styles.finding}>
            <span className={`${styles.sev} ${styles[severityClass(finding.severity)]}`}>
              {finding.severity}
            </span>
            <span className={styles.fstatus}>{finding.status}</span>
            <span className={styles.fbody}>{finding.body}</span>
          </div>
        ))
      )}
    </div>
  )
}

function severityClass(severity: string): string {
  const v = severity.toLowerCase()
  if (v === "high" || v === "critical") return "high"
  if (v === "medium") return "medium"
  return "low"
}

function Timeline({ entries }: { readonly entries: TransitionEntry[] | undefined }): React.ReactNode {
  return (
    <div className={styles.timeline}>
      <h3>timeline</h3>
      {entries === undefined ? (
        <div className={styles.empty}>loading…</div>
      ) : entries.length === 0 ? (
        <div className={styles.empty}>none</div>
      ) : (
        entries.map((entry, i) => (
          <div key={i} className={styles.tlEntry}>
            <span className={styles.tlTime}>{formatClock(entry.time)}</span>
            {entry.event.kind}
          </div>
        ))
      )}
    </div>
  )
}
