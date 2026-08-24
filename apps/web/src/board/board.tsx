import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "wouter"
import { useApp } from "../app-context.ts"
import { useFeatures, useHealth, useWorkflow, useWorkflowNames } from "../api/hooks.ts"
import { useStartWork } from "../start-work/start-work-context.ts"
import {
  deriveOverview,
  deriveWorkflowBoard,
  deriveWorkflowScopes,
  pickStableDefaultScopeKey,
  scopeMatchesWorkflow,
  type RegisteredProject,
  type WorkflowBoardModel,
} from "./workflow-board.ts"
import { describeBoardMovements, diffBoardMovements } from "./board-activity.ts"
import { OverviewStrip } from "./overview-strip.tsx"
import { ScopeTabs } from "./scope-tabs.tsx"
import { JobColumn } from "./job-column.tsx"
import { JobFrontierCard } from "./job-frontier-card.tsx"
import { StageSelector, type StageOption } from "./stage-selector.tsx"
import { useIsNarrowViewport } from "../lib/viewport.ts"
import { statusGlyph, type BoardCardModel } from "./card-model.ts"
import { publishActiveScope } from "../plugins/active-scope.ts"
import styles from "./board.module.css"

export function Board(): React.ReactNode {
  const { store } = useApp()
  const featuresState = useFeatures(store)
  const startWork = useStartWork()
  const [params, setParams] = useSearchParams()
  const [now, setNow] = useState<number>(() => Date.now())
  const isNarrow = useIsNarrowViewport()
  const [mobileStage, setMobileStage] = useState<string | null>(null)

  useEffect(() => {
    const id = globalThis.setInterval(() => setNow(Date.now()), 30_000)
    return () => globalThis.clearInterval(id)
  }, [])

  useEffect(() => {
    store.setActiveFeature(null)
  }, [store])

  const healthState = useHealth(store)
  const registeredProjectDirs = useMemo(
    () => (healthState.data?.projects ?? []).map(p => p.projectDir),
    [healthState.data],
  )
  const workflowNames = useWorkflowNames(store, registeredProjectDirs)
  const registeredProjects: readonly RegisteredProject[] = useMemo(
    () => registeredProjectDirs.map(projectDir => ({ projectDir, workflowName: workflowNames[projectDir] ?? null })),
    [registeredProjectDirs, workflowNames],
  )

  const items = featuresState.data
  const scopes = useMemo(
    () => (items === null ? [] : deriveWorkflowScopes(items, registeredProjects)),
    [items, registeredProjects],
  )
  const overview = useMemo(() => (items === null ? null : deriveOverview(items, now)), [items, now])

  const requestedScope = params.get("scope")
  // Stabilized against SSE reordering: `deriveWorkflowScopes` sorts by
  // `activeCount`, which shifts on every feature-list refetch. Freeze
  // onto the URL-requested scope when present and valid; otherwise keep
  // whichever scope was already selected as long as it still exists, and
  // only fall back to "busiest" when there is truly nothing to freeze
  // onto (first load, or the frozen scope's last feature completed).
  //
  // `scopeMemory` is state, not a ref written during render: writing
  // `ref.current` in the render body is unsafe (React explicitly
  // disallows it — StrictMode's double-invocation can observe the first
  // pass's write during the second, discarded pass and compute a
  // different result). The "call setState conditionally during render"
  // pattern below is the React-sanctioned way to derive state from
  // previous render output; React re-renders immediately with the new
  // state before committing, so it never flashes a wrong scope.
  const [scopeMemory, setScopeMemory] = useState<string | null>(null)
  const selectedScope = useMemo(() => {
    if (requestedScope !== null && scopes.some(s => s.key === requestedScope)) return requestedScope
    return pickStableDefaultScopeKey(scopeMemory, scopes)
  }, [requestedScope, scopes, scopeMemory])
  if (selectedScope !== scopeMemory) setScopeMemory(selectedScope)

  const scope = scopes.find(s => s.key === selectedScope) ?? null

  useEffect(() => {
    publishActiveScope({ project: scope?.projectDir ?? null, feature: null })
  }, [scope])

  const workflowState = useWorkflow(store, scope?.projectDir ?? "")
  const workflowRes = workflowState.data
  const workflowMismatch = scope !== null && workflowRes !== null && workflowRes.ok && !scopeMatchesWorkflow(scope, workflowRes.workflow)

  const board = useMemo(() => {
    if (items === null || scope === null || workflowRes === null || !workflowRes.ok) return null
    if (!scopeMatchesWorkflow(scope, workflowRes.workflow)) return null
    return deriveWorkflowBoard(items, workflowRes.workflow, scope, now)
  }, [items, scope, workflowRes, now])

  // Live-region announcement + best-effort focus recovery when the
  // board's own re-derivation moves cards between job columns (spec:
  // "Live movement between job columns SHALL preserve useful focus and
  // SHALL be announced"). Keyed by scope so switching scopes never
  // diffs against a different workflow's columns.
  //
  // Focus is tracked continuously through a `focusin` listener rather
  // than read from `document.activeElement` inside the diff effect: by
  // the time that effect runs, React has already committed the new DOM,
  // the old card's element may already be unmounted, and the browser
  // resets `document.activeElement` to `<body>` the instant a focused
  // element is removed — reading it after the fact would always see the
  // reset, never the card that was actually focused a moment ago.
  const boardRootRef = useRef<HTMLDivElement>(null)
  const lastFocusedCardIdRef = useRef<string | null>(null)
  useEffect(() => {
    const root = boardRootRef.current
    if (root === null) return
    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null
      lastFocusedCardIdRef.current = target?.closest<HTMLElement>("[data-card-id]")?.dataset.cardId ?? null
    }
    root.addEventListener("focusin", onFocusIn)
    return () => root.removeEventListener("focusin", onFocusIn)
  }, [])

  const prevBoardRef = useRef<{ scopeKey: string; board: WorkflowBoardModel } | null>(null)
  const [announcement, setAnnouncement] = useState<string | null>(null)
  useEffect(() => {
    if (board === null || selectedScope === null) return
    const prev = prevBoardRef.current
    if (prev !== null && prev.scopeKey === selectedScope) {
      const movements = diffBoardMovements(prev.board, board)
      const text = describeBoardMovements(movements)
      if (text !== null) setAnnouncement(text)
      const focusedCardId = lastFocusedCardIdRef.current
      if (focusedCardId !== null) {
        const moved = movements.find(m => focusedCardId.startsWith(`${m.featureId}::`))
        if (moved !== undefined && moved.kind !== "left" && moved.toJobIds.length > 0) {
          // The focused card moved rather than disappearing: restore
          // focus to its new instance (first column if now parallel).
          // The card's focusable element is the inner `<a>`; the outer
          // div only carries the identity attribute, so the anchor is
          // targeted specifically rather than falling back to an
          // unfocusable container.
          const nextCardId = `${moved.featureId}::${moved.toJobIds[0]}`
          const container = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(nextCardId)}"]`)
          const focusTarget = container?.querySelector<HTMLElement>("a") ?? container
          focusTarget?.focus()
        }
      }
    }
    prevBoardRef.current = { scopeKey: selectedScope, board }
  }, [board, selectedScope])

  const selectScope = (key: string): void => {
    setParams(prev => {
      const next = new URLSearchParams(prev)
      next.set("scope", key)
      return next
    })
    setMobileStage(null)
    prevBoardRef.current = null
  }

  const stageOptions: readonly StageOption[] = useMemo(
    () =>
      (board?.columns ?? []).map(col => ({
        jobId: col.jobId,
        count: col.cards.length,
        hasAttention: col.cards.some(c => c.status === "waiting_human" || c.status === "escalated"),
      })),
    [board],
  )

  useEffect(() => {
    if (mobileStage !== null && stageOptions.some(s => s.jobId === mobileStage)) return
    const firstWithAttention = stageOptions.find(s => s.hasAttention)
    const firstWithCards = stageOptions.find(s => s.count > 0)
    setMobileStage((firstWithAttention ?? firstWithCards ?? stageOptions[0])?.jobId ?? null)
    // mobileStage intentionally excluded: this effect only picks a
    // *default* when the current selection becomes invalid, and must not
    // re-run every time the operator changes it by hand.
  }, [stageOptions])

  // Health readiness gates the empty state too: `scopes` now derives
  // from registered projects, so if /v1/features resolves before
  // /v1/health the board would flash "no active features" for a daemon
  // that does have a registered (feature-less) project — the exact
  // absent-scope flash this change eliminates.
  const loading = featuresState.status === "loading" || items === null || (healthState.status === "loading" && healthState.data === null)
  const activeStageCol = board?.columns.find(c => c.jobId === mobileStage) ?? null

  return (
    <div className={styles.board} ref={boardRootRef}>
      <div aria-live="polite" className="visually-hidden">
        {announcement ?? ""}
      </div>
      {overview !== null ? <OverviewStrip overview={overview} /> : null}
      {loading ? (
        <div className={styles.loading}>loading features…</div>
      ) : featuresState.status === "error" ? (
        <div className={styles.error}>could not load features: {featuresState.error?.message}</div>
      ) : scopes.length === 0 ? (
        <div className={styles.empty}>
          <p>no active features.</p>
          <button type="button" className="primary" onClick={startWork}>
            + start work
          </button>
        </div>
      ) : (
        <>
          <ScopeTabs scopes={scopes} selectedKey={selectedScope ?? ""} onSelect={selectScope} />
          {workflowState.status === "loading" || workflowRes === null ? (
            <div className={styles.diagCard}>loading workflow…</div>
          ) : !workflowRes.ok ? (
            <div className={styles.diagCard}>
              {workflowRes.state === "unregistered" ? "no workflow registered for this project" : `workflow invalid: ${workflowRes.message}`}
            </div>
          ) : workflowMismatch ? (
            <div className={styles.diagCard}>
              ⚠ this project's registered workflow is now "{workflowRes.workflow.name}", not "{scope?.workflow}" —
              showing a historical/stale projection is unsafe, so this scope's board is unavailable until you select a
              current scope
            </div>
          ) : board === null ? null : isNarrow ? (
            <div className={styles.mobileBoard}>
              <StageSelector stages={stageOptions} selected={mobileStage} onSelect={setMobileStage} />
              <div className={styles.mobileCards}>
                {activeStageCol === null || activeStageCol.cards.length === 0 ? (
                  <div className={styles.empty}>nothing at this stage</div>
                ) : (
                  activeStageCol.cards.map(card => <JobFrontierCard key={card.cardId} card={card} />)
                )}
              </div>
              <UnresolvedTray unresolved={board.unresolved} />
            </div>
          ) : (
            <>
              <div className={styles.columns}>
                {board.columns.map(column => (
                  <JobColumn key={column.jobId} column={column} />
                ))}
              </div>
              <UnresolvedTray unresolved={board.unresolved} />
            </>
          )}
        </>
      )}
    </div>
  )
}

function UnresolvedTray({ unresolved }: { readonly unresolved: readonly BoardCardModel[] }): React.ReactNode {
  if (unresolved.length === 0) return null
  return (
    <div className={styles.unresolved}>
      <div className={styles.unresolvedHead}>⚠ unresolved frontier ({unresolved.length})</div>
      <div className={styles.unresolvedList}>
        {unresolved.map(card => (
          <div key={card.id} className={styles.unresolvedRow}>
            <span aria-hidden="true">{statusGlyph(card.status)}</span>
            {card.title} — {card.project} · {card.workflow}
          </div>
        ))}
      </div>
    </div>
  )
}
