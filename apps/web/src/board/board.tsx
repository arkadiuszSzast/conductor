import { useEffect, useMemo, useState } from "react"
import { useApp } from "../app-context.ts"
import { useFeatures } from "../api/hooks.ts"
import { groupIntoZones, type ColumnZone } from "./card-model.ts"
import { BoardCard } from "./board-card.tsx"
import { GraphStrip } from "./graph-strip.tsx"
import styles from "./board.module.css"

const ZONE_META: Record<ColumnZone, { title: string }> = {
  "needs-you": { title: "NEEDS YOU" },
  running: { title: "RUNNING" },
  paused: { title: "PAUSED" },
  terminal: { title: "DONE" },
}

export function Board(): React.ReactNode {
  const { store } = useApp()
  const featuresState = useFeatures(store)
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    const id = globalThis.setInterval(() => setNow(Date.now()), 30_000)
    return () => globalThis.clearInterval(id)
  }, [])

  useEffect(() => {
    store.setActiveFeature(selected)
  }, [store, selected])

  const items = featuresState.data
  const zones = useMemo(() => (items === null ? null : groupIntoZones(items, now)), [items, now])

  return (
    <div className={styles.board}>
      {featuresState.status === "loading" || zones === null ? (
        <div className={styles.loading}>loading features…</div>
      ) : featuresState.status === "error" ? (
        <div className={styles.error}>
          could not load features: {featuresState.error?.message}
        </div>
      ) : (
        <div className={styles.columns}>
          {(Object.keys(ZONE_META) as ColumnZone[]).map(zone => {
            const models = zones[zone]
            const meta = ZONE_META[zone]
            if (zone === "terminal" && models.length === 0) return null
            return (
              <div key={zone} className={styles.column}>
                <div className={`${styles.columnHead} ${zone === "needs-you" ? styles.attention : ""} ${zone === "terminal" ? styles.terminalHead : ""}`}>
                  {zone === "needs-you" ? <span className={styles.pulse} /> : null}
                  {meta.title}
                  <span className={styles.count}>({models.length})</span>
                </div>
                <div className={styles.cards}>
                  {models.map(card => (
                    <BoardCard key={card.id} card={card} selected={selected === card.id} onSelect={setSelected} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {selected !== null ? (
        <div className={styles.stripWrap}>
          <GraphStrip featureId={selected} onClose={() => setSelected(null)} />
        </div>
      ) : null}
    </div>
  )
}
