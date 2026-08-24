/**
 * Plugin rail state — combines the plugin listing (scoped to the active
 * project), visibility filtering, and persisted tab/open state into what
 * `PluginRail` needs to render. Kept out of the component so visibility
 * and selection-repair logic are directly testable without mounting.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useApp } from "../app-context.ts"
import { usePlugins } from "../api/hooks.ts"
import { useActiveScope } from "./active-scope.ts"
import { visiblePlugins } from "./visibility.ts"
import { localStorageRailStorage, type RailStorage } from "./rail-storage.ts"
import type { PluginListingItem, PluginListingResponse } from "../api/types.ts"

export interface PluginRailState {
  readonly visible: readonly PluginListingItem[]
  readonly open: boolean
  readonly selected: PluginListingItem | null
  readonly setOpen: (open: boolean) => void
  readonly select: (id: string) => void
  readonly activeProject: string | null
  readonly activeFeature: string | null
  readonly refetch: () => void
}

export function usePluginRail(storage: RailStorage = localStorageRailStorage()): PluginRailState {
  const { store } = useApp()
  // The board always publishes a scope while at least one project is
  // registered (registry-derived scopes, not feature-derived — see
  // `workflow-board.ts`'s `deriveWorkflowScopes`), so the rail follows it
  // directly with no fallback of its own.
  const { project: activeProject, feature: activeFeature } = useActiveScope()
  const pluginsState = usePlugins(store, activeProject ?? "")
  // A scope switch starts a fresh `loading` resource for the new key
  // (`store.ts`'s `EMPTY_RESOURCE`) even when a global plugin's tab
  // should stay put across the switch — fall back to the last listing
  // this rail actually saw so an open global-plugin panel doesn't flash
  // closed while the new scope's request is in flight.
  const lastListingRef = useRef<PluginListingResponse | null>(null)
  if (pluginsState.data !== null) lastListingRef.current = pluginsState.data
  const listing = pluginsState.data ?? lastListingRef.current

  const visible = useMemo(() => {
    if (listing === null || !listing.enabled) return []
    return visiblePlugins(listing.plugins, activeProject)
  }, [listing, activeProject])

  const [persisted] = useState(() => storage.get())
  const [open, setOpenState] = useState(persisted?.open ?? false)
  const [selectedId, setSelectedId] = useState<string | null>(persisted?.selectedId ?? null)

  useEffect(() => {
    storage.set({ open, selectedId })
    // storage is a stable factory-produced object per mount; excluding it
    // keeps this effect from re-persisting on every render when a caller
    // passes a fresh instance without memoizing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedId])

  useEffect(() => {
    if (selectedId !== null && visible.some(p => p.id === selectedId)) return
    setSelectedId(visible[0]?.id ?? null)
    // Only re-picks a default when the current selection is no longer
    // visible (scope changed, plugin disappeared) — must not run on every
    // `visible` identity change while the current selection still holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const selected = visible.find(p => p.id === selectedId) ?? null

  return {
    visible,
    open: open && visible.length > 0,
    selected,
    setOpen: setOpenState,
    select: id => {
      setSelectedId(id)
      setOpenState(true)
    },
    activeProject,
    activeFeature,
    refetch: () => {
      store.refetchPlugins(activeProject ?? "")
    },
  }
}
