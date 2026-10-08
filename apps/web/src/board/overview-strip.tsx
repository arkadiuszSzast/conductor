/**
 * Compact cross-workflow "Now" strip — urgent human gates/escalations,
 * paused work, and recent terminal history, all independent of which
 * per-scope job columns are currently visible. Keeps triage possible
 * without mixing incompatible workflow job sets into one board.
 *
 * Recent history shows a capped preview by default (two entries on a
 * phone, where vertical space is scarce); every terminal feature remains
 * reachable through "show all", which opens a bounded, scrollable list
 * rather than growing the strip without limit (`recentAll` carries the
 * complete collection — see `deriveOverview`).
 */

import { useState } from "react"
import { Link } from "wouter"
import { RECENT_PREVIEW_LIMIT, type OverviewModel } from "./workflow-board.ts"
import { useIsNarrowViewport } from "../lib/viewport.ts"
import { statusGlyph, type BoardCardModel } from "./card-model.ts"
import styles from "./overview-strip.module.css"

export interface OverviewStripProps {
  readonly overview: OverviewModel
}

export const RECENT_PREVIEW_LIMIT_NARROW = 2

export function OverviewStrip({ overview }: OverviewStripProps): React.ReactNode {
  const [showAllRecent, setShowAllRecent] = useState(false)
  const isNarrow = useIsNarrowViewport()
  const hasAny = overview.urgent.length > 0 || overview.paused.length > 0 || overview.recentAll.length > 0
  if (!hasAny) return null
  const previewLimit = isNarrow ? RECENT_PREVIEW_LIMIT_NARROW : RECENT_PREVIEW_LIMIT
  const hiddenCount = Math.max(0, overview.recentAll.length - previewLimit)
  const recentShown = showAllRecent ? overview.recentAll : overview.recentAll.slice(0, previewLimit)

  return (
    <section className={styles.strip} aria-label="Cross-workflow overview">
      {overview.urgent.length > 0 ? (
        <div className={styles.group}>
          <div className={`${styles.groupHead} ${styles.urgentHead}`}>
            <span className={styles.pulse} aria-hidden="true" />
            NEEDS YOU
            <span className={styles.count}>({overview.urgent.length})</span>
          </div>
          <div className={styles.chips}>
            {overview.urgent.map(card => (
              <OverviewChip key={card.id} card={card} tone="urgent" />
            ))}
          </div>
        </div>
      ) : null}
      {overview.paused.length > 0 ? (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            PAUSED
            <span className={styles.count}>({overview.paused.length})</span>
          </div>
          <div className={styles.chips}>
            {overview.paused.map(card => (
              <OverviewChip key={card.id} card={card} tone="paused" />
            ))}
          </div>
        </div>
      ) : null}
      {overview.recentAll.length > 0 ? (
        <div className={`${styles.group} ${styles.recentGroup}`}>
          <div className={styles.groupHead}>
            RECENT
            <span className={styles.count}>({overview.recentAll.length})</span>
          </div>
          <div className={`${styles.chips} ${showAllRecent ? styles.expanded : ""}`}>
            {recentShown.map(card => (
              <OverviewChip key={card.id} card={card} tone="recent" />
            ))}
          </div>
          {hiddenCount > 0 ? (
            <button type="button" className={styles.showAll} aria-expanded={showAllRecent} onClick={() => setShowAllRecent(v => !v)}>
              {showAllRecent ? "show fewer" : `show all ${overview.recentAll.length} →`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function OverviewChip({ card, tone }: { readonly card: BoardCardModel; readonly tone: "urgent" | "paused" | "recent" }): React.ReactNode {
  return (
    <Link href={`/feature/${card.id}`} className={`${styles.chip} ${styles[tone]} tap-target`}>
      <span aria-hidden="true">{statusGlyph(card.status)}</span>
      <span className={styles.chipTitle}>{card.title}</span>
      <span className={styles.chipMeta}>
        <span className={styles.chipProject}>{card.project} · </span>
        {card.age}
      </span>
    </Link>
  )
}
