/**
 * "Latest call wins" guard — pure, no DOM/timers.
 *
 * Async selection state (a run's full outputs, a run's log tail) races
 * itself whenever the operator changes selection faster than a request
 * resolves, or two overlapping requests for the same selection settle out
 * of order. `begin()` issues a ticket for a new attempt; `isCurrent(id)`
 * reports whether that ticket is still the most recently issued one.
 * Callers apply a response only when `isCurrent` still holds — an
 * in-flight request superseded by a newer `begin()` (new selection, or a
 * fresher retry of the same selection) is discarded rather than clobbering
 * state a later response already set.
 */
export class LatestGuard {
  private current = 0

  /** Issue a new ticket, invalidating every previously issued one. */
  begin(): number {
    this.current += 1
    return this.current
  }

  /** Invalidate any in-flight ticket without issuing a new one — used
   *  when a selection resets to a state with nothing to fetch. */
  invalidate(): void {
    this.current += 1
  }

  /** Whether `id` is still the most recently issued ticket. */
  isCurrent(id: number): boolean {
    return id === this.current
  }
}
