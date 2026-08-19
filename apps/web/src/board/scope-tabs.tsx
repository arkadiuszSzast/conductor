/**
 * Workflow-scope switcher — one tab per project+workflow pairing so
 * incompatible job sets are never mixed into a single set of columns
 * (spec: "Incompatible workflows are not mixed").
 */

import type { WorkflowScopeSummary } from "./workflow-board.ts"
import styles from "./scope-tabs.module.css"

export interface ScopeTabsProps {
  readonly scopes: readonly WorkflowScopeSummary[]
  readonly selectedKey: string
  readonly onSelect: (key: string) => void
}

export function ScopeTabs({ scopes, selectedKey, onSelect }: ScopeTabsProps): React.ReactNode {
  if (scopes.length <= 1) return null
  return (
    <div className={styles.tabs} role="group" aria-label="Workflow scope">
      {scopes.map(scope => {
        const selected = scope.key === selectedKey
        return (
          <button
            key={scope.key}
            type="button"
            aria-pressed={selected}
            className={`${styles.tab} ${selected ? styles.selected : ""}`}
            onClick={() => onSelect(scope.key)}
          >
            <span className={styles.project}>{scope.projectLabel}</span>
            <span className={styles.workflow}>{scope.workflow}</span>
            {scope.activeCount > 0 ? <span className={styles.badge}>{scope.activeCount}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
