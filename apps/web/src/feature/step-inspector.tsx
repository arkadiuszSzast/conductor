/**
 * Workspace inspector — the one place that owns run selection, outputs,
 * logs, findings, and timeline for the feature workspace (spec: "Step
 * inspector integrates outputs, logs, findings, and history"). `jobId`
 * null means nothing is selected on the graph yet; findings/timeline stay
 * available regardless since they are feature-scoped, not job-scoped.
 */

import { useApp } from "../app-context.ts"
import { useFindings, useTimeline } from "../api/hooks.ts"
import type { RunLogLine, WorkflowProjection } from "../api/types.ts"
import { collapseToolLines, type DisplayLogLine } from "./inspector-logic.ts"
import { useRunLog, useStepRun } from "./use-step-run.ts"
import { FindingsPanel } from "./findings-panel.tsx"
import { TimelinePanel } from "./timeline-panel.tsx"
import { formatClock } from "../lib/time.ts"
import { useEffect, useRef, useState } from "react"
import { LatestGuard } from "../lib/latest-guard.ts"
import styles from "./step-inspector.module.css"

export interface StepInspectorProps {
  readonly featureId: string
  readonly jobId: string | null
  readonly stepId: string | null
  readonly workflow: WorkflowProjection | null
  readonly onClose?: () => void
  readonly inline?: boolean
  /** Suppresses the internal title/close header — used when a container
   *  (e.g. `ActionSheet` on mobile) already renders its own title/close
   *  chrome for this content, so the operator never sees two headers. */
  readonly hideHeader?: boolean
}

type Tab = "outputs" | "logs" | "findings" | "timeline"

/** The "job · step" label shown as the inspector's title, or by a caller
 *  that renders its own header (e.g. the mobile ActionSheet) instead. */
export function inspectorTitle(jobId: string | null, effectiveStepId: string | null): string {
  if (jobId === null) return "feature workspace"
  return effectiveStepId !== null ? `${jobId} · ${effectiveStepId}` : jobId
}

export function StepInspector({ featureId, jobId, stepId, workflow, onClose, inline, hideHeader }: StepInspectorProps): React.ReactNode {
  const { store } = useApp()
  const findingsState = useFindings(store, featureId)
  const timelineState = useTimeline(store, featureId)
  const { effectiveStepId, step, run, runId } = useStepRun(featureId, jobId, stepId, workflow)
  const { cursor } = useRunLog(featureId, runId)

  const [tab, setTab] = useState<Tab>("outputs")

  const hasStep = jobId !== null && effectiveStepId !== null
  const activeTab = tab === "outputs" || tab === "logs" ? (hasStep ? tab : "findings") : tab

  return (
    <div className={`${styles.inspector} ${inline ? styles.inline : ""}`}>
      {hideHeader !== true ? (
        <div className={styles.head}>
          <span className={styles.title}>{inspectorTitle(jobId, effectiveStepId)}</span>
          {onClose !== undefined ? (
            <button className={styles.close} onClick={onClose} aria-label="Close inspector">
              ✕
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={styles.tabs} role="group" aria-label="Inspector panel">
        <button
          aria-pressed={activeTab === "outputs"}
          className={`${styles.tab} ${activeTab === "outputs" ? styles.active : ""}`}
          onClick={() => setTab("outputs")}
          disabled={!hasStep}
        >
          outputs
        </button>
        <button
          aria-pressed={activeTab === "logs"}
          className={`${styles.tab} ${activeTab === "logs" ? styles.active : ""}`}
          onClick={() => setTab("logs")}
          disabled={!hasStep}
        >
          logs
        </button>
        <button
          aria-pressed={activeTab === "findings"}
          className={`${styles.tab} ${activeTab === "findings" ? styles.active : ""}`}
          onClick={() => setTab("findings")}
        >
          findings
        </button>
        <button
          aria-pressed={activeTab === "timeline"}
          className={`${styles.tab} ${activeTab === "timeline" ? styles.active : ""}`}
          onClick={() => setTab("timeline")}
        >
          timeline
        </button>
      </div>
      <div className={styles.body}>
        {!hasStep && (activeTab === "outputs" || activeTab === "logs") ? (
          <div className={styles.empty}>select a job or step on the graph to inspect it</div>
        ) : null}
        {activeTab === "outputs" && hasStep ? <OutputsTab step={step} run={run} runId={runId} /> : null}
        {activeTab === "logs" && hasStep ? <LogsTab cursor={cursor} runId={runId} /> : null}
        {activeTab === "findings" ? <FindingsPanel findings={findingsState.data ?? undefined} /> : null}
        {activeTab === "timeline" ? <TimelinePanel entries={timelineState.data ?? undefined} /> : null}
      </div>
    </div>
  )
}

type FullOutputsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly outputs: Record<string, string> }
  | { readonly status: "error"; readonly message: string }

function OutputsTab(props: {
  readonly step: { readonly outputs: Readonly<Record<string, string>>; readonly truncated?: boolean; readonly runId?: string } | undefined
  readonly run: { readonly status: string; readonly reason: string | null } | null
  readonly runId: string | null
}): React.ReactNode {
  const { client } = useApp()
  const { step, run, runId } = props

  // Keyed by runId, not by step/selection: switching to a different job's
  // step must not show the previous step's full-output fetch (or its
  // error), and a stale response for a superseded runId is discarded
  // instead of overwriting a newer selection's state.
  const [full, setFull] = useState<FullOutputsState>({ status: "idle" })
  const guard = useRef(new LatestGuard())

  useEffect(() => {
    guard.current.invalidate()
    setFull({ status: "idle" })
  }, [runId])

  const fetchFull = async (): Promise<void> => {
    if (runId === null) return
    const ticket = guard.current.begin()
    setFull({ status: "loading" })
    try {
      const fullRun = await client.fullRun(runId)
      if (!guard.current.isCurrent(ticket)) return
      setFull({ status: "ready", outputs: fullRun.outputs as Record<string, string> })
    } catch (err) {
      if (!guard.current.isCurrent(ticket)) return
      setFull({ status: "error", message: err instanceof Error ? err.message : "failed to load full output" })
    }
  }

  const candidates = full.status === "ready" ? full.outputs : step?.outputs ?? {}
  const entries = Object.entries(candidates)
  const truncated = step?.truncated === true && full.status !== "ready"

  return (
    <div className={styles.outputs}>
      {run !== null && (run.status === "failed" || run.status === "reaped") && run.reason !== null ? (
        <div className={styles.error}>
          <strong>{run.status}</strong> — {run.reason}
        </div>
      ) : null}
      {entries.length === 0 ? <div className={styles.empty}>no outputs reported for this step</div> : null}
      {entries.map(([name, value]) => (
        <div key={name} className={styles.row}>
          <span className={styles.name}>{name}</span>
          <span className={styles.val}>{truncated ? value + " …" : value}</span>
        </div>
      ))}
      {full.status === "error" ? (
        <div className={styles.error}>
          could not load full output — {full.message}
        </div>
      ) : null}
      {truncated && runId !== null ? (
        <button className={styles.fetchFull} onClick={() => void fetchFull()} disabled={full.status === "loading"}>
          {full.status === "loading" ? "loading…" : full.status === "error" ? "retry fetch full output →" : "fetch full output →"}
        </button>
      ) : null}
    </div>
  )
}

function LogsTab({ cursor, runId }: { readonly cursor: { readonly lines: readonly RunLogLine[] }; readonly runId: string | null }): React.ReactNode {
  if (runId === null) return <div className={styles.empty}>no run for this step yet</div>
  if (cursor.lines.length === 0) return <div className={styles.empty}>no log lines yet</div>
  const display = collapseToolLines(cursor.lines)
  return (
    <div className={styles.panel}>
      {display.map(entry =>
        entry.kind === "line" ? (
          <div key={entry.line.seq} className={styles.line}>
            <span className={styles.src}>{entry.line.source}</span>
            <span className={styles.time}>{formatClock(entry.line.time)}</span>
            <span className={styles.text}>{entry.line.text}</span>
          </div>
        ) : (
          <ToolStatusRow key={`tools-${entry.latest.seq}`} group={entry} />
        ),
      )}
    </div>
  )
}

/**
 * A collapsed run of tool invocations: one dimmed status row showing the
 * latest tool line (OpenChamber-style "what is it doing"), with a count
 * badge that expands the earlier invocations on demand.
 */
function ToolStatusRow({ group }: { readonly group: Extract<DisplayLogLine, { kind: "tools" }> }): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      {expanded
        ? group.earlier.map(line => (
            <div key={line.seq} className={`${styles.line} ${styles.toolLine}`}>
              <span className={styles.src}>⚙</span>
              <span className={styles.time}>{formatClock(line.time)}</span>
              <span className={styles.text}>{line.text}</span>
            </div>
          ))
        : null}
      <div className={`${styles.line} ${styles.toolLine}`}>
        <span className={styles.src}>⚙</span>
        <span className={styles.time}>{formatClock(group.latest.time)}</span>
        <span className={styles.text}>
          {group.latest.text}
          {group.count > 1 ? (
            <button className={styles.toolCount} onClick={() => setExpanded(value => !value)}>
              {expanded ? "collapse" : `+${group.count - 1} more`}
            </button>
          ) : null}
        </span>
      </div>
    </>
  )
}
