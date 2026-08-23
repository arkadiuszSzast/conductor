import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "wouter"
import { useApp } from "../app-context.ts"
import { useCommand, useFeatureDetail, useWorkflow } from "../api/hooks.ts"
import { WorkflowGraph } from "../graph/workflow-graph.tsx"
import { inspectorTitle, StepInspector } from "./step-inspector.tsx"
import { GateModal } from "./gate-modal.tsx"
import { RecoverySheet } from "./recovery-sheet.tsx"
import { ConfirmSheet } from "../ui/confirm-sheet.tsx"
import { ActionSheet } from "../ui/action-sheet.tsx"
import { projectBasename, workflowCompatible } from "../graph/merge.ts"
import { resolveInspectorStepId } from "./inspector-logic.ts"
import { formatAge, formatClock } from "../lib/time.ts"
import { mapGateError } from "../gate/gate-logic.ts"
import { pushToast } from "../ui/toast-store.ts"
import { useIsNarrowViewport } from "../lib/viewport.ts"
import { publishActiveScope } from "../plugins/active-scope.ts"
import type { RunSummary } from "../api/types.ts"
import styles from "./feature-view.module.css"

const STATUS_PILL: Record<string, string> = {
  waiting_human: "⚠ WAITING HUMAN",
  running: "● running",
  escalated: "✖ escalated",
  paused: "❚❚ paused",
  done: "✓ done",
  abandoned: "✕ abandoned",
}

interface Inspection {
  readonly jobId: string
  readonly stepId: string | null
}

export function FeatureView(): React.ReactNode {
  const { id } = useParams<{ id: string }>()
  const featureId = id ?? ""
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const projectDir = detailState.data?.feature.projectDir ?? ""
  const workflowState = useWorkflow(store, projectDir)
  const runCommand = useCommand(store)
  const [params, setParams] = useSearchParams()
  const isNarrow = useIsNarrowViewport()

  const [inspector, setInspector] = useState<Inspection | null>(null)
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)
  const [gateOpen, setGateOpen] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [abandonOpen, setAbandonOpen] = useState(false)
  const [pendingLifecycle, setPendingLifecycle] = useState<string | null>(null)

  useEffect(() => {
    store.setActiveFeature(featureId)
  }, [store, featureId])

  useEffect(() => {
    publishActiveScope({ project: projectDir === "" ? null : projectDir, feature: featureId === "" ? null : featureId })
    return () => publishActiveScope({ project: null, feature: null })
  }, [projectDir, featureId])

  // Consumes the `open=gate|recover` deep-link param once it has been
  // acted on: leaving it in the URL would reopen the sheet on every
  // remount/refresh (or after the operator closes it and navigates back
  // via history). `job=` is a durable graph selection, not a one-shot
  // trigger, so it is left in place — only `open` is stripped.
  const consumeOpenParam = (): void => {
    if (params.get("open") === null) return
    setParams(
      prev => {
        const next = new URLSearchParams(prev)
        next.delete("open")
        return next
      },
      { replace: true },
    )
  }

  // Deep-link support from board cards: ?job=<id> pre-selects the job on
  // the graph, ?open=gate|recover opens the matching sheet immediately so
  // the primary review/recover action is reachable directly from a card.
  useEffect(() => {
    const jobId = params.get("job")
    if (jobId !== null) setInspector({ jobId, stepId: null })
    const open = params.get("open")
    if (open === "gate") setGateOpen(true)
    if (open === "recover") setRecoveryOpen(true)
    // Only consume the deep link once per feature mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId])

  const detail = detailState.data
  const feature = detail?.feature
  if (detail === null || detail === undefined || feature === undefined) {
    if (detailState.error !== null) {
      return <div className={styles.loading}>feature gone: {detailState.error.message}</div>
    }
    return <div className={styles.loading}>loading feature…</div>
  }

  const lifecycle = async (action: "pause" | "resume"): Promise<void> => {
    setPendingLifecycle(action)
    try {
      await runCommand(featureId, client => (action === "pause" ? client.pause(featureId) : client.resume(featureId)))
    } catch (err) {
      const handled = mapGateError(err)
      if (handled.toast !== "") pushToast(handled.toast)
      if (handled.refetch) store.refetchFeatureDetail(featureId)
    } finally {
      setPendingLifecycle(null)
    }
  }

  const abandon = async (): Promise<void> => {
    try {
      await runCommand(featureId, client => client.abandon(featureId))
    } catch (err) {
      const handled = mapGateError(err)
      if (handled.refetch) store.refetchFeatureDetail(featureId)
      throw new Error(handled.toast !== "" ? handled.toast : "abandon failed")
    }
  }

  const pillClass = `${styles.statusPill} ${styles[feature.status]}`
  const activity = feature.activity ?? {
    state: feature.status === "running" ? ("active" as const) : feature.status === "done" || feature.status === "abandoned" ? ("terminal" as const) : feature.status,
    activeCount: detail.activeRun === null ? 0 : 1,
    targets: [],
    target: null,
    reason: null,
    diagnostic: null,
    nextAt: null,
    deadlineAt: null,
    message: detail.activeRun === null ? `Feature is ${feature.status}.` : "1 active run.",
  }
  const workflowRes = workflowState.data
  // The endpoint serves one projection per project — the currently
  // registered workflow, not one per historical name a feature's runtime
  // may carry. A mismatch means this feature's `jobs`/`steps` belong to a
  // workflow that no longer exists under that name: merging them against
  // the current structure (job ids, step kinds) would be silently wrong,
  // not merely stale, so the graph and inspector never see it.
  const compatible = workflowRes?.ok === true && workflowCompatible(feature.workflow, workflowRes.workflow.name)
  const compatibleWorkflow = compatible ? workflowRes.workflow : null

  const selectNode = (jobId: string, stepId: string | null): void => {
    setInspector({ jobId, stepId })
    if (isNarrow) setMobileInspectorOpen(true)
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Link href="/" className={styles.back}>
          ← board
        </Link>
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
          {feature.status === "running" ? (
            <button disabled={pendingLifecycle !== null} onClick={() => lifecycle("pause")}>
              {pendingLifecycle === "pause" ? "…" : "pause"}
            </button>
          ) : null}
          {feature.status === "escalated" ? (
            <button className="danger" disabled={pendingLifecycle !== null} onClick={() => setRecoveryOpen(true)}>
              recover
            </button>
          ) : null}
          {feature.status === "paused" ? (
            <button className="primary" disabled={pendingLifecycle !== null} onClick={() => lifecycle("resume")}>
              {pendingLifecycle === "resume" ? "…" : "resume"}
            </button>
          ) : null}
          {feature.status !== "done" && feature.status !== "abandoned" ? (
            <button className="danger" disabled={pendingLifecycle !== null} onClick={() => setAbandonOpen(true)}>
              abandon
            </button>
          ) : null}
        </div>
      </div>
      <div className={`${styles.activity} ${styles[`activity_${activity.state}`] ?? ""}`}>
        <strong>{activity.activeCount > 0 ? "Agents working" : activity.state.replace("_", " ")}</strong>
        <span>{activity.message}</span>
        {activity.target !== null ? (
          <code>
            {activity.target.jobId}/{activity.target.stepId}
          </code>
        ) : null}
        {activity.reason !== null ? <span>reason: {activity.reason}</span> : null}
        {activity.nextAt !== null ? <span>next check: {formatClock(activity.nextAt)}</span> : null}
      </div>
      <div className={styles.grid}>
        <div className={styles.graphCol}>
          {workflowRes === null ? (
            <div className={styles.diagCard}>loading workflow…</div>
          ) : !workflowRes.ok ? (
            <div className={styles.diagCard}>
              {workflowRes.state === "unregistered" ? "no workflow registered" : `workflow invalid: ${workflowRes.message}`}
            </div>
          ) : compatibleWorkflow === null ? (
            <div className={styles.diagCard}>
              ⚠ this feature started under workflow "{feature.workflow ?? "default"}", but the project is now registered
              under "{workflowRes.workflow.name}" — its graph and history cannot be shown against a different workflow's
              structure.
            </div>
          ) : (
            <>
              {feature.workflowRef?.stale || compatibleWorkflow.stale ? (
                <div className={styles.stale}>⚠ workflow changed since this feature started</div>
              ) : null}
              <WorkflowGraph
                workflow={compatibleWorkflow}
                detail={detail.feature}
                selectedJobId={inspector?.jobId}
                onNodeClick={selectNode}
              />
            </>
          )}
          {detail.activeRun !== null ? <ActiveRunStrip run={detail.activeRun} /> : null}
        </div>
        {!isNarrow ? (
          <aside className={styles.side}>
            <StepInspector
              featureId={featureId}
              jobId={inspector?.jobId ?? null}
              stepId={inspector?.stepId ?? null}
              workflow={compatibleWorkflow}
            />
          </aside>
        ) : null}
      </div>
      {isNarrow && mobileInspectorOpen ? (
        <ActionSheet
          title={inspectorTitle(
            inspector?.jobId ?? null,
            inspector?.jobId !== undefined
              ? resolveInspectorStepId(compatibleWorkflow, feature, inspector.jobId, inspector.stepId)
              : null,
          )}
          onClose={() => setMobileInspectorOpen(false)}
        >
          <StepInspector
            featureId={featureId}
            jobId={inspector?.jobId ?? null}
            stepId={inspector?.stepId ?? null}
            workflow={compatibleWorkflow}
            hideHeader
          />
        </ActionSheet>
      ) : null}
      {gateOpen ? (
        <GateModal
          featureId={featureId}
          onClose={() => {
            setGateOpen(false)
            consumeOpenParam()
          }}
        />
      ) : null}
      {recoveryOpen ? (
        <RecoverySheet
          featureId={featureId}
          onClose={() => {
            setRecoveryOpen(false)
            consumeOpenParam()
          }}
        />
      ) : null}
      {abandonOpen ? (
        <ConfirmSheet
          title="Abandon feature"
          context={feature.title}
          body="This stops the feature permanently. Runs in progress are cancelled and the feature cannot be resumed."
          confirmLabel="abandon"
          onConfirm={abandon}
          onClose={() => setAbandonOpen(false)}
        />
      ) : null}
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
