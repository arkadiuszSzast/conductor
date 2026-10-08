/**
 * Feature-wide history — findings and the transition timeline. Both are
 * scoped to the whole feature, not to any one step, so they live on the
 * page next to the graph instead of inside the step inspector. Collapsed
 * by default on a phone, where the graph and the inspector come first.
 */

import { useState } from "react"
import { useApp } from "../app-context.ts"
import { useFindings, useTimeline } from "../api/hooks.ts"
import { FindingsPanel } from "./findings-panel.tsx"
import { TimelinePanel } from "./timeline-panel.tsx"
import styles from "./feature-history.module.css"

type HistoryTab = "timeline" | "findings"

export function FeatureHistory({
  featureId,
  defaultOpen,
  newFindings,
}: {
  readonly featureId: string
  readonly defaultOpen: boolean
  readonly newFindings: number
}): React.ReactNode {
  const { store } = useApp()
  const [open, setOpen] = useState(defaultOpen)
  const [tab, setTab] = useState<HistoryTab>("timeline")
  return (
    <section className={`${styles.history} ${open ? styles.open : ""}`} aria-label="Feature history">
      <div className={styles.head}>
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> history
        </button>
        {open ? (
          <div className={styles.tabs} role="group" aria-label="History panel">
            <button
              type="button"
              aria-pressed={tab === "timeline"}
              className={`${styles.tab} ${tab === "timeline" ? styles.active : ""}`}
              onClick={() => setTab("timeline")}
            >
              timeline
            </button>
            <button
              type="button"
              aria-pressed={tab === "findings"}
              className={`${styles.tab} ${tab === "findings" ? styles.active : ""}`}
              onClick={() => setTab("findings")}
            >
              findings{newFindings > 0 ? <span className={styles.badge}>{newFindings}</span> : null}
            </button>
          </div>
        ) : newFindings > 0 ? (
          <span className={styles.badge}>⚑ {newFindings} new</span>
        ) : null}
      </div>
      {open ? (
        <div className={styles.body}>
          {tab === "timeline" ? <TimelineBody featureId={featureId} store={store} /> : <FindingsBody featureId={featureId} store={store} />}
        </div>
      ) : null}
    </section>
  )
}

type Store = ReturnType<typeof useApp>["store"]

function TimelineBody({ featureId, store }: { readonly featureId: string; readonly store: Store }): React.ReactNode {
  const state = useTimeline(store, featureId)
  return <TimelinePanel entries={state.data ?? undefined} />
}

function FindingsBody({ featureId, store }: { readonly featureId: string; readonly store: Store }): React.ReactNode {
  const state = useFindings(store, featureId)
  return <FindingsPanel findings={state.data ?? undefined} />
}
