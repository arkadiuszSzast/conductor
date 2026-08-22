/**
 * Compact cross-workflow "Now" strip — urgent human gates/escalations,
 * paused work, and recent terminal history, all independent of which
 * per-scope job columns are currently visible. Keeps triage possible
 * without mixing incompatible workflow job sets into one board.
 *
 * Recent history shows a capped preview by default; every terminal
 * feature remains reachable through "show all" rather than being made
 * permanently inaccessible past the preview cap (`recentAll` carries the
 * complete collection — see `deriveOverview`).
 */

import { useState } from "react"
import { Link } from "wouter"
import type { OverviewModel } from "./workflow-board.ts"
import { statusGlyph, type BoardCardModel } from "./card-model.ts"
import styles from "./overview-strip.module.css"

export interface OverviewStripProps {
  readonly overview: OverviewModel
}

export function OverviewStrip({ overview }: OverviewStripProps): React.ReactNode {
  const [showAllRecent, setShowAllRecent] = useState(false)
  const hasAny = overview.urgent.length > 0 || overview.paused.length > 0 || overview.recentAll.length > 0
  if (!hasAny) return null
  const hiddenCount = overview.recentAll.length - overview.recent.length
  const recentShown = showAllRecent ? overview.recentAll : overview.recent

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
        <div className={styles.group}>
          <div className={styles.groupHead}>
            RECENT
            <span className={styles.count}>({overview.recentAll.length})</span>
          </div>
          <div className={styles.chips}>
            {recentShown.map(card => (
              <OverviewChip key={card.id} card={card} tone="recent" />
            ))}
          </div>
          {hiddenCount > 0 ? (
            <button type="button" className={styles.showAll} onClick={() => setShowAllRecent(v => !v)}>
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
        {card.project} · {card.age}
      </span>
    </Link>
  )
}
