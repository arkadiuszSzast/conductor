/**
 * `LatestGuard` — "latest call wins" ticketing for async selection state.
 */
import { describe, expect, it } from "bun:test"
import { LatestGuard } from "../src/lib/latest-guard.ts"

describe("LatestGuard", () => {
  it("the first ticket is current until a newer one is issued", () => {
    const guard = new LatestGuard()
    const t1 = guard.begin()
    expect(guard.isCurrent(t1)).toBe(true)
  })

  it("issuing a new ticket invalidates the previous one", () => {
    const guard = new LatestGuard()
    const t1 = guard.begin()
    const t2 = guard.begin()
    expect(guard.isCurrent(t1)).toBe(false)
    expect(guard.isCurrent(t2)).toBe(true)
  })

  it("invalidate() discards the in-flight ticket without issuing a new one", () => {
    const guard = new LatestGuard()
    const t1 = guard.begin()
    guard.invalidate()
    expect(guard.isCurrent(t1)).toBe(false)
    // a fresh ticket issued afterward is still current
    const t2 = guard.begin()
    expect(guard.isCurrent(t2)).toBe(true)
  })

  it("simulates out-of-order async resolution: only the latest ticket applies", () => {
    const guard = new LatestGuard()
    const applied: string[] = []
    const attempt = (id: number, label: string): void => {
      if (guard.isCurrent(id)) applied.push(label)
    }
    const first = guard.begin() // selection A
    const second = guard.begin() // selection B, supersedes A
    // A's slow response resolves after B's fast one
    attempt(second, "B")
    attempt(first, "A")
    expect(applied).toEqual(["B"])
  })
})
