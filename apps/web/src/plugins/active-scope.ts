/**
 * Active-scope publisher — the plugin rail's inputs for visibility
 * filtering and bridge context. Project-scoped plugin visibility and the
 * bridge's `selection` both follow "whatever the operator is currently
 * looking at", which spans two routes (`Board`'s selected workflow
 * scope, `FeatureView`'s loaded feature) that never mount together.
 * Rather than lifting board/feature-view state into the shell, each
 * route publishes its own scope into this tiny external store; the
 * shell-level plugin rail is the only subscriber.
 */

import { useSyncExternalStore } from "react"

export interface ActiveScope {
  readonly project: string | null
  readonly feature: string | null
}

const NONE: ActiveScope = { project: null, feature: null }

let current: ActiveScope = NONE
const listeners = new Set<() => void>()

export function publishActiveScope(scope: ActiveScope): void {
  if (current.project === scope.project && current.feature === scope.feature) return
  current = scope
  for (const listener of [...listeners]) listener()
}

export function getActiveScope(): ActiveScope {
  return current
}

export function subscribeActiveScope(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useActiveScope(): ActiveScope {
  return useSyncExternalStore(subscribeActiveScope, getActiveScope, getActiveScope)
}
