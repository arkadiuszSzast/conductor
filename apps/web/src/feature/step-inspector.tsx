/**
 * Step inspector — run selection, outputs and logs for the job/step
 * selected on the graph. Feature-wide history (findings, timeline) lives
 * in `FeatureActivity` on the page itself, not per step. `jobId` null
 * means nothing is selected on the graph yet.
 */

import { useApp } from "../app-context.ts"
import type { RunLogLine, RunSummary, WorkflowProjection } from "../api/types.ts"
import { collapseToolLines, type DisplayLogLine } from "./inspector-logic.ts"
import { useRunLog, useStepRun } from "./use-step-run.ts"
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

type Tab = "logs" | "outputs"

/** The "job · step" label shown as the inspector's title, or by a caller
 *  that renders its own header (e.g. the mobile ActionSheet) instead. */
export function inspectorTitle(jobId: string | null, effectiveStepId: string | null): string {
  if (jobId === null) return "feature workspace"
  return effectiveStepId !== null ? `${jobId} · ${effectiveStepId}` : jobId
}

export function StepInspector({ featureId, jobId, stepId, workflow, onClose, inline, hideHeader }: StepInspectorProps): React.ReactNode {
  const { effectiveStepId, step, run, runId } = useStepRun(featureId, jobId, stepId, workflow)
  const { cursor } = useRunLog(featureId, runId)

  // Logs first: "what is the agent doing" is the question a live step
  // answers; outputs only exist once it has reported.
  const [tab, setTab] = useState<Tab>("logs")

  const hasStep = jobId !== null && effectiveStepId !== null
  const activeTab = tab

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
          aria-pressed={activeTab === "logs"}
          className={`${styles.tab} ${activeTab === "logs" ? styles.active : ""}`}
          onClick={() => setTab("logs")}
          disabled={!hasStep}
        >
          logs
        </button>
        <button
          aria-pressed={activeTab === "outputs"}
          className={`${styles.tab} ${activeTab === "outputs" ? styles.active : ""}`}
          onClick={() => setTab("outputs")}
          disabled={!hasStep}
        >
          outputs
        </button>
        {run !== null ? <span className={`${styles.runStatus} ${styles[`run_${run.status}`] ?? ""}`}>{run.status}</span> : null}
      </div>
      <div className={styles.body}>
        {!hasStep ? <div className={styles.empty}>select a job or step on the graph to inspect it</div> : null}
        {activeTab === "outputs" && hasStep ? <OutputsTab step={step} run={run} runId={runId} /> : null}
        {activeTab === "logs" && hasStep ? (
          <LogsTab cursor={cursor} runId={runId} live={run?.status === "running"} kind={stepKind(workflow, jobId, effectiveStepId)} />
        ) : null}
      </div>
    </div>
  )
}

function stepKind(workflow: WorkflowProjection | null, jobId: string | null, stepId: string | null): string | null {
  if (workflow === null || jobId === null || stepId === null) return null
  return workflow.jobs[jobId]?.steps.find(step => step.id === stepId)?.kind ?? null
}

type FullOutputsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly outputs: Record<string, string> }
  | { readonly status: "error"; readonly message: string }

function OutputsTab(props: {
  readonly step: { readonly outputs: Readonly<Record<string, string>>; readonly truncated?: boolean; readonly runId?: string } | undefined
  readonly run: UncertainRunView | null
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
      {run?.status === "uncertain" ? <UncertainRun run={run} /> : null}
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

function LogsTab({
  cursor,
  runId,
  live,
  kind,
}: {
  readonly cursor: { readonly lines: readonly RunLogLine[] }
  readonly runId: string | null
  readonly live: boolean
  readonly kind: string | null
}): React.ReactNode {
  // Follow the tail while the operator is at the bottom; scrolling up to
  // read earlier lines pauses following until they return to the end.
  const panelRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  useEffect(() => {
    const panel = panelRef.current
    if (panel !== null && pinnedRef.current) panel.scrollTop = panel.scrollHeight
  }, [cursor.lines.length])
  if (runId === null) return <div className={styles.empty}>no run for this step yet</div>
  if (cursor.lines.length === 0) {
    const waiting =
      kind === "command" ? "command running — its output is captured when it finishes" : kind === "agent" ? "waiting for the agent's first output…" : "running — no log lines yet"
    return <div className={styles.empty}>{live ? waiting : "no log lines for this run"}</div>
  }
  const display = collapseToolLines(cursor.lines)
  return (
    <div
      ref={panelRef}
      className={`${styles.panel} ${styles.logPanel}`}
      onScroll={event => {
        const el = event.currentTarget
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
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

const CLASSIFICATION_TEXT: Record<"no_effect" | "replay_safe", string> = {
  no_effect: "no session was created and no prompt was sent, and the process is confirmed terminated",
  replay_safe: "the step is declared replay-safe and the process is confirmed terminated",
}

type UncertainRunView = Pick<RunSummary, "status" | "reason" | "uncertain" | "healed">

function UncertainRun({ run }: { readonly run: UncertainRunView }): React.ReactNode {
  if (run.healed !== undefined) {
    return (
      <div className={styles.healed}>
        <strong>Execution uncertain — healed automatically.</strong>
        <p>{run.reason ?? "outcome unknown"}</p>
        <p>Safe to replay: {CLASSIFICATION_TEXT[run.healed.classification]}. A fresh attempt was scheduled.</p>
      </div>
    )
  }
  const classification = run.uncertain?.classification ?? null
  if (classification === "no_effect" || classification === "replay_safe") {
    return (
      <div className={styles.healed}>
        <strong>Execution uncertain — healing scheduled.</strong>
        <p>{run.reason ?? run.uncertain?.reasonCode}</p>
        <p>Safe to replay: {CLASSIFICATION_TEXT[classification]}. A fresh attempt runs after backoff; no action needed.</p>
      </div>
    )
  }
  return (
    <div className={styles.error}>
      <strong>{classification === null ? "Execution uncertain — classifying…" : "Execution uncertain — not confirmed failed or succeeded."}</strong>
      <p>{run.reason ?? run.uncertain?.reasonCode}</p>
      <p>Do not resend the previous operation. Recovery requires operator notes, current version, an idempotency key and explicit uncertainty acknowledgment.</p>
      <p>Process cleanup: {run.uncertain?.cleanupState ?? "unconfirmed"}. Unconfirmed cleanup must be independently verified before attesting it.</p>
    </div>
  )
}
