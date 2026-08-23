/**
 * Right-side plugin panel rail — collapsible, absent entirely when the
 * scope has no visible plugins or the subsystem is disabled
 * (plugin-panels spec: "No plugins, no rail"). Narrow viewports present
 * the open panel as an `ActionSheet` overlay instead of an inline aside
 * (web-ui spec: "Narrow viewport uses an overlay") so it never displaces
 * the board/gate flow.
 */

import { useLocation } from "wouter"
import { usePluginRail } from "./use-plugin-rail.ts"
import { PluginPanel } from "./panel.tsx"
import { ActionSheet } from "../ui/action-sheet.tsx"
import { useIsNarrowViewport } from "../lib/viewport.ts"
import type { BridgeContextPayload } from "./bridge.ts"
import styles from "./plugin-rail.module.css"

export function PluginRail(): React.ReactNode {
  const rail = usePluginRail()
  const [, navigate] = useLocation()
  const isNarrow = useIsNarrowViewport()

  if (rail.visible.length === 0) return null

  const context: BridgeContextPayload = {
    project: rail.activeProject,
    selection: { feature: rail.activeFeature },
    theme: { mode: "dark" },
  }
  const onNavigateToFeature = (featureId: string): void => navigate(`/feature/${featureId}`)

  const tabs = (
    <div className={styles.tabs} role="tablist" aria-label="Plugins" aria-orientation="vertical">
      {rail.visible.map(plugin => {
        const selected = rail.open && plugin.id === rail.selected?.id
        return (
          <button
            key={plugin.id}
            type="button"
            role="tab"
            aria-selected={selected}
            title={plugin.panel.title}
            className={`${styles.tab} ${selected ? styles.tabSelected : ""}`}
            onClick={() => {
              if (selected) rail.setOpen(false)
              else rail.select(plugin.id)
            }}
          >
            <span aria-hidden="true">{plugin.panel.icon ?? plugin.panel.title.charAt(0).toUpperCase()}</span>
            <span className="visually-hidden">{plugin.panel.title}</span>
          </button>
        )
      })}
    </div>
  )

  if (isNarrow) {
    return (
      <>
        <div className={styles.narrowTabs}>{tabs}</div>
        {rail.open && rail.selected !== null ? (
          <ActionSheet title={rail.selected.panel.title} onClose={() => rail.setOpen(false)}>
            <div className={styles.sheetBody}>
              <PluginPanel
                plugin={rail.selected}
                context={context}
                onNavigateToFeature={onNavigateToFeature}
                onRetry={rail.refetch}
              />
            </div>
          </ActionSheet>
        ) : null}
      </>
    )
  }

  return (
    <div className={`${styles.rail} ${rail.open ? styles.railOpen : ""}`}>
      {tabs}
      {rail.open && rail.selected !== null ? (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>{rail.selected.panel.title}</span>
            <button type="button" className={styles.closeBtn} onClick={() => rail.setOpen(false)} aria-label="Close panel">
              ✕
            </button>
          </div>
          <div className={styles.panelBody}>
            <PluginPanel
              plugin={rail.selected}
              context={context}
              onNavigateToFeature={onNavigateToFeature}
              onRetry={rail.refetch}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
