import type { Store } from "./store.ts"

/** Returns the id of the feature created for `change` at/after `claimedAt`, or null when none exists. */
export type FindStartedFeature = (projectDir: string, change: string, claimedAt: number) => string | null

export interface ReconcileStartingResult {
  readonly linked: ReadonlyArray<{ readonly entryId: string; readonly featureId: string }>
  readonly released: readonly string[]
}

/**
 * Restart recovery for the exactly-once start protocol (design D4): a
 * `starting` entry is a claim whose feature creation or link may not have
 * completed. If a feature for the change exists from after the claim, link
 * it (never creating a second one); otherwise release the claim so the next
 * scheduler pass can start the change.
 */
export function reconcileStartingEntries(
  store: Store,
  findFeature: FindStartedFeature = (projectDir, change, claimedAt) => store.findFeatureCreatedForChange(projectDir, change, claimedAt),
): ReconcileStartingResult {
  const linked: Array<{ entryId: string; featureId: string }> = []
  const released: string[] = []
  for (const entry of store.listStartingEntries()) {
    if (entry.claimToken === null || entry.claimedAt === null) continue
    const featureId = findFeature(entry.projectDir, entry.change, entry.claimedAt)
    if (featureId !== null) {
      if (store.linkEntry(entry.id, entry.claimToken, featureId)) linked.push({ entryId: entry.id, featureId })
    } else if (store.releaseClaim(entry.id, entry.claimToken)) {
      released.push(entry.id)
    }
  }
  return { linked, released }
}
