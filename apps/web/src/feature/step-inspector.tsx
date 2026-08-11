import { useCallback, useEffect, useRef, useState } from "react"
import { useApp } from "../app-context.ts"
import { useFeatureDetail, useRunLogInvalidations, useRuns } from "../api/hooks.ts"
import { type LogCursor, applyLogPage, EMPTY_LOG_CURSOR } from "./inspector-logic.ts"
import { formatClock } from "../lib/time.ts"
import styles from "./step-inspector.module.css"

export interface StepInspectorProps {
  readonly featureId: string
  readonly jobId: string
  readonly stepId: string | null
  readonly onClose?: () => void
  readonly inline?: boolean
}

type Tab = "outputs" | "logs"

export function StepInspector({ featureId, jobId, stepId, onClose, inline }: StepInspectorProps): React.ReactNode {
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const runsState = useRuns(store, featureId)
  const feature = detailState.data?.feature

  const effectiveStepId = stepId ?? feature?.jobs[jobId]?.currentStep ?? null
  const step = effectiveStepId !== null ? feature?.jobs[jobId]?.steps[effectiveStepId] : undefined

  const runs = runsState.data ?? []
  const run = effectiveStepId !== null
    ? runs.find(r => r.jobId === jobId && r.stepId === effectiveStepId)
    : null
  const runId = run?.id ?? step?.runId ?? null

  const [tab, setTab] = useState<Tab>("outputs")
  const [cursor, setCursor] = useState<LogCursor>(EMPTY_LOG_CURSOR)
  const [fullOutputs, setFullOutputs] = useState<Record<string, string> | null>(null)
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  useEffect(() => {
    setCursor(EMPTY_LOG_CURSOR)
    setFullOutputs(null)
  }, [runId])

  const refresh = useCallback(async () => {
    if (runId === null) return
    try {
      const page = await store.client.runLogs(runId, cursorRef.current.nextSeq)
      setCursor(prev => applyLogPage(prev, page))
    } catch {
      // 404 when run unknown / pruned — inspector sits idle
    }
  }, [runId, store.client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useRunLogInvalidations(store, featureId, refresh)

  return (
    <div className={`${styles.inspector} ${inline ? styles.inline : ""}`}>
      <div className={styles.head}>
        <span className={styles.title}>
          {jobId}
          {effectiveStepId !== null ? ` · ${effectiveStepId}` : ""}
        </span>
        <div className={styles.tabs}>
          <button className={`${styles.tab} ${tab === "outputs" ? styles.active : ""}`} onClick={() => setTab("outputs")}>
            outputs
          </button>
          <button className={`${styles.tab} ${tab === "logs" ? styles.active : ""}`} onClick={() => setTab("logs")}>
            logs
          </button>
        </div>
        {onClose !== undefined ? (
          <button className={styles.close} onClick={onClose}>
            ✕
          </button>
        ) : null}
      </div>
      {tab === "outputs" ? <OutputsTab step={step} runId={runId} full={fullOutputs} onFetchFull={setFullOutputs} /> : null}
      {tab === "logs" ? <LogsTab cursor={cursor} runId={runId} /> : null}
    </div>
  )
}

function OutputsTab(props: {
  readonly step: { readonly outputs: Readonly<Record<string, string>>; readonly truncated?: boolean; readonly runId?: string } | undefined
  readonly runId: string | null
  readonly full: Record<string, string> | null
  readonly onFetchFull: (v: Record<string, string> | null) => void
}): React.ReactNode {
  const { client } = useApp()
  const { step, runId, full, onFetchFull } = props
  const candidates = full ?? step?.outputs ?? {}
  const entries = Object.entries(candidates)
  const truncated = step?.truncated === true && full === null
  const fetchFull = async (): Promise<void> => {
    if (runId === null) return
    try {
      const run = await client.fullRun(runId)
      onFetchFull(run.outputs as Record<string, string>)
    } catch {
      onFetchFull({})
    }
  }
  return (
    <div className={styles.outputs}>
      {entries.length === 0 ? <div className={styles.empty}>no outputs reported for this step</div> : null}
      {entries.map(([name, value]) => (
        <div key={name} className={styles.row}>
          <span className={styles.name}>{name}</span>
          <span className={styles.val}>{truncated ? value + " …" : value}</span>
        </div>
      ))}
      {truncated && runId !== null ? (
        <button className={styles.fetchFull} onClick={fetchFull}>
          fetch full output →
        </button>
      ) : null}
    </div>
  )
}

function LogsTab({ cursor, runId }: { readonly cursor: LogCursor; readonly runId: string | null }): React.ReactNode {
  if (runId === null) return <div className={styles.empty}>no run for this step yet</div>
  if (cursor.lines.length === 0) return <div className={styles.empty}>no log lines yet</div>
  return (
    <div className={styles.panel}>
      {cursor.lines.map(line => (
        <div key={line.seq} className={styles.line}>
          <span className={styles.src}>{line.source}</span>
          <span className={styles.time}>{formatClock(line.time)}</span>
          <span className={styles.text}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}
